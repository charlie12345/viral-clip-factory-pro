#!/usr/bin/env python3
"""Silence analysis helpers for non-destructive long-form editing.

The module deliberately has no project or third-party imports so the dashboard
can run analysis without loading Whisper, Torch, or the video rendering stack.
All public times are seconds on the original source timeline.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from collections.abc import Iterable, Mapping, Sequence
from typing import Any


_SILENCE_EVENT_RE = re.compile(
    r"silence_(start|end):\s*"
    r"([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)"
)
_TIME_EPSILON = 1e-7


def _as_finite_float(value: Any, label: str) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be a number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{label} must be finite")
    return result


def _time(value: float) -> float:
    """Keep API output stable without discarding useful sub-frame precision."""
    return round(float(value), 6)


def _run(
    command: list[str],
    *,
    timeout: float | None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def probe_duration(
    source: str,
    *,
    ffprobe_bin: str = "ffprobe",
    timeout: float = 30,
) -> float:
    """Return source duration in seconds using format and stream metadata."""
    command = [
        ffprobe_bin,
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=duration",
        "-of",
        "json",
        source,
    ]
    try:
        result = _run(command, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"ffprobe timed out while reading {source}") from exc
    except OSError as exc:
        raise RuntimeError(f"Could not start ffprobe ({ffprobe_bin}): {exc}") from exc

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "ffprobe failed").strip()
        raise RuntimeError(f"Could not probe duration for {source}: {detail}")

    try:
        payload = json.loads(result.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError("ffprobe returned invalid JSON") from exc

    candidates: list[float] = []
    raw_values = [payload.get("format", {}).get("duration")]
    raw_values.extend(stream.get("duration") for stream in payload.get("streams", []))
    for value in raw_values:
        try:
            duration = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(duration) and duration >= 0:
            candidates.append(duration)

    if not candidates:
        raise RuntimeError(f"ffprobe did not report a duration for {source}")
    return max(candidates)


def parse_silencedetect(stderr: str) -> list[dict[str, Any]]:
    """Parse FFmpeg ``silencedetect`` events on its zero-based filter clock.

    FFmpeg can emit an ``end`` without a preceding ``start`` when the selected
    range begins in silence. Such an interval starts at zero. A trailing
    ``start`` without an ``end`` is retained with ``end=None`` so the caller can
    close it at the known analysis boundary.
    """
    intervals: list[dict[str, Any]] = []
    open_start: float | None = None

    for match in _SILENCE_EVENT_RE.finditer(stderr or ""):
        event, raw_value = match.groups()
        value = float(raw_value)
        if not math.isfinite(value):
            continue
        value = max(0.0, value)

        if event == "start":
            if open_start is None:
                open_start = value
            else:
                # Duplicate starts can appear in damaged logs. Keep the first
                # boundary so detected silence is not accidentally shortened.
                open_start = min(open_start, value)
            continue

        start = 0.0 if open_start is None else open_start
        if value > start + _TIME_EPSILON:
            intervals.append({"start": _time(start), "end": _time(value), "enabled": True})
        open_start = None

    if open_start is not None:
        intervals.append({"start": _time(open_start), "end": None, "enabled": True})
    return intervals


def run_silencedetect(
    source: str,
    *,
    threshold_db: float = -35.0,
    min_silence_sec: float = 0.5,
    selected_start: float = 0.0,
    selected_end: float | None = None,
    ffmpeg_bin: str = "ffmpeg",
    timeout: float | None = 3600,
) -> list[dict[str, Any]]:
    """Run FFmpeg silence detection and return source-timeline intervals."""
    threshold_db = _as_finite_float(threshold_db, "threshold_db")
    min_silence_sec = _as_finite_float(min_silence_sec, "min_silence_sec")
    selected_start = _as_finite_float(selected_start, "selected_start")
    if min_silence_sec <= 0:
        raise ValueError("min_silence_sec must be greater than zero")
    if selected_start < 0:
        raise ValueError("selected_start cannot be negative")

    duration: float | None = None
    if selected_end is not None:
        selected_end = _as_finite_float(selected_end, "selected_end")
        if selected_end <= selected_start:
            raise ValueError("selected_end must be greater than selected_start")
        duration = selected_end - selected_start

    command = [ffmpeg_bin, "-hide_banner", "-nostdin", "-v", "info"]
    if selected_start > 0:
        command.extend(["-ss", f"{selected_start:.6f}"])
    command.extend(["-i", source])
    if duration is not None:
        command.extend(["-t", f"{duration:.6f}"])
    filter_value = (
        "asetpts=N/SR/TB,"
        f"silencedetect=noise={threshold_db:.6g}dB:d={min_silence_sec:.6g}"
    )
    command.extend(
        [
            "-map",
            "0:a:0",
            "-vn",
            "-sn",
            "-dn",
            "-af",
            filter_value,
            "-f",
            "null",
            "-",
        ]
    )

    try:
        result = _run(command, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"FFmpeg silence analysis timed out for {source}") from exc
    except OSError as exc:
        raise RuntimeError(f"Could not start FFmpeg ({ffmpeg_bin}): {exc}") from exc

    if result.returncode != 0:
        lines = (result.stderr or result.stdout or "FFmpeg failed").strip().splitlines()
        detail = "\n".join(lines[-8:])
        raise RuntimeError(f"FFmpeg silence analysis failed for {source}:\n{detail}")

    parsed = parse_silencedetect(result.stderr)
    shifted: list[dict[str, Any]] = []
    for interval in parsed:
        end = interval["end"]
        shifted.append(
            {
                "start": _time(selected_start + float(interval["start"])),
                "end": None if end is None else _time(selected_start + float(end)),
                "enabled": bool(interval.get("enabled", True)),
            }
        )
    return shifted


def _cut_values(cut: Mapping[str, Any] | Sequence[Any]) -> tuple[Any, Any, bool, Any]:
    if isinstance(cut, Mapping):
        start = cut.get("start", cut.get("start_sec"))
        end = cut.get("end", cut.get("end_sec"))
        enabled = bool(cut.get("enabled", True))
        cut_id = cut.get("id")
        return start, end, enabled, cut_id
    if isinstance(cut, Sequence) and not isinstance(cut, (str, bytes)) and len(cut) >= 2:
        enabled = bool(cut[2]) if len(cut) >= 3 else True
        return cut[0], cut[1], enabled, None
    raise ValueError("Each silence cut must provide start and end times")


def normalize_silence_cuts(
    cuts: Iterable[Mapping[str, Any] | Sequence[Any]],
    *,
    selected_start: float,
    selected_end: float,
    edge_padding_sec: float = 0.08,
) -> list[dict[str, Any]]:
    """Clamp cuts to the selection and preserve room tone beside speech.

    Padding shrinks internal removal intervals at both edges. At the beginning
    or end of a selection, only the edge next to retained speech is padded; this
    avoids leaving an isolated sliver of silence before or after the program.
    """
    selected_start = _as_finite_float(selected_start, "selected_start")
    selected_end = _as_finite_float(selected_end, "selected_end")
    edge_padding_sec = _as_finite_float(edge_padding_sec, "edge_padding_sec")
    if selected_end <= selected_start:
        raise ValueError("selected_end must be greater than selected_start")
    if edge_padding_sec < 0:
        raise ValueError("edge_padding_sec cannot be negative")

    normalized: list[dict[str, Any]] = []
    for source_index, cut in enumerate(cuts):
        raw_start, raw_end, enabled, cut_id = _cut_values(cut)
        start = selected_start if raw_start is None else _as_finite_float(raw_start, "cut start")
        end = selected_end if raw_end is None else _as_finite_float(raw_end, "cut end")
        start = max(selected_start, min(selected_end, start))
        end = max(selected_start, min(selected_end, end))
        if end <= start + _TIME_EPSILON:
            continue

        detected_start = start
        detected_end = end
        if start > selected_start + _TIME_EPSILON:
            start += edge_padding_sec
        if end < selected_end - _TIME_EPSILON:
            end -= edge_padding_sec
        start = min(start, selected_end)
        end = max(end, selected_start)
        if end <= start + _TIME_EPSILON:
            continue

        normalized.append(
            {
                "id": str(cut_id if cut_id is not None else f"silence-{source_index + 1}"),
                "index": len(normalized),
                "start": _time(start),
                "end": _time(end),
                "duration": _time(end - start),
                "detected_start": _time(detected_start),
                "detected_end": _time(detected_end),
                "enabled": enabled,
            }
        )
    normalized.sort(key=lambda item: (item["start"], item["end"]))
    for index, item in enumerate(normalized):
        item["index"] = index
    return normalized


def cuts_to_keep_segments(
    cuts: Iterable[Mapping[str, Any] | Sequence[Any]],
    *,
    selected_start: float,
    selected_end: float,
) -> list[dict[str, float]]:
    """Return the complement of enabled cuts within the selected range."""
    selected_start = _as_finite_float(selected_start, "selected_start")
    selected_end = _as_finite_float(selected_end, "selected_end")
    if selected_end <= selected_start:
        raise ValueError("selected_end must be greater than selected_start")

    enabled_ranges: list[tuple[float, float]] = []
    for cut in cuts:
        raw_start, raw_end, enabled, _ = _cut_values(cut)
        if not enabled:
            continue
        start = selected_start if raw_start is None else _as_finite_float(raw_start, "cut start")
        end = selected_end if raw_end is None else _as_finite_float(raw_end, "cut end")
        start = max(selected_start, min(selected_end, start))
        end = max(selected_start, min(selected_end, end))
        if end > start + _TIME_EPSILON:
            enabled_ranges.append((start, end))

    enabled_ranges.sort()
    merged: list[list[float]] = []
    for start, end in enabled_ranges:
        if not merged or start > merged[-1][1] + _TIME_EPSILON:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)

    keep: list[dict[str, float]] = []
    cursor = selected_start
    for start, end in merged:
        if start > cursor + _TIME_EPSILON:
            keep.append(
                {
                    "start": _time(cursor),
                    "end": _time(start),
                    "duration": _time(start - cursor),
                }
            )
        cursor = max(cursor, end)
    if cursor < selected_end - _TIME_EPSILON:
        keep.append(
            {
                "start": _time(cursor),
                "end": _time(selected_end),
                "duration": _time(selected_end - cursor),
            }
        )
    return keep


def remap_source_time(
    source_time: float,
    keep_segments: Iterable[Mapping[str, Any] | Sequence[Any]],
    *,
    snap_removed_to_next: bool = False,
    transition_durations: Iterable[float] | None = None,
) -> float | None:
    """Map an original-source timestamp onto the edited output timeline."""
    timestamp = _as_finite_float(source_time, "source_time")
    output_cursor = 0.0
    overlaps = [
        max(0.0, _as_finite_float(value, "transition duration"))
        for value in (transition_durations or [])
    ]
    for index, segment in enumerate(keep_segments):
        if isinstance(segment, Mapping):
            start = _as_finite_float(segment.get("start"), "segment start")
            end = _as_finite_float(segment.get("end"), "segment end")
        elif isinstance(segment, Sequence) and not isinstance(segment, (str, bytes)) and len(segment) >= 2:
            start = _as_finite_float(segment[0], "segment start")
            end = _as_finite_float(segment[1], "segment end")
        else:
            raise ValueError("Each keep segment must provide start and end times")
        if end <= start:
            continue
        if timestamp < start:
            return _time(output_cursor) if snap_removed_to_next else None
        if timestamp <= end + _TIME_EPSILON:
            return _time(output_cursor + max(0.0, min(end, timestamp) - start))
        output_cursor += end - start
        if index < len(overlaps):
            output_cursor = max(0.0, output_cursor - overlaps[index])
    return None


def remap_words_to_edits(
    words: Iterable[Mapping[str, Any]],
    keep_segments: Iterable[Mapping[str, Any] | Sequence[Any]],
    *,
    transition_durations: Iterable[float] | None = None,
) -> list[dict[str, Any]]:
    """Drop removed words and translate retained word timestamps to output time."""
    segments = list(keep_segments)
    overlaps = list(transition_durations or [])
    output: list[dict[str, Any]] = []
    for word in words:
        text = str(word.get("word", "")).strip()
        if not text:
            continue
        start = remap_source_time(
            word.get("start", 0.0),
            segments,
            transition_durations=overlaps,
        )
        end = remap_source_time(
            word.get("end", word.get("start", 0.0)),
            segments,
            transition_durations=overlaps,
        )
        if start is None or end is None or end <= start:
            continue
        output.append({**dict(word), "word": text, "start": start, "end": end})
    return output


def _subtitle_timestamp(seconds: float, *, vtt: bool) -> str:
    milliseconds = max(0, int(round(float(seconds) * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    separator = "." if vtt else ","
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{separator}{millis:03d}"


def _word_cues(words: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    cues: list[dict[str, Any]] = []
    current: list[Mapping[str, Any]] = []
    for word in words:
        if current and float(word["start"]) - float(current[-1]["end"]) > 0.8:
            cues.append({
                "start": float(current[0]["start"]),
                "end": float(current[-1]["end"]),
                "text": " ".join(str(item["word"]) for item in current),
            })
            current = []
        current.append(word)
        duration = float(current[-1]["end"]) - float(current[0]["start"])
        ends_sentence = bool(re.search(r"[.!?][\"']?$", str(word["word"])))
        if len(current) >= 10 or duration >= 4.5 or (ends_sentence and len(current) >= 4):
            cues.append({
                "start": float(current[0]["start"]),
                "end": float(current[-1]["end"]),
                "text": " ".join(str(item["word"]) for item in current),
            })
            current = []
    if current:
        cues.append({
            "start": float(current[0]["start"]),
            "end": float(current[-1]["end"]),
            "text": " ".join(str(item["word"]) for item in current),
        })
    return cues


def write_longform_sidecars(
    output_path: str,
    *,
    words: Iterable[Mapping[str, Any]],
    chapters: Iterable[Mapping[str, Any]],
    keep_segments: Iterable[Mapping[str, Any] | Sequence[Any]],
    transition_durations: Iterable[float] | None = None,
    caption_cues: Iterable[Mapping[str, Any]] | None = None,
) -> dict[str, str]:
    """Write edited transcript, SRT/VTT captions, and YouTube chapter text."""
    base, _ = os.path.splitext(output_path)
    segments = list(keep_segments)
    overlaps = list(transition_durations or [])
    edited_words = remap_words_to_edits(
        words,
        segments,
        transition_durations=overlaps,
    )
    written: dict[str, str] = {}
    if edited_words:
        transcript_path = f"{base}.transcript.txt"
        with open(transcript_path, "w", encoding="utf-8") as handle:
            handle.write(" ".join(str(word["word"]) for word in edited_words).strip() + "\n")
        written["transcript"] = transcript_path

    custom_cues = []
    for cue in caption_cues or []:
        text = str(cue.get("text") or "").strip()
        if not text:
            continue
        mapped_start = remap_source_time(
            cue.get("start", 0.0),
            segments,
            snap_removed_to_next=True,
            transition_durations=overlaps,
        )
        mapped_end = remap_source_time(
            cue.get("end", cue.get("start", 0.0)),
            segments,
            snap_removed_to_next=True,
            transition_durations=overlaps,
        )
        if mapped_start is None or mapped_end is None or mapped_end - mapped_start < 0.02:
            continue
        speaker = str(cue.get("speaker") or "").strip()
        custom_cues.append({
            "start": mapped_start,
            "end": mapped_end,
            "text": f"{speaker}: {text}" if speaker else text,
        })
    cues = custom_cues or _word_cues(edited_words)
    if cues:
        srt_path = f"{base}.srt"
        with open(srt_path, "w", encoding="utf-8") as handle:
            for index, cue in enumerate(cues, 1):
                handle.write(
                    f"{index}\n{_subtitle_timestamp(cue['start'], vtt=False)} --> "
                    f"{_subtitle_timestamp(cue['end'], vtt=False)}\n{cue['text']}\n\n"
                )
        written["srt"] = srt_path

        vtt_path = f"{base}.vtt"
        with open(vtt_path, "w", encoding="utf-8") as handle:
            handle.write("WEBVTT\n\n")
            for cue in cues:
                handle.write(
                    f"{_subtitle_timestamp(cue['start'], vtt=True)} --> "
                    f"{_subtitle_timestamp(cue['end'], vtt=True)}\n{cue['text']}\n\n"
                )
        written["vtt"] = vtt_path

    chapter_rows: list[tuple[float, str]] = []
    for index, chapter in enumerate(chapters):
        mapped = remap_source_time(
            chapter.get("time", 0.0),
            segments,
            snap_removed_to_next=True,
            transition_durations=overlaps,
        )
        title = str(chapter.get("title") or f"Chapter {index + 1}").strip()
        if mapped is not None and title:
            chapter_rows.append((mapped, title))
    if chapter_rows:
        chapters_path = f"{base}.chapters.txt"
        with open(chapters_path, "w", encoding="utf-8") as handle:
            for timestamp, title in sorted(chapter_rows):
                total = max(0, int(timestamp))
                hours, remainder = divmod(total, 3600)
                minutes, seconds = divmod(remainder, 60)
                label = f"{hours}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes}:{seconds:02d}"
                handle.write(f"{label} {title}\n")
        written["chapters"] = chapters_path
    return written


def summarize_analysis(
    source: str,
    *,
    original_duration_sec: float,
    selected_start: float,
    selected_end: float,
    cuts: Iterable[Mapping[str, Any] | Sequence[Any]],
    threshold_db: float,
    min_silence_sec: float,
    edge_padding_sec: float,
) -> dict[str, Any]:
    """Build the JSON contract shared by the CLI, API, and editor."""
    original_duration_sec = _as_finite_float(original_duration_sec, "original_duration_sec")
    selected_start = _as_finite_float(selected_start, "selected_start")
    selected_end = _as_finite_float(selected_end, "selected_end")
    cut_list = [dict(cut) if isinstance(cut, Mapping) else cut for cut in cuts]
    keep_segments = cuts_to_keep_segments(
        cut_list,
        selected_start=selected_start,
        selected_end=selected_end,
    )
    selected_duration = selected_end - selected_start
    estimated_duration = sum(segment["duration"] for segment in keep_segments)
    removed_duration = max(0.0, selected_duration - estimated_duration)
    enabled_count = sum(
        1
        for cut in cut_list
        if (bool(cut.get("enabled", True)) if isinstance(cut, Mapping) else (bool(cut[2]) if len(cut) >= 3 else True))
    )

    return {
        "source": source,
        "options": {
            "threshold_db": _time(_as_finite_float(threshold_db, "threshold_db")),
            "min_silence_sec": _time(_as_finite_float(min_silence_sec, "min_silence_sec")),
            "edge_padding_sec": _time(_as_finite_float(edge_padding_sec, "edge_padding_sec")),
            "selected_start_sec": _time(selected_start),
            "selected_end_sec": _time(selected_end),
        },
        "original_duration_sec": _time(original_duration_sec),
        "selected_duration_sec": _time(selected_duration),
        "removed_duration_sec": _time(removed_duration),
        "estimated_duration_sec": _time(estimated_duration),
        "join_count": max(0, len(keep_segments) - 1),
        "cut_count": len(cut_list),
        "enabled_cut_count": enabled_count,
        "cuts": cut_list,
        "keep_segments": keep_segments,
    }


def _selection_bounds(
    original_duration: float,
    selected_start: float,
    selected_end: float | None,
) -> tuple[float, float]:
    selected_start = _as_finite_float(selected_start, "selected_start")
    if selected_end is None:
        selected_end = original_duration
    else:
        selected_end = _as_finite_float(selected_end, "selected_end")
    start = max(0.0, min(original_duration, selected_start))
    end = max(0.0, min(original_duration, selected_end))
    if end <= start + _TIME_EPSILON:
        raise ValueError("The selected range must have a positive duration")
    return start, end


def analyze_source(
    source: str,
    *,
    threshold_db: float = -35.0,
    min_silence_sec: float = 0.5,
    edge_padding_sec: float = 0.08,
    selected_start: float = 0.0,
    selected_end: float | None = None,
    enabled_cut_indices: Iterable[int] | None = None,
    disabled_cut_indices: Iterable[int] | None = None,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    timeout: float | None = 3600,
) -> dict[str, Any]:
    """Analyze one source and return cuts, keep segments, and duration totals."""
    if enabled_cut_indices is not None and disabled_cut_indices is not None:
        raise ValueError("Use enabled_cut_indices or disabled_cut_indices, not both")
    original_duration = probe_duration(source, ffprobe_bin=ffprobe_bin)
    start, end = _selection_bounds(original_duration, selected_start, selected_end)
    raw_cuts = run_silencedetect(
        source,
        threshold_db=threshold_db,
        min_silence_sec=min_silence_sec,
        selected_start=start,
        selected_end=end,
        ffmpeg_bin=ffmpeg_bin,
        timeout=timeout,
    )
    cuts = normalize_silence_cuts(
        raw_cuts,
        selected_start=start,
        selected_end=end,
        edge_padding_sec=edge_padding_sec,
    )

    if enabled_cut_indices is not None:
        enabled = {int(index) for index in enabled_cut_indices}
        for index, cut in enumerate(cuts):
            cut["enabled"] = index in enabled
    elif disabled_cut_indices is not None:
        disabled = {int(index) for index in disabled_cut_indices}
        for index, cut in enumerate(cuts):
            cut["enabled"] = index not in disabled

    return summarize_analysis(
        source,
        original_duration_sec=original_duration,
        selected_start=start,
        selected_end=end,
        cuts=cuts,
        threshold_db=threshold_db,
        min_silence_sec=min_silence_sec,
        edge_padding_sec=edge_padding_sec,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Long-form silence analysis")
    subparsers = parser.add_subparsers(dest="command", required=True)
    analyze_parser = subparsers.add_parser("analyze", help="Detect removable silence")
    analyze_parser.add_argument("source", help="Source media path")
    analyze_parser.add_argument("--threshold-db", type=float, default=-35.0)
    analyze_parser.add_argument("--min-silence-sec", type=float, default=0.5)
    analyze_parser.add_argument("--edge-padding-sec", type=float, default=0.08)
    analyze_parser.add_argument("--start-sec", type=float, default=0.0)
    analyze_parser.add_argument("--end-sec", type=float)
    analyze_parser.add_argument(
        "--disable-cut",
        action="append",
        type=int,
        default=None,
        metavar="INDEX",
        help="Keep a detected silence interval by its zero-based index (repeatable)",
    )
    analyze_parser.add_argument("--ffmpeg", default="ffmpeg", dest="ffmpeg_bin")
    analyze_parser.add_argument("--ffprobe", default="ffprobe", dest="ffprobe_bin")
    analyze_parser.add_argument("--timeout", type=float, default=3600)
    analyze_parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "analyze":
            result = analyze_source(
                args.source,
                threshold_db=args.threshold_db,
                min_silence_sec=args.min_silence_sec,
                edge_padding_sec=args.edge_padding_sec,
                selected_start=args.start_sec,
                selected_end=args.end_sec,
                disabled_cut_indices=args.disable_cut,
                ffmpeg_bin=args.ffmpeg_bin,
                ffprobe_bin=args.ffprobe_bin,
                timeout=args.timeout,
            )
        else:  # pragma: no cover - argparse enforces the command choices.
            raise ValueError(f"Unknown command: {args.command}")
    except (OSError, RuntimeError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1

    indent = 2 if args.pretty else None
    print(json.dumps(result, indent=indent, sort_keys=bool(indent)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
