"""Provider-agnostic utilities for semantic viral-moment analysis.

The functions in this module deliberately depend only on the Python standard
library.  They are suitable for use by the main pipeline, a worker process, or
unit tests without importing the application's media/ML dependencies.
"""

from __future__ import annotations

import base64
import copy
import json
import math
import mimetypes
import os
import re
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse, urlunparse
from urllib.request import Request, urlopen


SEMANTIC_DIMENSIONS = (
    "hook",
    "payoff",
    "novelty",
    "standalone_clarity",
    "emotional_arc",
    "quoteability",
    "shareability",
)

_SEMANTIC_ITEM_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["candidate_id", "scores", "overall_score", "topics", "reasons"],
    "properties": {
        "candidate_id": {"type": "string"},
        "scores": {
            "type": "object",
            "additionalProperties": False,
            "required": list(SEMANTIC_DIMENSIONS),
            "properties": {
                name: {"type": "number", "minimum": 0, "maximum": 10}
                for name in SEMANTIC_DIMENSIONS
            },
        },
        "overall_score": {"type": "number", "minimum": 0, "maximum": 10},
        "topics": {
            "type": "array",
            "items": {"type": "string"},
            "maxItems": 8,
        },
        "reasons": {
            "type": "array",
            "items": {"type": "string"},
            "maxItems": 5,
        },
    },
}

SEMANTIC_RESPONSE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["candidates"],
    "properties": {
        "candidates": {
            "type": "array",
            "items": _SEMANTIC_ITEM_SCHEMA,
        }
    },
}

GEMINI_RESPONSE_SCHEMA = {
    "type": "object",
    "required": ["candidates"],
    "properties": {
        "candidates": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["start", "end", "score", "topics", "reasons"],
                "properties": {
                    "start": {
                        "description": "Seconds or an HH:MM:SS.mmm timestamp",
                    },
                    "end": {
                        "description": "Seconds or an HH:MM:SS.mmm timestamp",
                    },
                    "score": {"type": "number", "minimum": 0, "maximum": 10},
                    "summary": {"type": "string"},
                    "topics": {"type": "array", "items": {"type": "string"}},
                    "reasons": {"type": "array", "items": {"type": "string"}},
                },
            },
        }
    },
}


@dataclass
class ProviderError(RuntimeError):
    """A serializable error raised by an optional intelligence provider."""

    provider: str
    code: str
    message: str
    retryable: bool = False
    http_status: int | None = None
    details: str | None = None

    def __post_init__(self) -> None:
        RuntimeError.__init__(self, self.message)

    def to_dict(self) -> dict[str, Any]:
        error: dict[str, Any] = {
            "code": self.code,
            "message": self.message,
            "retryable": self.retryable,
        }
        if self.http_status is not None:
            error["http_status"] = self.http_status
        if self.details:
            error["details"] = self.details
        return {"provider": self.provider, "status": "failed", "error": error}


def semantic_response_schema() -> dict[str, Any]:
    """Return a caller-safe copy of the local semantic response schema."""

    return copy.deepcopy(SEMANTIC_RESPONSE_SCHEMA)


def _finite_float(value: Any, name: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be numeric") from error
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _normalized_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _display_words(words: Iterable[Mapping[str, Any]]) -> str:
    text = " ".join(_normalized_text(word.get("word", word.get("text", ""))) for word in words)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return _normalized_text(text)


def _split_text_sentences(text: str) -> list[str]:
    text = _normalized_text(text)
    if not text:
        return []
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])[\"']?\s+", text) if part.strip()]
    return sentences or [text]


def _normalize_words(segment: Mapping[str, Any], start: float, end: float) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for raw in segment.get("words", []) or []:
        if not isinstance(raw, Mapping):
            continue
        word_text = _normalized_text(raw.get("word", raw.get("text", "")))
        if not word_text:
            continue
        try:
            word_start = _finite_float(raw.get("start", start), "word start")
            word_end = _finite_float(raw.get("end", word_start), "word end")
        except ValueError:
            continue
        word_start = max(start, word_start)
        word_end = min(end, word_end)
        if word_end <= word_start:
            continue
        word = {"word": word_text, "start": word_start, "end": word_end}
        if raw.get("speaker") is not None:
            word["speaker"] = raw.get("speaker")
        if raw.get("speaker_confidence") is not None:
            try:
                word["speaker_confidence"] = _finite_float(raw.get("speaker_confidence"), "speaker confidence")
            except ValueError:
                pass
        normalized.append(word)
    normalized.sort(key=lambda item: (item["start"], item["end"]))
    return normalized


