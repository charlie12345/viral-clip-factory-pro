#!/usr/bin/env python3
"""Portable transcription providers with one dependency-free result contract.

The module intentionally does not import Whisper, Torch, or an HTTP client
package.  Callers supply an already-loaded OpenAI Whisper model when they want
that backend, while whisper.cpp and Deepgram are invoked using the standard
library.

Every successful public transcription function returns at least::

    {
        "segments": [{
            "start": float,
            "end": float,
            "text": str,
            "words": [{"word": str, "start": float, "end": float}],
            "confidence": float | None,
        }],
        "language": str | None,
        "provider": str,
        "model": str,
        "topics": list,
    }

Provider-specific enrichments such as sentiment and speaker labels are retained
as optional fields without changing the required contract above.
"""

from __future__ import annotations

import json
import math
import mimetypes
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable, Mapping, Sequence
from pathlib import Path
from typing import Any


DEFAULT_DEEPGRAM_ENDPOINT = "https://api.deepgram.com/v1/listen"
DEFAULT_WHISPER_CPP_EXECUTABLE = "whisper-cli"
DEFAULT_WHISPER_CPP_LANGUAGE = "auto"
SUPPORTED_PROVIDERS = ("auto", "openai_whisper", "whisper_cpp", "deepgram")
WHISPER_CPP_PATH_ENV = "VCF_WHISPER_CPP_PATH"
WHISPER_CPP_MODEL_ENV = "VCF_WHISPER_CPP_MODEL"
WHISPER_CPP_LANGUAGE_ENV = "VCF_WHISPER_CPP_LANGUAGE"
WHISPER_CPP_VAD_MODEL_ENV = "VCF_WHISPER_CPP_VAD_MODEL"
DEEPGRAM_API_KEY_ENV = "DEEPGRAM_API_KEY"

_WHISPER_CPP_VAD_OPTIONS = (
    (
        "threshold",
        "--vad-threshold",
        "VCF_WHISPER_CPP_VAD_THRESHOLD",
        float,
        0.0,
        1.0,
    ),
    (
        "min_speech_duration_ms",
        "--vad-min-speech-duration-ms",
        "VCF_WHISPER_CPP_VAD_MIN_SPEECH_DURATION_MS",
        int,
        0,
        None,
    ),
    (
        "min_silence_duration_ms",
        "--vad-min-silence-duration-ms",
        "VCF_WHISPER_CPP_VAD_MIN_SILENCE_DURATION_MS",
        int,
        0,
        None,
    ),
    (
        "max_speech_duration_s",
        "--vad-max-speech-duration-s",
        "VCF_WHISPER_CPP_VAD_MAX_SPEECH_DURATION_S",
        float,
        0.001,
        None,
    ),
    (
        "speech_pad_ms",
        "--vad-speech-pad-ms",
        "VCF_WHISPER_CPP_VAD_SPEECH_PAD_MS",
        int,
        0,
        None,
    ),
    (
        "samples_overlap",
        "--vad-samples-overlap",
        "VCF_WHISPER_CPP_VAD_SAMPLES_OVERLAP",
        float,
        0.0,
        None,
    ),
)


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _time(value: Any, default: float = 0.0) -> float:
    number = _finite_float(value)
    if number is None:
        number = default
    return round(max(0.0, number), 6)


def _confidence(value: Any) -> float | None:
    number = _finite_float(value)
    if number is None:
        return None
    return round(min(1.0, max(0.0, number)), 6)


def _mean_confidence(items: Iterable[Mapping[str, Any]]) -> float | None:
    values = [
        value
        for item in items
        if (value := _confidence(
            item.get("confidence", item.get("probability", item.get("p")))
        )) is not None
    ]
    if not values:
        return None
    return round(sum(values) / len(values), 6)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _requested_whisper_cpp_language(value: Any = None) -> str:
    """Return a concrete whisper.cpp language request with auto as the default."""
    requested = _text(value) or _text(os.environ.get(WHISPER_CPP_LANGUAGE_ENV))
    requested = requested or DEFAULT_WHISPER_CPP_LANGUAGE
    return DEFAULT_WHISPER_CPP_LANGUAGE if requested.lower() == "auto" else requested


def _empty_result(provider: str, model: str, language: str | None) -> dict[str, Any]:
    return {
        "segments": [],
        "language": language,
        "provider": provider,
        "model": model,
        "topics": [],
    }


def _normalize_word(
    raw_word: Mapping[str, Any],
    *,
    default_start: float,
    default_end: float,
) -> dict[str, Any] | None:
    word = _text(
        raw_word.get(
            "word",
            raw_word.get("punctuated_word", raw_word.get("text", raw_word.get("token"))),
        )
    )
    if not word or (word.startswith("[") and word.endswith("]")):
        return None
    start = _time(raw_word.get("start"), default_start)
    end = max(start, _time(raw_word.get("end"), default_end))
    normalized: dict[str, Any] = {"word": word, "start": start, "end": end}
    confidence = _confidence(
        raw_word.get("confidence", raw_word.get("probability", raw_word.get("p")))
    )
    if confidence is not None:
        normalized["confidence"] = confidence
    if raw_word.get("speaker") is not None:
        normalized["speaker"] = raw_word["speaker"]
    speaker_confidence = _confidence(raw_word.get("speaker_confidence"))
    if speaker_confidence is not None:
        normalized["speaker_confidence"] = speaker_confidence
    return normalized


