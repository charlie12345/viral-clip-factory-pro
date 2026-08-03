#!/usr/bin/env python3
"""Professional long-form editor analysis tools.

The commands in this module are intentionally independent from Whisper/Torch.
They provide deterministic frame sampling for automatic grades, lightweight
tracking, background-key suggestions, audio alignment, and automated QC.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Sequence

import cv2
import numpy as np


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, float(value)))


def _run(command: list[str], timeout: float = 120.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def _probe(source: str, ffprobe_bin: str = "ffprobe") -> dict[str, Any]:
    result = _run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,"
            "sample_rate,channels,color_space,color_transfer,color_primaries,pix_fmt",
            "-of",
            "json",
            source,
        ],
        timeout=30,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "ffprobe failed").strip())
    payload = json.loads(result.stdout or "{}")
    duration = _finite(payload.get("format", {}).get("duration"), 0)
    return {"duration": duration, **payload}


@dataclass
class SampledFrame:
    time: float
    frame: np.ndarray


def _sample_frames(
    source: str,
    *,
    start: float = 0.0,
    end: float | None = None,
    count: int = 36,
) -> list[SampledFrame]:
    capture = cv2.VideoCapture(source)
    if not capture.isOpened():
        raise RuntimeError(f"Could not open video: {source}")
    try:
        duration = _finite(capture.get(cv2.CAP_PROP_FRAME_COUNT), 0) / max(
            0.001, _finite(capture.get(cv2.CAP_PROP_FPS), 30)
        )
        start = _clamp(start, 0, max(0, duration))
        end = _clamp(duration if end is None else end, start, max(start, duration))
        if end <= start + 0.001:
            end = min(duration, start + 0.05)
        positions = np.linspace(start, end, max(1, min(240, int(count))), endpoint=False)
        output: list[SampledFrame] = []
        for position in positions:
            capture.set(cv2.CAP_PROP_POS_MSEC, float(position) * 1000)
            ok, frame = capture.read()
            if not ok or frame is None or frame.size == 0:
                continue
            max_side = max(frame.shape[:2])
            if max_side > 960:
                scale = 960 / max_side
                frame = cv2.resize(frame, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
            output.append(SampledFrame(float(position), frame))
        return output
    finally:
        capture.release()


def auto_grade(
    source: str,
    *,
    start: float = 0.0,
    end: float | None = None,
    sample_count: int = 36,
) -> dict[str, Any]:
    samples = _sample_frames(source, start=start, end=end, count=sample_count)
    if not samples:
        raise RuntimeError("No decodable frames were available for automatic grading")

    luma_values: list[np.ndarray] = []
    saturation_values: list[np.ndarray] = []
    channel_means: list[np.ndarray] = []
    for sample in samples:
        small = cv2.resize(sample.frame, (256, 144), interpolation=cv2.INTER_AREA)
        yuv = cv2.cvtColor(small, cv2.COLOR_BGR2YUV)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        luma_values.append(yuv[:, :, 0].astype(np.float32) / 255.0)
        saturation_values.append(hsv[:, :, 1].astype(np.float32) / 255.0)
        channel_means.append(np.mean(small.reshape(-1, 3), axis=0))

    luma = np.concatenate([item.reshape(-1) for item in luma_values])
    saturation = np.concatenate([item.reshape(-1) for item in saturation_values])
    channels = np.mean(np.stack(channel_means), axis=0)
    p01, p05, p50, p95, p99 = [float(np.percentile(luma, value)) for value in (1, 5, 50, 95, 99)]
    mean_luma = float(np.mean(luma))
    mean_saturation = float(np.mean(saturation))
    dynamic_range = max(0.02, p95 - p05)

    target_luma = 0.47
    exposure = _clamp((target_luma - mean_luma) * 0.72, -0.30, 0.30)
    contrast = _clamp(0.66 / dynamic_range, 0.78, 1.32)
    saturation_gain = _clamp(0.34 / max(0.08, mean_saturation), 0.82, 1.28)
    vibrance = _clamp((0.33 - mean_saturation) * 0.65, -0.18, 0.22)
    gamma = _clamp(1.0 + (0.46 - p50) * 0.48, 0.82, 1.20)
    shadows = _clamp((0.06 - p05) * 2.1, -0.20, 0.24)
    highlights = _clamp((0.94 - p95) * 1.5, -0.25, 0.18)

    blue, green, red = [float(value) for value in channels]
    temperature = _clamp((blue - red) / 255.0 * 1.15, -0.36, 0.36)
    tint = _clamp((((red + blue) / 2.0) - green) / 255.0 * 1.2, -0.30, 0.30)
    clipped_black = float(np.mean(luma <= 16 / 255))
    clipped_white = float(np.mean(luma >= 235 / 255))
    flatness = 1.0 - _clamp(dynamic_range / 0.72, 0, 1)
    detected_input = "log_like" if dynamic_range < 0.48 and clipped_black < 0.002 and clipped_white < 0.002 else "rec709"
    confidence = _clamp(
        0.45
        + min(0.30, len(samples) / max(1, sample_count) * 0.30)
        + min(0.15, dynamic_range * 0.20)
        - min(0.18, (clipped_black + clipped_white) * 1.5),
        0.2,
        0.98,
    )

    return {
        "grade": {
            "exposure": round(exposure, 4),
            "contrast": round(contrast, 4),
            "saturation": round(saturation_gain, 4),
            "vibrance": round(vibrance, 4),
            "gamma": round(gamma, 4),
            "highlights": round(highlights, 4),
            "shadows": round(shadows, 4),
            "temperature": round(temperature, 4),
            "tint": round(tint, 4),
            "sharpen": 0.08 if dynamic_range > 0.55 else 0.0,
        },
        "metrics": {
            "meanLuma": round(mean_luma, 4),
            "medianLuma": round(p50, 4),
            "p01": round(p01, 4),
            "p05": round(p05, 4),
            "p95": round(p95, 4),
            "p99": round(p99, 4),
            "dynamicRange": round(dynamic_range, 4),
            "meanSaturation": round(mean_saturation, 4),
            "clippedBlackPct": round(clipped_black * 100, 4),
            "clippedWhitePct": round(clipped_white * 100, 4),
            "flatness": round(flatness, 4),
            "sampleCount": len(samples),
            "detectedInput": detected_input,
        },
        "confidence": round(confidence, 4),
        "analyzedAt": datetime.now(UTC).isoformat(),
    }


def suggest_background_key(
    source: str,
    *,
    time_sec: float = 0.0,
) -> dict[str, Any]:
    samples = _sample_frames(source, start=time_sec, end=time_sec + 0.05, count=1)
    if not samples:
        raise RuntimeError("Could not decode the requested frame")
    frame = samples[0].frame
    height, width = frame.shape[:2]
    border = max(2, int(min(width, height) * 0.04))
    pixels = np.concatenate(
        [
            frame[:border, :, :].reshape(-1, 3),
            frame[-border:, :, :].reshape(-1, 3),
            frame[:, :border, :].reshape(-1, 3),
            frame[:, -border:, :].reshape(-1, 3),
        ],
        axis=0,
    )
    median = np.median(pixels, axis=0)
    distances = np.linalg.norm(pixels.astype(np.float32) - median.astype(np.float32), axis=1)
    confidence = 1.0 - _clamp(float(np.median(distances)) / 90.0, 0, 1)
    blue, green, red = [int(round(value)) for value in median]
    return {
        "color": f"#{red:02X}{green:02X}{blue:02X}",
        "similarity": round(_clamp(0.10 + (1.0 - confidence) * 0.18, 0.08, 0.35), 3),
        "blend": round(_clamp(0.05 + (1.0 - confidence) * 0.10, 0.03, 0.18), 3),
        "confidence": round(confidence, 4),
        "time": round(time_sec, 4),
    }


def _detect_face(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    detector = cv2.CascadeClassifier(cascade_path)
    if detector.empty():
        return None
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    faces = detector.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(24, 24))
    if len(faces) == 0:
        return None
    height, width = frame.shape[:2]
    center_x, center_y = width / 2, height / 2
    return min(
        (tuple(int(value) for value in face) for face in faces),
        key=lambda face: ((face[0] + face[2] / 2) - center_x) ** 2 + ((face[1] + face[3] / 2) - center_y) ** 2,
    )


def track_region(
    source: str,
    *,
    start: float,
    end: float,
    x: float,
    y: float,
    width: float,
    height: float,
    face: bool = False,
    interval: float = 0.25,
) -> dict[str, Any]:
    samples = _sample_frames(
        source,
        start=start,
        end=end,
        count=max(2, int(math.ceil(max(0.05, end - start) / max(0.05, interval))) + 1),
    )
    if not samples:
        raise RuntimeError("No frames were available for tracking")
    first = samples[0].frame
    frame_h, frame_w = first.shape[:2]
    if face:
        detected = _detect_face(first)
        if detected is None:
            raise RuntimeError("No face was detected near the center of the first frame")
        rect_x, rect_y, rect_w, rect_h = detected
        padding_x, padding_y = int(rect_w * 0.18), int(rect_h * 0.25)
        rect_x = max(0, rect_x - padding_x)
        rect_y = max(0, rect_y - padding_y)
        rect_w = min(frame_w - rect_x, rect_w + padding_x * 2)
        rect_h = min(frame_h - rect_y, rect_h + padding_y * 2)
    else:
        rect_x = int(_clamp(x, 0, 1) * frame_w)
        rect_y = int(_clamp(y, 0, 1) * frame_h)
        rect_w = max(8, int(_clamp(width, 0.005, 1) * frame_w))
        rect_h = max(8, int(_clamp(height, 0.005, 1) * frame_h))
        rect_x = min(max(0, rect_x), max(0, frame_w - rect_w))
        rect_y = min(max(0, rect_y), max(0, frame_h - rect_h))
    template = cv2.cvtColor(first[rect_y : rect_y + rect_h, rect_x : rect_x + rect_w], cv2.COLOR_BGR2GRAY)
    if template.size == 0:
        raise RuntimeError("The tracking rectangle is outside the frame")

    keyframes = []
    confidence_values = []
    current_x, current_y = rect_x, rect_y
    for index, sample in enumerate(samples):
        frame = sample.frame
        current_h, current_w = frame.shape[:2]
        if index:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            margin_x = max(rect_w, int(current_w * 0.12))
            margin_y = max(rect_h, int(current_h * 0.12))
            sx = max(0, current_x - margin_x)
            sy = max(0, current_y - margin_y)
            ex = min(current_w, current_x + rect_w + margin_x)
            ey = min(current_h, current_y + rect_h + margin_y)
            search = gray[sy:ey, sx:ex]
            if search.shape[0] >= template.shape[0] and search.shape[1] >= template.shape[1]:
                result = cv2.matchTemplate(search, template, cv2.TM_CCOEFF_NORMED)
                _, maximum, _, location = cv2.minMaxLoc(result)
                current_x = sx + int(location[0])
                current_y = sy + int(location[1])
                confidence_values.append(float(maximum))
                if maximum >= 0.42:
                    candidate = gray[current_y : current_y + rect_h, current_x : current_x + rect_w]
                    if candidate.shape == template.shape:
                        template = cv2.addWeighted(template, 0.88, candidate, 0.12, 0)
        keyframes.append(
            {
                "time": round(sample.time, 4),
                "x": round(current_x / max(1, current_w), 6),
                "y": round(current_y / max(1, current_h), 6),
                "width": round(rect_w / max(1, current_w), 6),
                "height": round(rect_h / max(1, current_h), 6),
                "rotation": 0,
            }
        )
    mean_confidence = float(np.mean(confidence_values)) if confidence_values else 1.0
    return {
        "keyframes": keyframes,
        "confidence": round(_clamp(mean_confidence, 0, 1), 4),
        "status": "tracked" if mean_confidence >= 0.52 else "partial",
        "face": face,
    }


def align_audio(
    source: str,
    *,
    ffmpeg_bin: str = "ffmpeg",
    threshold_db: float = -42,
) -> dict[str, Any]:
    result = _run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-nostdin",
            "-v",
            "info",
            "-i",
            source,
            "-af",
            f"silencedetect=noise={threshold_db:g}dB:d=0.08",
            "-f",
            "null",
            "-",
        ],
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "Audio analysis failed").strip().splitlines()[-1])
    starts = [float(value) for value in re.findall(r"silence_start:\s*([-+0-9.eE]+)", result.stderr or "")]
    ends = [float(value) for value in re.findall(r"silence_end:\s*([-+0-9.eE]+)", result.stderr or "")]
    leading = ends[0] if starts and starts[0] <= 0.02 and ends else 0.0
    return {
        "leadingSilenceSec": round(max(0.0, leading), 4),
        "thresholdDb": threshold_db,
    }


def _ffmpeg_find_times(stderr: str, pattern: str) -> list[tuple[float, float]]:
    output = []
    for match in re.finditer(pattern, stderr or "", flags=re.DOTALL):
        start = _finite(match.group(1), 0)
        end = _finite(match.group(2), start)
        if end > start:
            output.append((start, end))
    return output


def qc_source(
    source: str,
    *,
    start: float = 0.0,
    end: float | None = None,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
) -> dict[str, Any]:
    probe = _probe(source, ffprobe_bin)
    duration = _finite(probe.get("duration"), 0)
    start = _clamp(start, 0, max(0, duration))
    end = _clamp(duration if end is None else end, start, max(start, duration))
    selected_duration = max(0.02, end - start)
    issues: list[dict[str, Any]] = []

    common = [ffmpeg_bin, "-hide_banner", "-nostdin", "-v", "info", "-ss", f"{start:.4f}", "-i", source, "-t", f"{selected_duration:.4f}"]
    black = _run([*common, "-vf", "blackdetect=d=0.20:pix_th=0.08", "-an", "-f", "null", "-"], timeout=min(900, 60 + selected_duration * 1.5))
    black_ranges = _ffmpeg_find_times(black.stderr, r"black_start:([-+0-9.eE]+)\s+black_end:([-+0-9.eE]+)")
    for index, (item_start, item_end) in enumerate(black_ranges[:200]):
        issues.append(
            {
                "id": f"black-{index + 1}",
                "severity": "warning" if item_end - item_start < 2 else "error",
                "category": "video",
                "time": round(start + item_start, 4),
                "title": "Black frame range",
                "detail": f"{item_end - item_start:.2f}s of near-black video.",
            }
        )

    silence = _run(
        [*common, "-af", "silencedetect=noise=-48dB:d=2.0,astats=metadata=1:reset=0", "-vn", "-f", "null", "-"],
        timeout=min(900, 60 + selected_duration * 1.5),
    )
    silence_ranges = _ffmpeg_find_times(silence.stderr, r"silence_start:\s*([-+0-9.eE]+).*?silence_end:\s*([-+0-9.eE]+)")
    for index, (item_start, item_end) in enumerate(silence_ranges[:200]):
        issues.append(
            {
                "id": f"silence-{index + 1}",
                "severity": "info" if item_end - item_start < 8 else "warning",
                "category": "audio",
                "time": round(start + item_start, 4),
                "title": "Extended silence",
                "detail": f"{item_end - item_start:.2f}s below -48 dBFS.",
            }
        )
    peak_values = [_finite(value, -120) for value in re.findall(r"Peak level dB:\s*([-+0-9.infINF]+)", silence.stderr or "")]
    peak_db = max(peak_values) if peak_values else None
    if peak_db is not None and peak_db > -0.1:
        issues.append(
            {
                "id": "audio-clipping",
                "severity": "error",
                "category": "audio",
                "time": start,
                "title": "Audio clipping risk",
                "detail": f"Measured peak is {peak_db:.2f} dBFS.",
            }
        )

    samples = _sample_frames(source, start=start, end=end, count=min(180, max(24, int(selected_duration / 2))))
    previous_luma = None
    legal_low = 0
    legal_high = 0
    legal_pixels = 0
    flash_events = []
    for sample in samples:
        small = cv2.resize(sample.frame, (320, 180), interpolation=cv2.INTER_AREA)
        y = cv2.cvtColor(small, cv2.COLOR_BGR2YUV)[:, :, 0]
        mean_luma = float(np.mean(y))
        legal_low += int(np.count_nonzero(y < 16))
        legal_high += int(np.count_nonzero(y > 235))
        legal_pixels += int(y.size)
        if previous_luma is not None and abs(mean_luma - previous_luma) > 70:
            flash_events.append((sample.time, abs(mean_luma - previous_luma)))
        previous_luma = mean_luma
    for index, (timestamp, delta) in enumerate(flash_events[:100]):
        issues.append(
            {
                "id": f"flash-{index + 1}",
                "severity": "warning",
                "category": "video",
                "time": round(timestamp, 4),
                "title": "Abrupt luminance flash",
                "detail": f"Frame-to-frame luma changed by {delta:.1f}/255.",
            }
        )
    low_pct = legal_low / max(1, legal_pixels) * 100
    high_pct = legal_high / max(1, legal_pixels) * 100
    if low_pct > 0.5 or high_pct > 0.5:
        issues.append(
            {
                "id": "video-legal-levels",
                "severity": "warning",
                "category": "color",
                "time": start,
                "title": "Broadcast legal range",
                "detail": f"{low_pct:.2f}% below code 16 and {high_pct:.2f}% above code 235 in sampled frames.",
            }
        )

    video_stream = next((stream for stream in probe.get("streams", []) if stream.get("codec_type") == "video"), {})
    audio_stream = next((stream for stream in probe.get("streams", []) if stream.get("codec_type") == "audio"), {})
    if not video_stream:
        issues.append(
            {
                "id": "missing-video",
                "severity": "error",
                "category": "media",
                "time": 0,
                "title": "Missing video stream",
                "detail": "The source does not contain a decodable video stream.",
            }
        )
    if not audio_stream:
        issues.append(
            {
                "id": "missing-audio",
                "severity": "warning",
                "category": "media",
                "time": 0,
                "title": "Missing audio stream",
                "detail": "The source does not contain an audio stream.",
            }
        )
    counts = {
        "error": sum(1 for issue in issues if issue["severity"] == "error"),
        "warning": sum(1 for issue in issues if issue["severity"] == "warning"),
        "info": sum(1 for issue in issues if issue["severity"] == "info"),
    }
    return {
        "generatedAt": datetime.now(UTC).isoformat(),
        "source": source,
        "duration": duration,
        "selection": {"start": start, "end": end},
        "media": {
            "video": video_stream,
            "audio": audio_stream,
            "audioPeakDb": peak_db,
            "legalLowPct": round(low_pct, 4),
            "legalHighPct": round(high_pct, 4),
        },
        "summary": {**counts, "passed": counts["error"] == 0},
        "issues": sorted(issues, key=lambda item: (_finite(item.get("time"), 0), item.get("severity", ""))),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Professional long-form analysis tools")
    subparsers = parser.add_subparsers(dest="command", required=True)

    grade = subparsers.add_parser("auto-grade")
    grade.add_argument("source")
    grade.add_argument("--start", type=float, default=0)
    grade.add_argument("--end", type=float)
    grade.add_argument("--samples", type=int, default=36)

    background = subparsers.add_parser("background-key")
    background.add_argument("source")
    background.add_argument("--time", type=float, default=0)

    tracker = subparsers.add_parser("track")
    tracker.add_argument("source")
    tracker.add_argument("--start", type=float, required=True)
    tracker.add_argument("--end", type=float, required=True)
    tracker.add_argument("--x", type=float, default=0.25)
    tracker.add_argument("--y", type=float, default=0.25)
    tracker.add_argument("--width", type=float, default=0.25)
    tracker.add_argument("--height", type=float, default=0.25)
    tracker.add_argument("--face", action="store_true")
    tracker.add_argument("--interval", type=float, default=0.25)

    align = subparsers.add_parser("align-audio")
    align.add_argument("source")
    align.add_argument("--ffmpeg", default="ffmpeg")
    align.add_argument("--threshold-db", type=float, default=-42)

    qc = subparsers.add_parser("qc")
    qc.add_argument("source")
    qc.add_argument("--start", type=float, default=0)
    qc.add_argument("--end", type=float)
    qc.add_argument("--ffmpeg", default="ffmpeg")
    qc.add_argument("--ffprobe", default="ffprobe")

    parser.add_argument("--pretty", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "auto-grade":
            result = auto_grade(args.source, start=args.start, end=args.end, sample_count=args.samples)
        elif args.command == "background-key":
            result = suggest_background_key(args.source, time_sec=args.time)
        elif args.command == "track":
            result = track_region(
                args.source,
                start=args.start,
                end=args.end,
                x=args.x,
                y=args.y,
                width=args.width,
                height=args.height,
                face=args.face,
                interval=args.interval,
            )
        elif args.command == "align-audio":
            result = align_audio(args.source, ffmpeg_bin=args.ffmpeg, threshold_db=args.threshold_db)
        elif args.command == "qc":
            result = qc_source(
                args.source,
                start=args.start,
                end=args.end,
                ffmpeg_bin=args.ffmpeg,
                ffprobe_bin=args.ffprobe,
            )
        else:  # pragma: no cover
            raise ValueError(f"Unknown command: {args.command}")
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2 if args.pretty else None, sort_keys=bool(args.pretty)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