def normalize_transcript(transcript: Mapping[str, Any] | Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Normalize Whisper-like transcript data without applying keyword filters.

    ``transcript`` may be a ``{"segments": [...]}`` mapping or a segment list.
    Invalid/empty segments are ignored.  Word timestamps are retained when
    present and segment timing remains the fallback alignment source.
    """

    raw_segments: Any
    if isinstance(transcript, Mapping):
        raw_segments = transcript.get("segments", [])
    else:
        raw_segments = transcript
    if isinstance(raw_segments, (str, bytes)) or not isinstance(raw_segments, Sequence):
        raise ValueError("transcript must contain a segment list")

    segments: list[dict[str, Any]] = []
    words: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_segments):
        if not isinstance(raw, Mapping):
            continue
        try:
            start = max(0.0, _finite_float(raw.get("start"), "segment start"))
            end = _finite_float(raw.get("end"), "segment end")
        except ValueError:
            continue
        text = _normalized_text(raw.get("text", ""))
        if end <= start or not text:
            continue
        segment_words = _normalize_words(raw, start, end)
        record = {
            "id": str(raw.get("id", f"segment-{index:05d}")),
            "start": start,
            "end": end,
            "text": text,
            "words": segment_words,
        }
        if raw.get("speaker") is not None:
            record["speaker"] = raw.get("speaker")
        if raw.get("heuristic_score") is not None:
            try:
                record["heuristic_score"] = _finite_float(raw["heuristic_score"], "heuristic score")
            except ValueError:
                pass
        segments.append(record)
        words.extend(segment_words)

    segments.sort(key=lambda item: (item["start"], item["end"]))
    words.sort(key=lambda item: (item["start"], item["end"]))
    return {
        "segments": segments,
        "words": words,
        "start": segments[0]["start"] if segments else 0.0,
        "end": max((segment["end"] for segment in segments), default=0.0),
    }


def _split_long_unit(unit: dict[str, Any], max_duration_sec: float) -> list[dict[str, Any]]:
    if unit["end"] - unit["start"] <= max_duration_sec:
        return [unit]
    words = unit.get("words", [])
    if words:
        parts: list[dict[str, Any]] = []
        chunk: list[dict[str, Any]] = []
        chunk_start = words[0]["start"]
        for word in words:
            if chunk and word["end"] - chunk_start > max_duration_sec:
                parts.append({
                    "start": chunk[0]["start"],
                    "end": chunk[-1]["end"],
                    "text": _display_words(chunk),
                    "words": chunk,
                    "segment_ids": list(unit["segment_ids"]),
                })
                chunk = []
                chunk_start = word["start"]
            chunk.append(word)
        if chunk:
            parts.append({
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "text": _display_words(chunk),
                "words": chunk,
                "segment_ids": list(unit["segment_ids"]),
            })
        return parts

    sentence_parts = _split_text_sentences(unit["text"])
    part_count = max(2, math.ceil((unit["end"] - unit["start"]) / max_duration_sec))
    if len(sentence_parts) < part_count:
        tokens = unit["text"].split()
        size = max(1, math.ceil(len(tokens) / part_count))
        sentence_parts = [" ".join(tokens[pos : pos + size]) for pos in range(0, len(tokens), size)]
    total_weight = sum(max(1, len(part.split())) for part in sentence_parts)
    cursor = unit["start"]
    output: list[dict[str, Any]] = []
    for index, part in enumerate(sentence_parts):
        fraction = max(1, len(part.split())) / total_weight
        part_end = unit["end"] if index == len(sentence_parts) - 1 else cursor + (
            (unit["end"] - unit["start"]) * fraction
        )
        output.append({
            "start": cursor,
            "end": part_end,
            "text": part,
            "words": [],
            "segment_ids": list(unit["segment_ids"]),
        })
        cursor = part_end
    return output


def _sentence_units(normalized: Mapping[str, Any], max_duration_sec: float) -> list[dict[str, Any]]:
    units: list[dict[str, Any]] = []
    for segment in normalized.get("segments", []):
        words = segment.get("words", [])
        if words:
            current: list[dict[str, Any]] = []
            for word in words:
                current.append(word)
                ends_sentence = bool(re.search(r"[.!?][\"']?$", word["word"]))
                if ends_sentence:
                    units.append({
                        "start": current[0]["start"],
                        "end": current[-1]["end"],
                        "text": _display_words(current),
                        "words": current,
                        "segment_ids": [segment["id"]],
                    })
                    current = []
            if current:
                units.append({
                    "start": current[0]["start"],
                    "end": current[-1]["end"],
                    "text": _display_words(current),
                    "words": current,
                    "segment_ids": [segment["id"]],
                })
            continue

        sentence_parts = _split_text_sentences(segment["text"])
        weights = [max(1, len(sentence.split())) for sentence in sentence_parts]
        total_weight = sum(weights)
        cursor = segment["start"]
        for index, (sentence, weight) in enumerate(zip(sentence_parts, weights)):
            sentence_end = segment["end"] if index == len(sentence_parts) - 1 else cursor + (
                (segment["end"] - segment["start"]) * weight / total_weight
            )
            units.append({
                "start": cursor,
                "end": sentence_end,
                "text": sentence,
                "words": [],
                "segment_ids": [segment["id"]],
            })
            cursor = sentence_end

    split_units: list[dict[str, Any]] = []
    for unit in sorted(units, key=lambda item: (item["start"], item["end"])):
        split_units.extend(_split_long_unit(unit, max_duration_sec))
    return split_units


def _window_from_units(units: Sequence[Mapping[str, Any]], start_index: int, end_index: int) -> dict[str, Any]:
    selected = units[start_index : end_index + 1]
    words = [dict(word) for unit in selected for word in unit.get("words", [])]
    segment_ids = list(dict.fromkeys(segment_id for unit in selected for segment_id in unit["segment_ids"]))
    start = float(selected[0]["start"])
    end = float(selected[-1]["end"])
    return {
        "start": round(start, 3),
        "end": round(end, 3),
        "duration": round(end - start, 3),
        "text": _normalized_text(" ".join(str(unit["text"]) for unit in selected)),
        "words": words,
        "segment_ids": segment_ids,
        "context_before": _normalized_text(str(units[start_index - 1]["text"])) if start_index > 0 else "",
        "context_after": _normalized_text(str(units[end_index + 1]["text"])) if end_index + 1 < len(units) else "",
    }


def build_candidate_windows(
    transcript: Mapping[str, Any] | Sequence[Mapping[str, Any]],
    *,
    target_duration_sec: float = 30.0,
    stride_sec: float = 15.0,
    min_duration_sec: float = 15.0,
    max_duration_sec: float = 75.0,
) -> list[dict[str, Any]]:
    """Build overlapping sentence/word-aligned semantic-analysis windows.

    Every non-empty transcript is represented; fixed keywords never gate a
    window.  A transcript shorter than ``min_duration_sec`` yields one short
    fallback window so short source videos are still analyzable.
    """

    target = _finite_float(target_duration_sec, "target duration")
    stride = _finite_float(stride_sec, "stride")
    minimum = _finite_float(min_duration_sec, "minimum duration")
    maximum = _finite_float(max_duration_sec, "maximum duration")
    if not (0 < minimum <= target <= maximum) or stride <= 0:
        raise ValueError("durations must satisfy 0 < min <= target <= max and stride > 0")

    normalized = normalize_transcript(transcript)
    units = _sentence_units(normalized, maximum)
    if not units:
        return []

    total_duration = units[-1]["end"] - units[0]["start"]
    if total_duration <= minimum:
        single = _window_from_units(units, 0, len(units) - 1)
        single["id"] = "candidate-0000"
        single["short_fallback"] = total_duration < minimum
        return [single]

    anchors: list[float] = []
    anchor = float(units[0]["start"])
    latest_anchor = float(units[-1]["end"]) - minimum
    while anchor <= latest_anchor + 1e-9:
        anchors.append(anchor)
        anchor += stride

    windows: list[dict[str, Any]] = []
    seen: set[tuple[float, float]] = set()
    for anchor in anchors:
        start_index = min(range(len(units)), key=lambda index: abs(units[index]["start"] - anchor))
        valid_ends = [
            index
            for index in range(start_index, len(units))
            if minimum <= units[index]["end"] - units[start_index]["start"] <= maximum
        ]
        if not valid_ends:
            # A late anchor may need to move backward to retain the minimum.
            possible_starts = [
                index
                for index in range(start_index, -1, -1)
                if minimum <= units[-1]["end"] - units[index]["start"] <= maximum
            ]
            if not possible_starts:
                continue
            start_index = possible_starts[0]
            valid_ends = [
                index
                for index in range(start_index, len(units))
                if minimum <= units[index]["end"] - units[start_index]["start"] <= maximum
            ]
        end_index = min(
            valid_ends,
            key=lambda index: abs((units[index]["end"] - units[start_index]["start"]) - target),
        )
        window = _window_from_units(units, start_index, end_index)
        identity = (window["start"], window["end"])
        if identity in seen:
            continue
        seen.add(identity)
        window["id"] = f"candidate-{len(windows):04d}"
        windows.append(window)

    # Ensure the final spoken content appears even when sentence timings are
    # irregular enough that stride anchors stop before it.
    if windows and windows[-1]["end"] < units[-1]["end"]:
        valid_starts = [
            index for index, unit in enumerate(units)
            if minimum <= units[-1]["end"] - unit["start"] <= maximum
        ]
        if valid_starts:
            start_index = min(
                valid_starts,
                key=lambda index: abs((units[-1]["end"] - units[index]["start"]) - target),
            )
            window = _window_from_units(units, start_index, len(units) - 1)
            identity = (window["start"], window["end"])
            if identity not in seen:
                window["id"] = f"candidate-{len(windows):04d}"
                windows.append(window)

    return windows


def _candidate_score(candidate: Mapping[str, Any], key: str = "heuristic_score") -> float:
    value = candidate.get(key, candidate.get("score", 0.0))
    try:
        score = float(value)
    except (TypeError, ValueError):
        return 0.0
    return score if math.isfinite(score) else 0.0


def select_semantic_candidates(
    candidates: Sequence[Mapping[str, Any]],
    *,
    top_heuristic: int = 60,
    time_diverse: int = 20,
    score_key: str = "heuristic_score",
) -> list[dict[str, Any]]:
    """Select top-scoring candidates plus farthest-point time coverage."""

    if top_heuristic < 0 or time_diverse < 0:
        raise ValueError("selection counts cannot be negative")
    indexed = [(index, dict(candidate)) for index, candidate in enumerate(candidates)]
    ranked = sorted(indexed, key=lambda item: (-_candidate_score(item[1], score_key), item[0]))
    chosen = ranked[:top_heuristic]
    chosen_indices = {index for index, _ in chosen}
    remaining = [item for item in indexed if item[0] not in chosen_indices]

    def midpoint(candidate: Mapping[str, Any]) -> float:
        return (float(candidate.get("start", 0.0)) + float(candidate.get("end", 0.0))) / 2.0

    diverse: list[tuple[int, dict[str, Any]]] = []
    while remaining and len(diverse) < time_diverse:
        reference = [midpoint(candidate) for _, candidate in chosen + diverse]
        if reference:
            next_item = max(
                remaining,
                key=lambda item: (
                    min(abs(midpoint(item[1]) - point) for point in reference),
                    _candidate_score(item[1], score_key),
                    -item[0],
                ),
            )
        else:
            next_item = min(remaining, key=lambda item: (midpoint(item[1]), item[0]))
        diverse.append(next_item)
        remaining.remove(next_item)

    output: list[dict[str, Any]] = []
    for _, candidate in chosen:
        candidate["semantic_selection"] = "top_heuristic"
        output.append(candidate)
    for _, candidate in diverse:
        candidate["semantic_selection"] = "time_diverse"
        output.append(candidate)
    return output


def extract_json_payload(value: Any) -> Any:
    """Decode JSON, including Markdown-fenced model responses."""

    if isinstance(value, Mapping):
        return value
    if isinstance(value, list):
        looks_like_content_parts = bool(value) and all(
            isinstance(item, Mapping) and "text" in item and "candidate_id" not in item and "scores" not in item
            for item in value
        )
        if not looks_like_content_parts:
            return value
        value = "".join(str(item.get("text", "")) for item in value)
    if not isinstance(value, str):
        raise ValueError("provider response content is not JSON text")
    text = value.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*([\s\S]*?)\s*```", text, flags=re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        starts = [position for position, character in enumerate(text) if character in "[{"]
        for position in starts:
            try:
                payload, _ = decoder.raw_decode(text[position:])
                return payload
            except json.JSONDecodeError:
                continue
        raise ValueError("provider returned malformed JSON")


def _clean_string_list(value: Any, name: str, maximum: int) -> list[str]:
    if not isinstance(value, list):
        raise ValueError(f"{name} must be an array")
    output: list[str] = []
    for item in value:
        text = _normalized_text(item)
        if text and text.casefold() not in {existing.casefold() for existing in output}:
            output.append(text)
    return output[:maximum]


def _score_0_to_10(value: Any, name: str) -> float:
    score = _finite_float(value, name)
    if not 0.0 <= score <= 10.0:
        raise ValueError(f"{name} must be between 0 and 10")
    return round(score, 3)


def validate_semantic_results(
    payload: Any,
    *,
    allowed_candidate_ids: Iterable[str] | None = None,
) -> list[dict[str, Any]]:
    """Validate and normalize semantic model candidate scores."""

    payload = extract_json_payload(payload)
    if isinstance(payload, list):
        raw_candidates = payload
    elif isinstance(payload, Mapping):
        raw_candidates = payload.get("candidates", payload.get("results"))
    else:
        raw_candidates = None
    if not isinstance(raw_candidates, list):
        raise ValueError("semantic response must contain a candidates array")
    allowed = set(allowed_candidate_ids) if allowed_candidate_ids is not None else None
    seen: set[str] = set()
    output: list[dict[str, Any]] = []
    for raw in raw_candidates:
        if not isinstance(raw, Mapping):
            raise ValueError("each semantic candidate must be an object")
        candidate_id = _normalized_text(raw.get("candidate_id", raw.get("id")))
        if not candidate_id or candidate_id in seen:
            raise ValueError("semantic candidate IDs must be present and unique")
        if allowed is not None and candidate_id not in allowed:
            raise ValueError(f"semantic response contains unknown candidate ID: {candidate_id}")
        scores = raw.get("scores")
        if not isinstance(scores, Mapping):
            raise ValueError(f"semantic candidate {candidate_id} is missing scores")
        normalized_scores = {
            dimension: _score_0_to_10(scores.get(dimension), f"{candidate_id}.{dimension}")
            for dimension in SEMANTIC_DIMENSIONS
        }
        overall_raw = raw.get("overall_score", raw.get("score"))
        if overall_raw is None:
            overall = round(sum(normalized_scores.values()) / len(normalized_scores), 3)
        else:
            overall = _score_0_to_10(overall_raw, f"{candidate_id}.overall_score")
        output.append({
            "candidate_id": candidate_id,
            "scores": normalized_scores,
            "semantic_score": overall,
            "topics": _clean_string_list(raw.get("topics", []), "topics", 8),
            "reasons": _clean_string_list(raw.get("reasons", []), "reasons", 5),
        })
        seen.add(candidate_id)
    return output


def _safe_http_details(value: Any, limit: int = 500) -> str | None:
    text = _normalized_text(value)
    return text[:limit] if text else None


def _http_error(provider: str, error: BaseException) -> ProviderError:
    if isinstance(error, HTTPError):
        try:
            body = error.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return ProviderError(
            provider=provider,
            code="http_error",
            message=f"{provider} request failed with HTTP {error.code}",
            retryable=error.code == 429 or error.code >= 500,
            http_status=error.code,
            details=_safe_http_details(body),
        )
    if isinstance(error, (URLError, TimeoutError, socket.timeout)):
        reason = getattr(error, "reason", error)
        return ProviderError(
            provider=provider,
            code="network_error",
            message=f"{provider} could not be reached",
            retryable=True,
            details=_safe_http_details(reason),
        )
    return ProviderError(
        provider=provider,
        code="invalid_response",
        message=f"{provider} returned an invalid response",
        retryable=False,
        details=_safe_http_details(error),
    )


def _read_json_response(response: Any) -> Any:
    raw = response.read()
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    return json.loads(raw)


def _join_api_path(base_url: str, suffix: str) -> str:
    parsed = urlparse(base_url.rstrip("/"))
    path = parsed.path.rstrip("/")
    if path.endswith(suffix):
        return urlunparse(parsed)
    if suffix.startswith("/v1/") and path.endswith("/v1"):
        return urlunparse(parsed._replace(path=f"{path}{suffix[3:]}"))
    return urlunparse(parsed._replace(path=f"{path}{suffix}"))


class LocalSemanticClient:
    """OpenAI-compatible chat-completions client for local reranking."""

    provider = "local_semantic"

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        api_key: str | None = None,
        timeout_sec: float = 60.0,
        opener: Callable[..., Any] = urlopen,
    ) -> None:
        if not base_url or not model:
            raise ValueError("base_url and model are required")
        self.endpoint = _join_api_path(base_url, "/v1/chat/completions")
        self.model = model
        self.api_key = api_key
        self.timeout_sec = timeout_sec
        self._opener = opener

    @classmethod
    def from_environment(
        cls,
        env: Mapping[str, str] | None = None,
        *,
        timeout_sec: float = 60.0,
        opener: Callable[..., Any] = urlopen,
    ) -> "LocalSemanticClient":
        """Create a client from the public ``VCF_LOCAL_LLM_*`` settings."""

        values = os.environ if env is None else env
        return cls(
            values.get("VCF_LOCAL_LLM_URL", ""),
            values.get("VCF_LOCAL_LLM_MODEL", ""),
            api_key=values.get("VCF_LOCAL_LLM_API_KEY") or None,
            timeout_sec=timeout_sec,
            opener=opener,
        )

    def build_request_payload(self, candidates: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        compact_candidates = [
            {
                "candidate_id": str(candidate.get("id", candidate.get("candidate_id", ""))),
                "start": candidate.get("start"),
                "end": candidate.get("end"),
                "text": candidate.get("text", ""),
                "context_before": candidate.get("context_before", ""),
                "context_after": candidate.get("context_after", ""),
            }
            for candidate in candidates
        ]
        return {
            "model": self.model,
            "temperature": 0,
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You rank short-form video moments. Score each supplied candidate from 0 to 10 "
                        "for hook, payoff, novelty, standalone_clarity, emotional_arc, quoteability, and "
                        "shareability. Use context_before and context_after only to detect a dependent opening, "
                        "missing setup, or an incomplete ending; score the candidate text itself. Infer concise "
                        "topics from meaning, not a fixed keyword list. Return "
                        "every candidate exactly once as JSON matching the supplied schema."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({"candidates": compact_candidates}, ensure_ascii=False),
                },
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "viral_candidate_scores",
                    "strict": True,
                    "schema": semantic_response_schema(),
                },
            },
        }

    def rank_candidates(self, candidates: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
        candidate_ids = [str(candidate.get("id", candidate.get("candidate_id", ""))) for candidate in candidates]
        if not candidates:
            return []
        if any(not candidate_id for candidate_id in candidate_ids) or len(set(candidate_ids)) != len(candidate_ids):
            raise ValueError("candidate IDs must be present and unique")
        payload = self.build_request_payload(candidates)
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = Request(
            self.endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with self._opener(request, timeout=self.timeout_sec) as response:
                body = _read_json_response(response)
            choices = body.get("choices") if isinstance(body, Mapping) else None
            if not isinstance(choices, list) or not choices:
                raise ValueError("chat completion is missing choices")
            message = choices[0].get("message", {})
            content = message.get("content") if isinstance(message, Mapping) else None
            results = validate_semantic_results(content, allowed_candidate_ids=candidate_ids)
            returned_ids = {result["candidate_id"] for result in results}
            if returned_ids != set(candidate_ids):
                raise ValueError("semantic response did not score every requested candidate")
            return results
        except ProviderError:
            raise
        except (HTTPError, URLError, TimeoutError, socket.timeout) as error:
            raise _http_error(self.provider, error) from error
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise _http_error(self.provider, error) from error


def parse_timestamp(value: Any) -> float:
    """Convert seconds, ``12.5s``, ``MM:SS``, or ``HH:MM:SS`` to seconds."""

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        result = _finite_float(value, "timestamp")
        if result < 0:
            raise ValueError("timestamp cannot be negative")
        return result
    text = _normalized_text(value).lower()
    if text.endswith("s") and ":" not in text:
        text = text[:-1].strip()
    if ":" not in text:
        result = _finite_float(text, "timestamp")
        if result < 0:
            raise ValueError("timestamp cannot be negative")
        return result
    parts = text.split(":")
    if len(parts) not in (2, 3):
        raise ValueError("timestamp must use MM:SS or HH:MM:SS")
    values = [_finite_float(part, "timestamp component") for part in parts]
    if any(value < 0 for value in values) or values[-1] >= 60 or (len(values) == 3 and values[-2] >= 60):
        raise ValueError("timestamp components are out of range")
    if len(values) == 2:
        return values[0] * 60 + values[1]
    return values[0] * 3600 + values[1] * 60 + values[2]


def validate_gemini_candidates(payload: Any, *, duration_sec: float | None = None) -> list[dict[str, Any]]:
    payload = extract_json_payload(payload)
    raw_candidates = payload.get("candidates") if isinstance(payload, Mapping) else payload
    if not isinstance(raw_candidates, list):
        raise ValueError("Gemini response must contain a candidates array")
    duration = _finite_float(duration_sec, "duration") if duration_sec is not None else None
    output: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_candidates):
        if not isinstance(raw, Mapping):
            raise ValueError("each Gemini candidate must be an object")
        start = parse_timestamp(raw.get("start"))
        end = parse_timestamp(raw.get("end"))
        if duration is not None:
            start = min(start, duration)
            end = min(end, duration)
        if end <= start:
            raise ValueError("Gemini candidate end must follow start")
        score = _score_0_to_10(
            raw.get("score", raw.get("gemini_score", raw.get("overall_score"))),
            "Gemini candidate score",
        )
        output.append({
            "id": _normalized_text(raw.get("candidate_id", raw.get("id"))) or f"gemini-{index:04d}",
            "start": round(start, 3),
            "end": round(end, 3),
            "duration": round(end - start, 3),
            "text": _normalized_text(raw.get("summary", raw.get("text", ""))),
            "gemini_score": score,
            "topics": _clean_string_list(raw.get("topics", []), "topics", 8),
            "reasons": _clean_string_list(raw.get("reasons", []), "reasons", 5),
        })
    return output


class _BinaryFileChunks:
    def __init__(self, handle: Any, chunk_size: int = 1024 * 1024) -> None:
        self.handle = handle
        self.chunk_size = chunk_size

    def __iter__(self):
        while True:
            chunk = self.handle.read(self.chunk_size)
            if not chunk:
                return
            yield chunk


class GeminiVideoClient:
    """Isolated Gemini REST client for an uploaded or inline analysis proxy."""

    provider = "gemini"

    def __init__(
        self,
        api_key: str,
        *,
        model: str = "gemini-3.5-flash",
        base_url: str = "https://generativelanguage.googleapis.com/v1beta",
        timeout_sec: float = 180.0,
        opener: Callable[..., Any] = urlopen,
        sleeper: Callable[[float], Any] = time.sleep,
    ) -> None:
        if not api_key:
            raise ValueError("Gemini api_key is required")
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout_sec = timeout_sec
        self._opener = opener
        self._sleeper = sleeper

    @classmethod
    def from_environment(
        cls,
        env: Mapping[str, str] | None = None,
        *,
        model: str = "gemini-3.5-flash",
        base_url: str = "https://generativelanguage.googleapis.com/v1beta",
        timeout_sec: float = 180.0,
        opener: Callable[..., Any] = urlopen,
        sleeper: Callable[[float], Any] = time.sleep,
    ) -> "GeminiVideoClient":
        """Create a client from ``GEMINI_API_KEY`` without exposing the key."""

        values = os.environ if env is None else env
        return cls(
            values.get("GEMINI_API_KEY", ""),
            model=model,
            base_url=base_url,
            timeout_sec=timeout_sec,
            opener=opener,
            sleeper=sleeper,
        )

    def _files_endpoint(self, *, upload: bool = False, name: str | None = None) -> str:
        parsed = urlparse(self.base_url)
        base_path = parsed.path.rstrip("/")
        if name:
            path = f"{base_path}/{name.lstrip('/')}"
        elif upload:
            path = f"/upload{base_path}/files"
        else:
            path = f"{base_path}/files"
        return urlunparse(parsed._replace(path=path, query=f"key={quote(self.api_key, safe='')}"))

    def upload_proxy(
        self,
        media_path: str | os.PathLike[str],
        *,
        mime_type: str | None = None,
        poll_interval_sec: float = 2.0,
    ) -> dict[str, str]:
        """Upload a proxy through Gemini's resumable Files API and wait for ACTIVE."""
        source = Path(media_path).expanduser()
        if not source.is_file():
            raise ValueError(f"Gemini proxy file was not found: {media_path}")
        resolved_mime = mime_type or mimetypes.guess_type(source.name)[0] or "video/mp4"
        metadata = json.dumps({"file": {"display_name": source.name}}).encode("utf-8")
        start_request = Request(
            self._files_endpoint(upload=True),
            data=metadata,
            headers={
                "Content-Type": "application/json",
                "X-Goog-Upload-Protocol": "resumable",
                "X-Goog-Upload-Command": "start",
                "X-Goog-Upload-Header-Content-Length": str(source.stat().st_size),
                "X-Goog-Upload-Header-Content-Type": resolved_mime,
            },
            method="POST",
        )
        try:
            with self._opener(start_request, timeout=self.timeout_sec) as response:
                upload_url = response.headers.get("X-Goog-Upload-URL")
            if not upload_url:
                raise ValueError("Gemini Files API did not return an upload URL")
            with source.open("rb") as media:
                upload_request = Request(
                    upload_url,
                    data=_BinaryFileChunks(media),
                    headers={
                        "Content-Type": resolved_mime,
                        "Content-Length": str(source.stat().st_size),
                        "X-Goog-Upload-Offset": "0",
                        "X-Goog-Upload-Command": "upload, finalize",
                    },
                    method="POST",
                )
                with self._opener(upload_request, timeout=max(self.timeout_sec, 600.0)) as response:
                    body = _read_json_response(response)
            file_info = body.get("file") if isinstance(body, Mapping) else None
            if not isinstance(file_info, Mapping):
                raise ValueError("Gemini Files API returned no file metadata")
            name = _normalized_text(file_info.get("name"))
            uri = _normalized_text(file_info.get("uri"))
            if not name or not uri:
                raise ValueError("Gemini Files API returned incomplete file metadata")
            deadline = time.monotonic() + max(self.timeout_sec, 60.0)
            state = file_info.get("state")
            while isinstance(state, Mapping) or str(state or "").upper() not in {"ACTIVE", "FAILED"}:
                if time.monotonic() >= deadline:
                    raise TimeoutError("Gemini file processing timed out")
                self._sleeper(max(0.05, poll_interval_sec))
                status_request = Request(self._files_endpoint(name=name), method="GET")
                with self._opener(status_request, timeout=self.timeout_sec) as response:
                    file_info = _read_json_response(response)
                state = file_info.get("state") if isinstance(file_info, Mapping) else None
                if isinstance(state, Mapping):
                    state = state.get("name")
            if str(state).upper() == "FAILED":
                raise ValueError("Gemini file processing failed")
            return {"name": name, "uri": uri, "mime_type": resolved_mime}
        except (HTTPError, URLError, TimeoutError, socket.timeout) as error:
            raise _http_error(self.provider, error) from error
        except ProviderError:
            raise
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise _http_error(self.provider, error) from error

    def delete_file(self, name: str) -> None:
        if not name:
            return
        try:
            request = Request(self._files_endpoint(name=name), method="DELETE")
            with self._opener(request, timeout=self.timeout_sec):
                pass
        except Exception:
            # Best-effort cleanup; Gemini files expire automatically.
            return

    def analyze_media_path(
        self,
        media_path: str | os.PathLike[str],
        *,
        duration_sec: float | None = None,
        mime_type: str | None = None,
    ) -> list[dict[str, Any]]:
        uploaded = self.upload_proxy(media_path, mime_type=mime_type)
        try:
            return self.analyze_proxy(
                file_uri=uploaded["uri"],
                mime_type=uploaded["mime_type"],
                duration_sec=duration_sec,
            )
        finally:
            self.delete_file(uploaded["name"])

    def build_request_payload(
        self,
        *,
        file_uri: str | None = None,
        inline_data: bytes | None = None,
        mime_type: str = "video/mp4",
    ) -> dict[str, Any]:
        if bool(file_uri) == bool(inline_data):
            raise ValueError("provide exactly one of file_uri or inline_data")
        media_part: dict[str, Any]
        if file_uri:
            media_part = {"file_data": {"mime_type": mime_type, "file_uri": file_uri}}
        else:
            media_part = {
                "inline_data": {
                    "mime_type": mime_type,
                    "data": base64.b64encode(inline_data or b"").decode("ascii"),
                }
            }
        return {
            "contents": [{
                "role": "user",
                "parts": [
                    media_part,
                    {"text": (
                        "Find timestamped moments with strong short-form viral potential using both audio "
                        "and video. Prefer complete standalone arcs with a hook and payoff. Infer topics. "
                        "Return JSON only, with times relative to this analysis proxy."
                    )},
                ],
            }],
            "generationConfig": {
                "temperature": 0,
                "responseMimeType": "application/json",
                "responseSchema": copy.deepcopy(GEMINI_RESPONSE_SCHEMA),
            },
        }

    def analyze_proxy(
        self,
        *,
        file_uri: str | None = None,
        inline_data: bytes | None = None,
        mime_type: str = "video/mp4",
        duration_sec: float | None = None,
        time_offset_sec: float = 0.0,
    ) -> list[dict[str, Any]]:
        payload = self.build_request_payload(file_uri=file_uri, inline_data=inline_data, mime_type=mime_type)
        endpoint = f"{self.base_url}/models/{quote(self.model, safe='')}:generateContent?key={quote(self.api_key, safe='')}"
        request = Request(
            endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with self._opener(request, timeout=self.timeout_sec) as response:
                body = _read_json_response(response)
            candidates = body.get("candidates") if isinstance(body, Mapping) else None
            if not isinstance(candidates, list) or not candidates:
                raise ValueError("Gemini completion is missing candidates")
            parts = candidates[0].get("content", {}).get("parts", [])
            text = "".join(str(part.get("text", "")) for part in parts if isinstance(part, Mapping))
            results = validate_gemini_candidates(text, duration_sec=duration_sec)
            offset = _finite_float(time_offset_sec, "time offset")
            if offset:
                for result in results:
                    result["start"] = round(result["start"] + offset, 3)
                    result["end"] = round(result["end"] + offset, 3)
            return results
        except ProviderError:
            raise
        except (HTTPError, URLError, TimeoutError, socket.timeout) as error:
            raise _http_error(self.provider, error) from error
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise _http_error(self.provider, error) from error


def ensemble_score(
    heuristic_score: float,
    *,
    semantic_score: float | None = None,
    gemini_score: float | None = None,
) -> tuple[float, dict[str, float]]:
    """Apply the configured local/enhanced ensemble weights on one score scale."""

    heuristic = _finite_float(heuristic_score, "heuristic score")
    semantic = _finite_float(semantic_score, "semantic score") if semantic_score is not None else None
    gemini = _finite_float(gemini_score, "Gemini score") if gemini_score is not None else None
    if gemini is not None and semantic is not None:
        weights = {"heuristic": 0.35, "semantic": 0.25, "gemini": 0.40}
    elif gemini is not None:
        weights = {"heuristic": 0.60, "semantic": 0.0, "gemini": 0.40}
    elif semantic is not None:
        weights = {"heuristic": 0.55, "semantic": 0.45, "gemini": 0.0}
    else:
        weights = {"heuristic": 1.0, "semantic": 0.0, "gemini": 0.0}
    total = heuristic * weights["heuristic"]
    if semantic is not None:
        total += semantic * weights["semantic"]
    if gemini is not None:
        total += gemini * weights["gemini"]
    return round(total, 3), weights


def temporal_iou(first: Mapping[str, Any], second: Mapping[str, Any]) -> float:
    first_start = float(first["start"])
    first_end = float(first["end"])
    second_start = float(second["start"])
    second_end = float(second["end"])
    intersection = max(0.0, min(first_end, second_end) - max(first_start, second_start))
    union = max(first_end, second_end) - min(first_start, second_start)
    return intersection / union if union > 0 else 0.0


def _merged_strings(first: Any, second: Any, limit: int) -> list[str]:
    values = list(first or []) + list(second or [])
    output: list[str] = []
    for value in values:
        text = _normalized_text(value)
        if text and text.casefold() not in {item.casefold() for item in output}:
            output.append(text)
    return output[:limit]


def dedupe_temporal_candidates(
    candidates: Sequence[Mapping[str, Any]],
    *,
    iou_threshold: float = 0.65,
    score_key: str = "ensemble_score",
) -> list[dict[str, Any]]:
    """Remove temporal duplicates, merging loser topics into the top score."""

    threshold = _finite_float(iou_threshold, "IoU threshold")
    if not 0 <= threshold <= 1:
        raise ValueError("IoU threshold must be between 0 and 1")
    ranked = sorted(
        (copy.deepcopy(dict(candidate)) for candidate in candidates),
        key=lambda candidate: (-_candidate_score(candidate, score_key), float(candidate.get("start", 0.0))),
    )
    retained: list[dict[str, Any]] = []
    for candidate in ranked:
        duplicate = next((item for item in retained if temporal_iou(candidate, item) >= threshold), None)
        if duplicate is None:
            candidate.setdefault("topics", [])
            candidate.setdefault("reasons", [])
            candidate.setdefault("merged_candidate_ids", [])
            retained.append(candidate)
            continue
        duplicate["topics"] = _merged_strings(duplicate.get("topics"), candidate.get("topics"), 12)
        duplicate["reasons"] = _merged_strings(duplicate.get("reasons"), candidate.get("reasons"), 8)
        merged_ids = list(duplicate.get("merged_candidate_ids", []))
        candidate_id = candidate.get("id", candidate.get("candidate_id"))
        if candidate_id and candidate_id not in merged_ids:
            merged_ids.append(candidate_id)
        merged_ids.extend(value for value in candidate.get("merged_candidate_ids", []) if value not in merged_ids)
        duplicate["merged_candidate_ids"] = merged_ids
    return retained


def provider_success_metadata(provider: str, *, model: str | None = None) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "provider": provider,
        "status": "success",
        "fallback": {"used": False},
    }
    if model:
        metadata["model"] = model
    return metadata


def provider_failure_metadata(
    error: ProviderError,
    *,
    fallback_provider: str | None = None,
    fallback_status: str = "pending",
) -> dict[str, Any]:
    metadata = error.to_dict()
    metadata["fallback"] = {
        "used": fallback_provider is not None,
        "provider": fallback_provider,
        "status": fallback_status if fallback_provider is not None else "not_configured",
    }
    return metadata


def call_with_fallback(
    primary_call: Callable[[], Any],
    fallback_call: Callable[[], Any],
    *,
    primary_provider: str,
    fallback_provider: str,
    primary_model: str | None = None,
) -> tuple[Any, dict[str, Any]]:
    """Run an optional provider and record a normalized local fallback event."""

    try:
        result = primary_call()
        return result, provider_success_metadata(primary_provider, model=primary_model)
    except ProviderError as error:
        try:
            result = fallback_call()
        except Exception as fallback_error:
            metadata = provider_failure_metadata(
                error,
                fallback_provider=fallback_provider,
                fallback_status="failed",
            )
            metadata["fallback"]["error"] = {
                "code": "fallback_failed",
                "message": _safe_http_details(fallback_error) or "Fallback failed",
            }
            raise ProviderError(
                provider=primary_provider,
                code="fallback_failed",
                message="Primary provider and fallback both failed",
                retryable=error.retryable,
                details=json.dumps(metadata, sort_keys=True),
            ) from fallback_error
        return result, provider_failure_metadata(
            error,
            fallback_provider=fallback_provider,
            fallback_status="success",
        )