def _segment_confidence(raw_segment: Mapping[str, Any], words: Sequence[Mapping[str, Any]]) -> float | None:
    direct = _confidence(
        raw_segment.get(
            "confidence",
            raw_segment.get("probability", raw_segment.get("p")),
        )
    )
    if direct is not None:
        return direct
    word_mean = _mean_confidence(words)
    if word_mean is not None:
        return word_mean
    avg_logprob = _finite_float(raw_segment.get("avg_logprob"))
    if avg_logprob is not None:
        return _confidence(math.exp(avg_logprob))
    return None


def normalize_openai_whisper_result(
    payload: Mapping[str, Any],
    *,
    model: str = "whisper",
    provider: str = "openai_whisper",
    language: str | None = None,
) -> dict[str, Any]:
    """Normalize output from the reference ``openai-whisper`` package."""
    if not isinstance(payload, Mapping):
        raise TypeError("OpenAI Whisper returned a non-object result")

    result = _empty_result(provider, model, _text(payload.get("language")) or language)
    raw_segments = payload.get("segments")
    if not isinstance(raw_segments, Sequence) or isinstance(raw_segments, (str, bytes)):
        raw_segments = []

    for raw in raw_segments:
        if not isinstance(raw, Mapping):
            continue
        start = _time(raw.get("start"))
        end = max(start, _time(raw.get("end"), start))
        raw_words = raw.get("words")
        if not isinstance(raw_words, Sequence) or isinstance(raw_words, (str, bytes)):
            raw_words = []
        words = [
            word
            for item in raw_words
            if isinstance(item, Mapping)
            and (word := _normalize_word(item, default_start=start, default_end=end)) is not None
        ]
        segment: dict[str, Any] = {
            "start": start,
            "end": end,
            "text": _text(raw.get("text")) or " ".join(word["word"] for word in words),
            "words": words,
            "confidence": _segment_confidence(raw, words),
        }
        result["segments"].append(segment)

    # Some wrappers expose only a transcript and top-level words. Preserve it
    # rather than returning an apparently successful empty transcription.
    if not result["segments"] and _text(payload.get("text")):
        raw_words = payload.get("words")
        if not isinstance(raw_words, Sequence) or isinstance(raw_words, (str, bytes)):
            raw_words = []
        words = [
            word
            for item in raw_words
            if isinstance(item, Mapping)
            and (word := _normalize_word(item, default_start=0.0, default_end=0.0)) is not None
        ]
        end = max((word["end"] for word in words), default=0.0)
        result["segments"].append(
            {
                "start": 0.0,
                "end": end,
                "text": _text(payload.get("text")),
                "words": words,
                "confidence": _mean_confidence(words),
            }
        )
    return result


def transcribe_openai_whisper(
    media_path: str | os.PathLike[str],
    *,
    whisper_model: Any,
    model_name: str = "whisper",
    language: str | None = None,
    transcribe_options: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Invoke an existing Whisper model object or transcription callable.

    No model package is imported here.  An object with ``.transcribe`` or a
    callable accepting ``(media_path, **options)`` can be supplied.
    """
    if whisper_model is None:
        raise RuntimeError("OpenAI Whisper is selected but no loaded model was supplied")
    callable_transcribe = getattr(whisper_model, "transcribe", None)
    if not callable(callable_transcribe):
        callable_transcribe = whisper_model if callable(whisper_model) else None
    if callable_transcribe is None:
        raise TypeError("whisper_model must be callable or expose a transcribe() method")

    options = dict(transcribe_options or {})
    if language and "language" not in options:
        options["language"] = language
    options.setdefault("word_timestamps", True)
    try:
        payload = callable_transcribe(str(media_path), **options)
    except Exception as exc:
        raise RuntimeError(f"OpenAI Whisper transcription failed: {exc}") from exc
    return normalize_openai_whisper_result(payload, model=model_name, language=language)


def _parse_clock(value: Any) -> float | None:
    if not isinstance(value, str) or ":" not in value:
        return None
    parts = value.strip().replace(",", ".").split(":")
    if len(parts) not in (2, 3):
        return None
    try:
        numbers = [float(part) for part in parts]
    except ValueError:
        return None
    if len(numbers) == 2:
        hours = 0.0
        minutes, seconds = numbers
    else:
        hours, minutes, seconds = numbers
    total = hours * 3600 + minutes * 60 + seconds
    return total if math.isfinite(total) and total >= 0 else None


def _cpp_boundary(raw: Mapping[str, Any], boundary: str, default: float) -> float:
    timestamp_data = raw.get("timestamps")
    if isinstance(timestamp_data, Mapping):
        clock = _parse_clock(timestamp_data.get("from" if boundary == "start" else "to"))
        if clock is not None:
            return _time(clock)

    offsets = raw.get("offsets")
    if isinstance(offsets, Mapping):
        milliseconds = _finite_float(offsets.get("from" if boundary == "start" else "to"))
        if milliseconds is not None:
            return _time(milliseconds / 1000.0)

    candidates = (
        (boundary, 1.0),
        (("from" if boundary == "start" else "to"), 1.0),
        (("start_ms" if boundary == "start" else "end_ms"), 0.001),
        (("t0" if boundary == "start" else "t1"), 0.01),
    )
    for key, scale in candidates:
        value = raw.get(key)
        clock = _parse_clock(value)
        if clock is not None:
            return _time(clock)
        number = _finite_float(value)
        if number is not None:
            return _time(number * scale)
    return _time(default)


def _normalize_cpp_word(
    raw: Mapping[str, Any],
    *,
    segment_start: float,
    segment_end: float,
) -> dict[str, Any] | None:
    value = _text(raw.get("word", raw.get("text", raw.get("token"))))
    if not value or (value.startswith("[") and value.endswith("]")):
        return None
    start = _cpp_boundary(raw, "start", segment_start)
    end = max(start, _cpp_boundary(raw, "end", segment_end))
    word: dict[str, Any] = {"word": value, "start": start, "end": end}
    confidence = _confidence(raw.get("confidence", raw.get("probability", raw.get("p"))))
    if confidence is not None:
        word["confidence"] = confidence
    return word


def parse_whisper_cpp_json(
    payload: Mapping[str, Any] | Sequence[Any],
    *,
    model: str = "whisper.cpp",
    language: str | None = None,
) -> dict[str, Any]:
    """Normalize current and legacy whisper.cpp JSON formats defensively."""
    if isinstance(payload, Sequence) and not isinstance(payload, (str, bytes)):
        root: Mapping[str, Any] = {"segments": payload}
    elif isinstance(payload, Mapping):
        root = payload
    else:
        raise TypeError("whisper.cpp returned a non-object JSON result")

    detected_language = language
    result_data = root.get("result")
    if isinstance(result_data, Mapping):
        detected_language = _text(result_data.get("language")) or detected_language
    params = root.get("params")
    if not detected_language and isinstance(params, Mapping):
        detected_language = _text(params.get("language")) or None
    detected_language = _text(root.get("language")) or detected_language

    result = _empty_result("whisper_cpp", model, detected_language)
    raw_segments = root.get("transcription", root.get("segments"))
    if not isinstance(raw_segments, Sequence) or isinstance(raw_segments, (str, bytes)):
        raw_segments = []

    for raw in raw_segments:
        if not isinstance(raw, Mapping):
            continue
        start = _cpp_boundary(raw, "start", 0.0)
        end = max(start, _cpp_boundary(raw, "end", start))
        raw_words = raw.get("words", raw.get("tokens"))
        if not isinstance(raw_words, Sequence) or isinstance(raw_words, (str, bytes)):
            raw_words = []
        words = [
            word
            for item in raw_words
            if isinstance(item, Mapping)
            and (word := _normalize_cpp_word(item, segment_start=start, segment_end=end)) is not None
        ]
        segment = {
            "start": start,
            "end": end,
            "text": _text(raw.get("text", raw.get("transcript")))
            or " ".join(word["word"] for word in words),
            "words": words,
            "confidence": _segment_confidence(raw, words),
        }
        result["segments"].append(segment)

    if not result["segments"]:
        raw_words = root.get("words", root.get("tokens"))
        if isinstance(raw_words, Sequence) and not isinstance(raw_words, (str, bytes)):
            words = [
                word
                for item in raw_words
                if isinstance(item, Mapping)
                and (word := _normalize_cpp_word(item, segment_start=0.0, segment_end=0.0))
                is not None
            ]
            transcript = _text(root.get("text", root.get("transcript")))
            if words or transcript:
                result["segments"].append(
                    {
                        "start": min((word["start"] for word in words), default=0.0),
                        "end": max((word["end"] for word in words), default=0.0),
                        "text": transcript or " ".join(word["word"] for word in words),
                        "words": words,
                        "confidence": _mean_confidence(words),
                    }
                )
    return result


def _run_command(command: list[str], *, timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def _resolve_executable(value: str | os.PathLike[str] | None) -> str | None:
    if not value:
        return None
    supplied = os.fspath(value)
    resolved = shutil.which(supplied)
    if resolved:
        return resolved
    path = Path(supplied).expanduser()
    if path.is_file() and os.access(path, os.X_OK):
        return str(path.resolve())
    return None


def whisper_cpp_model_name(model_path: str | os.PathLike[str] | None) -> str:
    """Return the model identity encoded in a standard whisper.cpp filename."""
    if not model_path:
        return "whisper.cpp"
    filename = Path(model_path).expanduser().name
    lowered = filename.lower()
    for suffix in (".bin", ".gguf"):
        if lowered.endswith(suffix):
            filename = filename[: -len(suffix)]
            break
    if filename.lower().startswith("ggml-"):
        filename = filename[5:]
    return filename or "whisper.cpp"


def _whisper_cpp_vad_args(options: Mapping[str, Any] | None = None) -> list[str]:
    """Build validated whisper.cpp VAD flags from environment and overrides.

    Invalid values are omitted so a typo in an optional tuning value cannot
    prevent transcription. The whisper.cpp defaults remain in effect for any
    option that is not configured.
    """
    configured = options if isinstance(options, Mapping) else {}
    args: list[str] = []
    for (
        key,
        flag,
        environment_name,
        value_type,
        minimum,
        maximum,
    ) in _WHISPER_CPP_VAD_OPTIONS:
        raw_value = configured.get(key, os.environ.get(environment_name))
        if raw_value is None or isinstance(raw_value, bool):
            continue
        try:
            numeric = float(raw_value)
        except (TypeError, ValueError):
            continue
        if (
            not math.isfinite(numeric)
            or numeric < minimum
            or (maximum is not None and numeric > maximum)
        ):
            continue
        if value_type is int:
            if not numeric.is_integer():
                continue
            rendered = str(int(numeric))
        else:
            rendered = format(numeric, "g")
        args.extend([flag, rendered])
    return args


def _load_json_output(path: Path, stdout: str) -> Any:
    if path.is_file():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"whisper.cpp wrote invalid JSON to {path}: {exc}") from exc
    output = (stdout or "").strip()
    try:
        return json.loads(output)
    except json.JSONDecodeError:
        # A few whisper.cpp builds mix progress logs into stdout.  Decode the
        # first complete JSON object rather than requiring pristine output.
        decoder = json.JSONDecoder()
        for index, char in enumerate(output):
            if char not in "[{":
                continue
            try:
                value, _ = decoder.raw_decode(output[index:])
                return value
            except json.JSONDecodeError:
                continue
    raise RuntimeError("whisper.cpp completed but did not produce valid JSON")


def transcribe_whisper_cpp(
    media_path: str | os.PathLike[str],
    *,
    executable: str | os.PathLike[str],
    model_path: str | os.PathLike[str],
    model_name: str | None = None,
    language: str | None = None,
    vad_model_path: str | os.PathLike[str] | None = None,
    vad_options: Mapping[str, Any] | None = None,
    ffmpeg_bin: str = "ffmpeg",
    timeout: float = 3600,
    extra_args: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Extract 16 kHz mono PCM, run whisper.cpp, and normalize its JSON."""
    executable_path = _resolve_executable(executable)
    if executable_path is None:
        raise RuntimeError(f"whisper.cpp executable was not found: {executable}")
    model = Path(model_path).expanduser()
    if not model.is_file():
        raise RuntimeError(f"whisper.cpp model file was not found: {model_path}")
    ffmpeg_path = _resolve_executable(ffmpeg_bin)
    if ffmpeg_path is None:
        raise RuntimeError(f"FFmpeg executable was not found: {ffmpeg_bin}")
    source = Path(media_path).expanduser()
    if not source.is_file():
        raise RuntimeError(f"Media file was not found: {media_path}")
    if timeout <= 0:
        raise ValueError("timeout must be greater than zero")
    requested_language = _requested_whisper_cpp_language(language)
    configured_vad_path = vad_model_path or os.environ.get(
        WHISPER_CPP_VAD_MODEL_ENV
    )
    vad_model = Path(configured_vad_path).expanduser() if configured_vad_path else None
    # VAD is an optional optimization. A stale or absent model path must not
    # turn an otherwise usable transcription backend into a hard failure.
    vad_available = bool(vad_model and vad_model.is_file())

    with tempfile.TemporaryDirectory(prefix="vcf-whisper-cpp-") as temp_dir:
        temp_path = Path(temp_dir)
        wav_path = temp_path / "audio.wav"
        output_prefix = temp_path / "transcript"
        ffmpeg_command = [
            ffmpeg_path,
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(wav_path),
        ]
        try:
            extracted = _run_command(ffmpeg_command, timeout=min(timeout, 3600))
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("FFmpeg timed out while extracting transcription audio") from exc
        except OSError as exc:
            raise RuntimeError(f"Could not start FFmpeg: {exc}") from exc
        if extracted.returncode != 0:
            detail = (extracted.stderr or extracted.stdout or "unknown FFmpeg error").strip()
            raise RuntimeError(f"FFmpeg audio extraction failed: {detail[-2000:]}")

        command = [
            executable_path,
            "-m",
            str(model.resolve()),
            "-f",
            str(wav_path),
            "-oj",
            "-of",
            str(output_prefix),
        ]
        command.extend(["-l", requested_language])
        if vad_available and vad_model is not None:
            command.extend(["--vad", "--vad-model", str(vad_model.resolve())])
            command.extend(_whisper_cpp_vad_args(vad_options))
        command.extend(str(value) for value in (extra_args or ()))
        try:
            completed = _run_command(command, timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("whisper.cpp transcription timed out") from exc
        except OSError as exc:
            raise RuntimeError(f"Could not start whisper.cpp: {exc}") from exc
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "unknown whisper.cpp error").strip()
            raise RuntimeError(f"whisper.cpp transcription failed: {detail[-2000:]}")

        payload = _load_json_output(output_prefix.with_suffix(".json"), completed.stdout)
        return parse_whisper_cpp_json(
            payload,
            model=model_name or whisper_cpp_model_name(model),
            language=(
                None
                if requested_language == DEFAULT_WHISPER_CPP_LANGUAGE
                else requested_language
            ),
        )


def _deepgram_words(raw_words: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_words, Sequence) or isinstance(raw_words, (str, bytes)):
        return []
    words: list[dict[str, Any]] = []
    for item in raw_words:
        if not isinstance(item, Mapping):
            continue
        value = dict(item)
        # Deepgram's display-ready spelling lives in punctuated_word.
        value["word"] = item.get("punctuated_word", item.get("word"))
        word = _normalize_word(value, default_start=0.0, default_end=0.0)
        if word is not None:
            words.append(word)
    return words


def _words_in_range(words: Sequence[Mapping[str, Any]], start: float, end: float) -> list[dict[str, Any]]:
    return [dict(word) for word in words if float(word["end"]) >= start and float(word["start"]) <= end]


def _attach_speaker_metadata(
    segment: dict[str, Any],
    raw_segment: Mapping[str, Any],
    words: Sequence[dict[str, Any]],
) -> None:
    """Retain diarization labels at both word and segment granularity."""
    speaker = raw_segment.get("speaker")
    if speaker is not None:
        segment["speaker"] = speaker
        for word in words:
            word.setdefault("speaker", speaker)

    speakers: list[Any] = []
    for word in words:
        word_speaker = word.get("speaker")
        if word_speaker is not None and word_speaker not in speakers:
            speakers.append(word_speaker)
    if speaker is None and len(speakers) == 1:
        segment["speaker"] = speakers[0]
    elif len(speakers) > 1:
        segment["speakers"] = speakers

    speaker_confidence = _confidence(raw_segment.get("speaker_confidence"))
    if speaker_confidence is None:
        speaker_confidence = _mean_confidence(
            [
                {"confidence": word["speaker_confidence"]}
                for word in words
                if word.get("speaker_confidence") is not None
            ]
        )
    if speaker_confidence is not None:
        segment["speaker_confidence"] = speaker_confidence


def _deepgram_topics(container: Mapping[str, Any]) -> list[dict[str, Any]]:
    topic_data = container.get("topics")
    if not isinstance(topic_data, Mapping):
        return []
    raw_segments = topic_data.get("segments")
    if not isinstance(raw_segments, Sequence) or isinstance(raw_segments, (str, bytes)):
        return []
    topics: list[dict[str, Any]] = []
    for raw_segment in raw_segments:
        if not isinstance(raw_segment, Mapping):
            continue
        raw_topics = raw_segment.get("topics")
        if not isinstance(raw_topics, Sequence) or isinstance(raw_topics, (str, bytes)):
            continue
        for raw_topic in raw_topics:
            if isinstance(raw_topic, Mapping):
                name = _text(raw_topic.get("topic", raw_topic.get("name")))
                confidence = _confidence(raw_topic.get("confidence", raw_topic.get("score")))
            else:
                name = _text(raw_topic)
                confidence = None
            if not name:
                continue
            item: dict[str, Any] = {"topic": name}
            if confidence is not None:
                item["confidence"] = confidence
            for key in ("start", "end", "start_word", "end_word"):
                if raw_segment.get(key) is not None:
                    item[key] = raw_segment[key]
            topics.append(item)
    return topics


def _deepgram_sentiments(container: Mapping[str, Any]) -> list[dict[str, Any]]:
    sentiment_data = container.get("sentiments")
    if not isinstance(sentiment_data, Mapping):
        return []
    raw_segments = sentiment_data.get("segments")
    if not isinstance(raw_segments, Sequence) or isinstance(raw_segments, (str, bytes)):
        return []
    sentiments: list[dict[str, Any]] = []
    for item in raw_segments:
        if not isinstance(item, Mapping):
            continue
        sentiment = _text(item.get("sentiment"))
        if not sentiment:
            continue
        normalized: dict[str, Any] = {"sentiment": sentiment}
        score = _finite_float(item.get("sentiment_score", item.get("score")))
        if score is not None:
            normalized["score"] = round(score, 6)
        for key in ("start", "end", "start_word", "end_word"):
            if item.get(key) is not None:
                normalized[key] = item[key]
        sentiments.append(normalized)
    return sentiments


def parse_deepgram_response(
    payload: Mapping[str, Any],
    *,
    model: str = "nova-3",
    language: str | None = None,
) -> dict[str, Any]:
    """Normalize a Deepgram prerecorded response, retaining topics/sentiment."""
    if not isinstance(payload, Mapping):
        raise TypeError("Deepgram returned a non-object JSON result")
    results = payload.get("results")
    if not isinstance(results, Mapping):
        raise RuntimeError("Deepgram response did not contain results")
    channels = results.get("channels")
    if not isinstance(channels, Sequence) or isinstance(channels, (str, bytes)) or not channels:
        raise RuntimeError("Deepgram response did not contain a transcript channel")
    channel = channels[0]
    if not isinstance(channel, Mapping):
        raise RuntimeError("Deepgram transcript channel was malformed")
    alternatives = channel.get("alternatives")
    if not isinstance(alternatives, Sequence) or isinstance(alternatives, (str, bytes)) or not alternatives:
        raise RuntimeError("Deepgram response did not contain a transcript alternative")
    alternative = alternatives[0]
    if not isinstance(alternative, Mapping):
        raise RuntimeError("Deepgram transcript alternative was malformed")

    detected_language = _text(channel.get("detected_language", channel.get("language"))) or language
    result = _empty_result("deepgram", model, detected_language)
    all_words = _deepgram_words(alternative.get("words"))

    utterances = results.get("utterances")
    if isinstance(utterances, Sequence) and not isinstance(utterances, (str, bytes)):
        for raw in utterances:
            if not isinstance(raw, Mapping):
                continue
            start = _time(raw.get("start"))
            end = max(start, _time(raw.get("end"), start))
            words = _deepgram_words(raw.get("words")) or _words_in_range(all_words, start, end)
            segment: dict[str, Any] = {
                "start": start,
                "end": end,
                "text": _text(raw.get("transcript", raw.get("text"))),
                "words": words,
                "confidence": _segment_confidence(raw, words),
            }
            _attach_speaker_metadata(segment, raw, words)
            sentiment = _text(raw.get("sentiment"))
            if sentiment:
                segment["sentiment"] = sentiment
                score = _finite_float(raw.get("sentiment_score"))
                if score is not None:
                    segment["sentiment_score"] = round(score, 6)
            result["segments"].append(segment)

    if not result["segments"]:
        paragraphs = alternative.get("paragraphs")
        raw_paragraphs = paragraphs.get("paragraphs") if isinstance(paragraphs, Mapping) else None
        if isinstance(raw_paragraphs, Sequence) and not isinstance(raw_paragraphs, (str, bytes)):
            for paragraph in raw_paragraphs:
                if not isinstance(paragraph, Mapping):
                    continue
                sentences = paragraph.get("sentences")
                if not isinstance(sentences, Sequence) or isinstance(sentences, (str, bytes)):
                    sentences = [paragraph]
                for raw in sentences:
                    if not isinstance(raw, Mapping):
                        continue
                    start = _time(raw.get("start", paragraph.get("start")))
                    end = max(start, _time(raw.get("end", paragraph.get("end")), start))
                    words = _words_in_range(all_words, start, end)
                    segment = {
                        "start": start,
                        "end": end,
                        "text": _text(raw.get("text", raw.get("transcript"))),
                        "words": words,
                        "confidence": _segment_confidence(raw, words),
                    }
                    _attach_speaker_metadata(segment, raw, words)
                    result["segments"].append(segment)

    if not result["segments"] and (_text(alternative.get("transcript")) or all_words):
        segment = {
            "start": min((word["start"] for word in all_words), default=0.0),
            "end": max((word["end"] for word in all_words), default=0.0),
            "text": _text(alternative.get("transcript")),
            "words": all_words,
            "confidence": (
                _confidence(alternative.get("confidence"))
                if _confidence(alternative.get("confidence")) is not None
                else _mean_confidence(all_words)
            ),
        }
        _attach_speaker_metadata(segment, alternative, all_words)
        result["segments"].append(segment)

    result["topics"] = _deepgram_topics(results) or _deepgram_topics(alternative)
    sentiments = _deepgram_sentiments(results) or _deepgram_sentiments(alternative)
    if sentiments:
        result["sentiments"] = sentiments
    sentiment_data = results.get("sentiments", alternative.get("sentiments"))
    if isinstance(sentiment_data, Mapping) and isinstance(sentiment_data.get("average"), Mapping):
        average = sentiment_data["average"]
        label = _text(average.get("sentiment"))
        if label:
            result["sentiment"] = {"sentiment": label}
            score = _finite_float(average.get("sentiment_score", average.get("score")))
            if score is not None:
                result["sentiment"]["score"] = round(score, 6)
    return result


class _FileChunks:
    """Repeatable-enough iterable used by urllib to avoid loading media in RAM."""

    def __init__(self, handle: Any, chunk_size: int = 1024 * 1024):
        self.handle = handle
        self.chunk_size = chunk_size

    def __iter__(self):
        while True:
            chunk = self.handle.read(self.chunk_size)
            if not chunk:
                return
            yield chunk


def transcribe_deepgram(
    media_path: str | os.PathLike[str],
    *,
    api_key: str,
    model: str = "nova-3",
    language: str | None = None,
    endpoint: str = DEFAULT_DEEPGRAM_ENDPOINT,
    timeout: float = 3600,
    request_options: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Upload media to Deepgram's prerecorded REST API using ``urllib``."""
    if not _text(api_key):
        raise RuntimeError("Deepgram is selected but DEEPGRAM_API_KEY is not configured")
    source = Path(media_path).expanduser()
    if not source.is_file():
        raise RuntimeError(f"Media file was not found: {media_path}")
    if timeout <= 0:
        raise ValueError("timeout must be greater than zero")

    params: dict[str, Any] = {
        "model": model,
        "smart_format": "true",
        "punctuate": "true",
        "utterances": "true",
        "paragraphs": "true",
        "diarize": "true",
        "topics": "true",
        "sentiment": "true",
    }
    if language:
        params["language"] = language
    for key, value in (request_options or {}).items():
        if value is not None:
            params[str(key)] = str(value).lower() if isinstance(value, bool) else str(value)
    separator = "&" if urllib.parse.urlsplit(endpoint).query else "?"
    url = endpoint + separator + urllib.parse.urlencode(params)
    content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"

    try:
        with source.open("rb") as media:
            request = urllib.request.Request(
                url,
                data=_FileChunks(media),
                headers={
                    "Authorization": f"Token {api_key}",
                    "Content-Type": content_type,
                    "Content-Length": str(source.stat().st_size),
                    "Accept": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = response.read()
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace").strip()
        except Exception:
            detail = ""
        suffix = f": {detail[:1000]}" if detail else ""
        raise RuntimeError(f"Deepgram request failed with HTTP {exc.code}{suffix}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Deepgram request failed: {exc.reason}") from exc
    except (TimeoutError, OSError) as exc:
        raise RuntimeError(f"Deepgram request failed: {exc}") from exc

    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError("Deepgram returned invalid JSON") from exc
    return parse_deepgram_response(payload, model=model, language=language)


def probe_openai_whisper(*, whisper_model: Any = None, accelerated: bool = False) -> dict[str, Any]:
    available = whisper_model is not None and (
        callable(whisper_model) or callable(getattr(whisper_model, "transcribe", None))
    )
    return {
        "provider": "openai_whisper",
        "available": available,
        "accelerated": bool(available and accelerated),
        "reason": None if available else "No loaded OpenAI Whisper model was supplied",
    }


def probe_whisper_cpp(
    *,
    executable: str | os.PathLike[str] | None = None,
    model_path: str | os.PathLike[str] | None = None,
    vad_model_path: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    executable = (
        executable
        or os.environ.get(WHISPER_CPP_PATH_ENV)
        or DEFAULT_WHISPER_CPP_EXECUTABLE
    )
    model_path = model_path or os.environ.get(WHISPER_CPP_MODEL_ENV)
    vad_model_path = vad_model_path or os.environ.get(WHISPER_CPP_VAD_MODEL_ENV)
    resolved = _resolve_executable(executable)
    model_available = bool(model_path and Path(model_path).expanduser().is_file())
    vad_model_available = bool(
        vad_model_path and Path(vad_model_path).expanduser().is_file()
    )
    reasons = []
    if not resolved:
        reasons.append("whisper.cpp executable not found")
    if not model_available:
        reasons.append("whisper.cpp model file not found")
    return {
        "provider": "whisper_cpp",
        "available": bool(resolved and model_available),
        "executable": resolved,
        "model_available": model_available,
        "vad_model_configured": bool(vad_model_path),
        "vad_model_available": vad_model_available,
        "vad_reason": (
            None
            if vad_model_available
            else (
                "whisper.cpp VAD model file not found"
                if vad_model_path
                else "VCF_WHISPER_CPP_VAD_MODEL is not configured"
            )
        ),
        "reason": "; ".join(reasons) or None,
    }


def probe_deepgram(*, api_key: str | None = None) -> dict[str, Any]:
    api_key = api_key or os.environ.get(DEEPGRAM_API_KEY_ENV)
    available = bool(_text(api_key))
    return {
        "provider": "deepgram",
        "available": available,
        "reason": None if available else "DEEPGRAM_API_KEY is not configured",
    }


def probe_transcription_capabilities(
    *,
    whisper_model: Any = None,
    openai_accelerated: bool = False,
    whisper_cpp_executable: str | os.PathLike[str] | None = None,
    whisper_cpp_model_path: str | os.PathLike[str] | None = None,
    whisper_cpp_vad_model_path: str | os.PathLike[str] | None = None,
    deepgram_api_key: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Return serializable backend readiness without importing ML packages."""
    return {
        "openai_whisper": probe_openai_whisper(
            whisper_model=whisper_model,
            accelerated=openai_accelerated,
        ),
        "whisper_cpp": probe_whisper_cpp(
            executable=whisper_cpp_executable,
            model_path=whisper_cpp_model_path,
            vad_model_path=whisper_cpp_vad_model_path,
        ),
        "deepgram": probe_deepgram(api_key=deepgram_api_key),
    }


def _availability_value(
    availability: Mapping[str, Any] | None,
    key: str,
    fallback: bool,
) -> bool:
    if availability is None or key not in availability:
        return fallback
    value = availability[key]
    if isinstance(value, Mapping):
        return bool(value.get("available", fallback))
    return bool(value)


def _accelerated_availability(
    availability: Mapping[str, Any] | None,
    fallback: bool,
) -> bool:
    if availability is None:
        return fallback
    if "openai_whisper_accelerated" in availability:
        return bool(availability["openai_whisper_accelerated"])
    openai_value = availability.get("openai_whisper")
    if isinstance(openai_value, Mapping) and "accelerated" in openai_value:
        return bool(openai_value["accelerated"])
    return fallback


def select_auto_provider(
    *,
    openai_available: bool,
    openai_accelerated: bool,
    whisper_cpp_available: bool,
) -> str:
    """Prefer accelerated PyTorch, then whisper.cpp, then PyTorch CPU."""
    if openai_available and openai_accelerated:
        return "openai_whisper"
    if whisper_cpp_available:
        return "whisper_cpp"
    if openai_available:
        return "openai_whisper"
    raise RuntimeError(
        "No local transcription backend is available; configure OpenAI Whisper "
        "or a whisper.cpp executable and model"
    )


def transcribe_media(
    media_path: str | os.PathLike[str],
    *,
    provider: str = "auto",
    availability: Mapping[str, Any] | None = None,
    whisper_model: Any = None,
    openai_model_name: str = "whisper",
    openai_accelerated: bool = False,
    openai_options: Mapping[str, Any] | None = None,
    whisper_cpp_executable: str | os.PathLike[str] | None = None,
    whisper_cpp_model_path: str | os.PathLike[str] | None = None,
    whisper_cpp_model_name: str | None = None,
    whisper_cpp_args: Sequence[str] | None = None,
    whisper_cpp_vad_model_path: str | os.PathLike[str] | None = None,
    whisper_cpp_vad_options: Mapping[str, Any] | None = None,
    ffmpeg_bin: str = "ffmpeg",
    deepgram_api_key: str | None = None,
    deepgram_model: str = "nova-3",
    deepgram_endpoint: str = DEFAULT_DEEPGRAM_ENDPOINT,
    deepgram_options: Mapping[str, Any] | None = None,
    language: str | None = None,
    timeout: float = 3600,
) -> dict[str, Any]:
    """Dispatch a media transcription to a configured normalized provider.

    ``VCF_WHISPER_CPP_PATH``, ``VCF_WHISPER_CPP_MODEL``,
    ``VCF_WHISPER_CPP_LANGUAGE``, ``VCF_WHISPER_CPP_VAD_MODEL``, and
    ``DEEPGRAM_API_KEY`` supply defaults when their corresponding keyword
    arguments are omitted.
    """
    whisper_cpp_executable = (
        whisper_cpp_executable
        or os.environ.get(WHISPER_CPP_PATH_ENV)
        or DEFAULT_WHISPER_CPP_EXECUTABLE
    )
    whisper_cpp_model_path = whisper_cpp_model_path or os.environ.get(WHISPER_CPP_MODEL_ENV)
    deepgram_api_key = deepgram_api_key or os.environ.get(DEEPGRAM_API_KEY_ENV)
    provider = str(provider or "auto").strip().lower().replace("-", "_")
    aliases = {
        "auto_local": "auto",
        "openai": "openai_whisper",
        "whisper": "openai_whisper",
        "whispercpp": "whisper_cpp",
        "deepgram_nova3": "deepgram",
    }
    provider = aliases.get(provider, provider)
    if provider not in SUPPORTED_PROVIDERS:
        raise ValueError(
            f"Unsupported transcription provider '{provider}'; expected one of "
            + ", ".join(SUPPORTED_PROVIDERS)
        )

    openai_probe = probe_openai_whisper(
        whisper_model=whisper_model,
        accelerated=openai_accelerated,
    )
    cpp_probe = probe_whisper_cpp(
        executable=whisper_cpp_executable,
        model_path=whisper_cpp_model_path,
    )
    openai_available = _availability_value(
        availability,
        "openai_whisper",
        bool(openai_probe["available"]),
    )
    openai_is_accelerated = _accelerated_availability(
        availability,
        bool(openai_probe["accelerated"]),
    )
    cpp_available = _availability_value(
        availability,
        "whisper_cpp",
        bool(cpp_probe["available"]),
    )

    if provider == "auto":
        provider = select_auto_provider(
            openai_available=openai_available,
            openai_accelerated=openai_is_accelerated,
            whisper_cpp_available=cpp_available,
        )

    if provider == "openai_whisper":
        if whisper_model is None:
            raise RuntimeError("OpenAI Whisper is selected but no loaded model was supplied")
        return transcribe_openai_whisper(
            media_path,
            whisper_model=whisper_model,
            model_name=openai_model_name,
            language=language,
            transcribe_options=openai_options,
        )
    if provider == "whisper_cpp":
        if not whisper_cpp_executable:
            raise RuntimeError("whisper.cpp is selected but no executable path was configured")
        if not whisper_cpp_model_path:
            raise RuntimeError("whisper.cpp is selected but no model path was configured")
        return transcribe_whisper_cpp(
            media_path,
            executable=whisper_cpp_executable,
            model_path=whisper_cpp_model_path,
            model_name=whisper_cpp_model_name,
            language=language,
            vad_model_path=whisper_cpp_vad_model_path,
            vad_options=whisper_cpp_vad_options,
            ffmpeg_bin=ffmpeg_bin,
            timeout=timeout,
            extra_args=whisper_cpp_args,
        )
    return transcribe_deepgram(
        media_path,
        api_key=deepgram_api_key or "",
        model=deepgram_model,
        language=language,
        endpoint=deepgram_endpoint,
        timeout=timeout,
        request_options=deepgram_options,
    )


__all__ = [
    "DEFAULT_DEEPGRAM_ENDPOINT",
    "DEFAULT_WHISPER_CPP_LANGUAGE",
    "DEFAULT_WHISPER_CPP_EXECUTABLE",
    "DEEPGRAM_API_KEY_ENV",
    "SUPPORTED_PROVIDERS",
    "WHISPER_CPP_LANGUAGE_ENV",
    "WHISPER_CPP_MODEL_ENV",
    "WHISPER_CPP_PATH_ENV",
    "WHISPER_CPP_VAD_MODEL_ENV",
    "normalize_openai_whisper_result",
    "parse_deepgram_response",
    "parse_whisper_cpp_json",
    "probe_deepgram",
    "probe_openai_whisper",
    "probe_transcription_capabilities",
    "probe_whisper_cpp",
    "select_auto_provider",
    "transcribe_deepgram",
    "transcribe_media",
    "transcribe_openai_whisper",
    "transcribe_whisper_cpp",
    "whisper_cpp_model_name",
]
