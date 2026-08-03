#!/usr/bin/env python3
"""Visual-first multi-source action compilation analysis and rendering.

This module intentionally avoids the speech/Whisper pipeline. It samples each
source for motion, scene change, focus, color, and exposure; builds a diverse
timeline; then normalizes and joins the selected moments with FFmpeg.
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass, asdict
import json
import math
import os
from pathlib import Path
import signal
import statistics
import subprocess
import sys
import tempfile
from typing import Any, Iterable, Mapping, Sequence

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi", ".mts", ".m2ts"}
GOALS = {"fast_action", "cosplay_showcase", "cinematic"}
PACING = {"rapid", "fast", "balanced", "cinematic"}
TRANSITION_MODES = {"auto", "minimal", "none"}
SELECTION_MODES = {"best_moments", "use_every_clip"}
ORDER_MODES = {"ai", "manual"}
MONTAGE_FORMATS = {"vertical_short", "horizontal_longform"}
CREATOR_TRANSITIONS = (
    ("wipeleft", "Swipe left"),
    ("wiperight", "Swipe right"),
    ("slideup", "Pull up"),
    ("slidedown", "Pull down"),
)
MAX_REUSED_SOURCE_OVERLAP = 0.08
_ACTIVE_PROCESS: subprocess.Popen[str] | None = None
_CANCEL_REQUESTED = False
_FACE_RECOGNITION: Any | None = None
_FACE_DETECTION_DISABLED = False
_PERSON_MODEL: Any | None = None
_PERSON_DETECTION_DISABLED = False


def _cancel_active_process(_signum: int, _frame: Any) -> None:
    global _CANCEL_REQUESTED
    _CANCEL_REQUESTED = True
    process = _ACTIVE_PROCESS
    if process is None or process.poll() is not None:
        return
    try:
        if os.name == "nt":
            process.terminate()
        else:
            os.killpg(process.pid, signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, float(value)))


def finite_float(value: Any, fallback: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return fallback
    return result if math.isfinite(result) else fallback


def run_command(command: Sequence[str], *, timeout: float = 1800) -> subprocess.CompletedProcess[str]:
    global _ACTIVE_PROCESS
    if _CANCEL_REQUESTED:
        raise RuntimeError("Action compilation was cancelled")
    try:
        process = subprocess.Popen(
            list(command),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=os.name != "nt",
        )
        _ACTIVE_PROCESS = process
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            _cancel_active_process(signal.SIGTERM, None)
            try:
                stdout, stderr = process.communicate(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                stdout, stderr = process.communicate()
            raise RuntimeError(f"Command timed out: {command[0]}") from exc
        result = subprocess.CompletedProcess(list(command), process.returncode, stdout, stderr)
        if _CANCEL_REQUESTED:
            raise RuntimeError("Action compilation was cancelled")
        if process.returncode:
            details = (stderr or stdout or "").strip()[-2000:]
            raise RuntimeError(f"Command failed ({command[0]}): {details}")
        return result
    except FileNotFoundError as exc:
        raise RuntimeError(f"Required executable is unavailable: {command[0]}") from exc
    finally:
        _ACTIVE_PROCESS = None


def normalize_settings(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    data = dict(raw or {})
    montage_format = str(data.get("format", data.get("montage_format", "vertical_short")))
    if montage_format not in MONTAGE_FORMATS:
        montage_format = "vertical_short"
    horizontal_longform = montage_format == "horizontal_longform"
    default_pacing = "balanced" if horizontal_longform else "fast"
    goal = str(data.get("goal", "fast_action"))
    pacing = str(data.get("pacing", default_pacing))
    transition_mode = str(data.get("transition_mode", data.get("transitionMode", "auto")))
    selection_mode = str(data.get("selection_mode", data.get("selectionMode", "best_moments")))
    order_mode = str(data.get("order_mode", data.get("orderMode", "ai")))
    default_duration = 300 if horizontal_longform else 30
    minimum_duration = 180 if horizontal_longform else 4
    maximum_duration = 900 if horizontal_longform else 180
    default_width = 1920 if horizontal_longform else 1080
    default_height = 1080 if horizontal_longform else 1920
    width = int(finite_float(data.get("output_width", default_width), default_width))
    height = int(finite_float(data.get("output_height", default_height), default_height))
    width = max(160, min(2160, width - (width % 2)))
    height = max(160, min(3840, height - (height % 2)))
    return {
        "format": montage_format,
        "goal": goal if goal in GOALS else "fast_action",
        "target_duration_sec": clamp(
            finite_float(
                data.get("target_duration_sec", data.get("targetDurationSec", default_duration)),
                default_duration,
            ),
            minimum_duration,
            maximum_duration,
        ),
        "pacing": pacing if pacing in PACING else default_pacing,
        "transition_mode": transition_mode if transition_mode in TRANSITION_MODES else "auto",
        "selection_mode": selection_mode if selection_mode in SELECTION_MODES else "best_moments",
        "order_mode": order_mode if order_mode in ORDER_MODES else "ai",
        "output_width": width,
        "output_height": height,
        "fps": max(12, min(60, int(finite_float(data.get("fps", 30), 30)))),
    }


@dataclass(frozen=True)
class SourceInfo:
    id: str
    path: str
    name: str
    order: int
    duration: float
    width: int
    height: int
    has_audio: bool


@dataclass
class Candidate:
    id: str
    source_id: str
    source_order: int
    source_path: str
    source_name: str
    start: float
    end: float
    score: float
    motion: float
    scene_change: float
    reasons: list[str]
    transition_out: dict[str, Any] | None = None
    subject_x: float = 0.5
    subject_y: float = 0.5
    subject_kind: str = "none"
    subject_confidence: float = 0.0
    subject_count: int = 0
    subject_left: float | None = None
    subject_top: float | None = None
    subject_right: float | None = None
    subject_bottom: float | None = None
    framing_mode: str = "center"

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def probe_media(path: str | Path, ffprobe_bin: str = "ffprobe") -> SourceInfo:
    source = Path(path).resolve()
    payload = run_command([
        ffprobe_bin, "-v", "error", "-show_streams", "-show_format",
        "-of", "json", str(source),
    ], timeout=60)
    data = json.loads(payload.stdout or "{}")
    streams = data.get("streams") if isinstance(data.get("streams"), list) else []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if not video:
        raise RuntimeError(f"No video stream found in {source.name}")
    duration = finite_float(video.get("duration"), finite_float(data.get("format", {}).get("duration"), 0))
    if duration <= 0:
        raise RuntimeError(f"Could not determine duration for {source.name}")
    coded_width = max(1, int(video.get("width") or 1))
    coded_height = max(1, int(video.get("height") or 1))
    raw_tag_rotation = (video.get("tags") or {}).get("rotate")
    rotation = finite_float(raw_tag_rotation, 0.0)
    rotation_found = raw_tag_rotation is not None
    for side_data in video.get("side_data_list") or []:
        if isinstance(side_data, Mapping) and side_data.get("rotation") is not None:
            rotation = finite_float(side_data.get("rotation"), rotation)
            rotation_found = True
            break
    if not rotation_found:
        # H.264/H.265 orientation SEI is exposed on a decoded frame rather than
        # the stream object. Ask ffprobe for only the first video frame so this
        # remains fast while matching FFmpeg's later autorotation behavior.
        try:
            frame_probe = run_command([
                ffprobe_bin, "-v", "error", "-select_streams", "v:0",
                "-read_intervals", "%+#1",
                "-show_entries", "frame=width,height:frame_side_data=rotation",
                "-of", "json", str(source),
            ], timeout=60)
            frame_data = json.loads(frame_probe.stdout or "{}")
            first_frame = next(iter(frame_data.get("frames") or []), {})
            for side_data in first_frame.get("side_data_list") or []:
                if isinstance(side_data, Mapping) and side_data.get("rotation") is not None:
                    rotation = finite_float(side_data.get("rotation"), rotation)
                    rotation_found = True
                    break
        except (RuntimeError, ValueError, json.JSONDecodeError):
            pass
    normalized_rotation = rotation % 360.0
    quarter_turned = (
        45.0 <= normalized_rotation < 135.0
        or 225.0 <= normalized_rotation < 315.0
    )
    # FFmpeg autorotates display-matrix phone footage before filters run, and
    # OpenCV analyzes the same displayed orientation. Framing must therefore
    # use display dimensions rather than the encoded/coded dimensions.
    display_width, display_height = (
        (coded_height, coded_width) if quarter_turned else (coded_width, coded_height)
    )
    return SourceInfo(
        id="",
        path=str(source),
        name=source.name,
        order=0,
        duration=duration,
        width=display_width,
        height=display_height,
        has_audio=any(item.get("codec_type") == "audio" for item in streams),
    )


def validate_rendered_output(
    path: str | Path,
    *,
    expected_duration: float,
    expected_width: int,
    expected_height: int,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
) -> dict[str, Any]:
    """Reject incomplete or playback-incompatible renders before publishing."""
    output = Path(path)
    if not output.is_file() or output.stat().st_size < 1024:
        raise RuntimeError("Rendered montage is missing or empty")

    probe = run_command([
        ffprobe_bin, "-v", "error", "-show_streams", "-show_format",
        "-of", "json", str(output),
    ], timeout=60)
    data = json.loads(probe.stdout or "{}")
    streams = data.get("streams") if isinstance(data.get("streams"), list) else []
    video = next((item for item in streams if item.get("codec_type") == "video"), None)
    if not video:
        raise RuntimeError("Rendered montage has no video stream")

    duration = finite_float(
        data.get("format", {}).get("duration"),
        finite_float(video.get("duration"), 0),
    )
    if duration <= 0:
        raise RuntimeError("Rendered montage has no playable duration")
    tolerance = max(0.75, float(expected_duration) * 0.05)
    if abs(duration - float(expected_duration)) > tolerance:
        raise RuntimeError(
            f"Rendered montage duration is invalid ({duration:.3f}s; expected {expected_duration:.3f}s)"
        )

    width = int(video.get("width") or 0)
    height = int(video.get("height") or 0)
    if (width, height) != (int(expected_width), int(expected_height)):
        raise RuntimeError(
            f"Rendered montage dimensions are invalid ({width}x{height}; "
            f"expected {expected_width}x{expected_height})"
        )
    pixel_format = str(video.get("pix_fmt") or "")
    if pixel_format != "yuv420p":
        raise RuntimeError(
            f"Rendered montage uses incompatible pixel format {pixel_format or 'unknown'}; expected yuv420p"
        )

    # Decode the complete file once before it becomes visible in the library.
    # This catches truncated media that can still have readable container metadata.
    run_command([
        ffmpeg_bin, "-v", "error", "-xerror", "-nostdin", "-i", str(output),
        "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-",
    ], timeout=max(300, duration * 10))
    return {
        "duration": duration,
        "codec": str(video.get("codec_name") or ""),
        "profile": str(video.get("profile") or ""),
        "pixel_format": pixel_format,
        "width": width,
        "height": height,
    }


def _load_face_recognition() -> Any | None:
    global _FACE_RECOGNITION, _FACE_DETECTION_DISABLED
    if _FACE_DETECTION_DISABLED:
        return None
    if _FACE_RECOGNITION is None:
        try:
            import face_recognition
            _FACE_RECOGNITION = face_recognition
        except (ImportError, OSError):
            _FACE_DETECTION_DISABLED = True
            return None
    return _FACE_RECOGNITION


def _load_person_model() -> Any | None:
    global _PERSON_MODEL, _PERSON_DETECTION_DISABLED
    if _PERSON_DETECTION_DISABLED:
        return None
    if _PERSON_MODEL is None:
        model_path = Path(__file__).resolve().with_name("yolov8n.pt")
        if not model_path.is_file():
            _PERSON_DETECTION_DISABLED = True
            return None
        try:
            from ultralytics import YOLO
            _PERSON_MODEL = YOLO(str(model_path), task="detect")
        except (ImportError, OSError, RuntimeError):
            _PERSON_DETECTION_DISABLED = True
            return None
    return _PERSON_MODEL


def _normalized_subject_box(subject: Mapping[str, Any]) -> dict[str, Any]:
    """Return a subject with a bounded normalized box, including legacy points."""
    kind = str(subject.get("kind") or "person")
    x = clamp(finite_float(subject.get("x"), 0.5))
    y = clamp(finite_float(subject.get("y"), 0.5))
    area = clamp(finite_float(subject.get("area"), 0.0))
    raw_edges = [subject.get(key) for key in ("left", "top", "right", "bottom")]
    edges = [finite_float(value, math.nan) for value in raw_edges]
    if all(math.isfinite(value) for value in edges):
        left, top, right, bottom = edges
        left, right = sorted((clamp(left), clamp(right)))
        top, bottom = sorted((clamp(top), clamp(bottom)))
    else:
        # Older sidecars/tests only carried a point and area. A compact inferred
        # box keeps those inputs trackable without pretending it is a full body.
        side = math.sqrt(max(0.0001, area))
        left, right = clamp(x - side / 2), clamp(x + side / 2)
        top, bottom = clamp(y - side / 2), clamp(y + side / 2)
    if right - left < 0.001:
        left, right = clamp(x - 0.0005), clamp(x + 0.0005)
    if bottom - top < 0.001:
        top, bottom = clamp(y - 0.0005), clamp(y + 0.0005)
    normalized = dict(subject)
    normalized.update({
        "kind": kind,
        "x": clamp((left + right) / 2.0),
        "y": clamp((top + bottom) / 2.0),
        "left": left,
        "top": top,
        "right": right,
        "bottom": bottom,
        "area": max(area, (right - left) * (bottom - top)),
        "confidence": clamp(finite_float(subject.get("confidence"), 0.5)),
    })
    return normalized


def _box_iou(first: Mapping[str, Any], second: Mapping[str, Any]) -> float:
    left = max(finite_float(first.get("left"), 0.0), finite_float(second.get("left"), 0.0))
    top = max(finite_float(first.get("top"), 0.0), finite_float(second.get("top"), 0.0))
    right = min(finite_float(first.get("right"), 1.0), finite_float(second.get("right"), 1.0))
    bottom = min(finite_float(first.get("bottom"), 1.0), finite_float(second.get("bottom"), 1.0))
    intersection = max(0.0, right - left) * max(0.0, bottom - top)
    first_area = max(0.0, finite_float(first.get("right"), 1.0) - finite_float(first.get("left"), 0.0)) * max(
        0.0, finite_float(first.get("bottom"), 1.0) - finite_float(first.get("top"), 0.0)
    )
    second_area = max(0.0, finite_float(second.get("right"), 1.0) - finite_float(second.get("left"), 0.0)) * max(
        0.0, finite_float(second.get("bottom"), 1.0) - finite_float(second.get("top"), 0.0)
    )
    return intersection / max(0.000001, first_area + second_area - intersection)


def _foreground_prominence(subject: Mapping[str, Any]) -> float:
    normalized = _normalized_subject_box(subject)
    area = clamp(finite_float(normalized.get("area"), 0.0))
    height = clamp(finite_float(normalized.get("bottom"), 1.0) - finite_float(normalized.get("top"), 0.0))
    confidence = clamp(finite_float(normalized.get("confidence"), 0.5))
    if normalized.get("kind") == "person":
        face_bonus = 1.0 if normalized.get("face_x") is not None else 0.0
        return clamp(
            0.54 * clamp(area / 0.32)
            + 0.24 * clamp(height / 0.85)
            + 0.14 * confidence
            + 0.08 * face_bonus
        )
    return clamp(0.68 * clamp(area / 0.045) + 0.22 * confidence + 0.10 * clamp(height / 0.24))


def detect_visual_subjects(frame: Any) -> list[dict[str, Any]]:
    """Find foreground people and use associated faces to refine their focus."""
    try:
        import cv2
    except ImportError:
        return []
    height, width = frame.shape[:2]
    if width <= 0 or height <= 0:
        return []

    faces: list[dict[str, Any]] = []
    face_recognition = _load_face_recognition()
    if face_recognition is not None:
        try:
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            locations = face_recognition.face_locations(
                rgb,
                number_of_times_to_upsample=1,
                model="hog",
            )
            for top, right, bottom, left in locations:
                box_width = max(1, int(right) - int(left))
                box_height = max(1, int(bottom) - int(top))
                faces.append({
                    "kind": "face",
                    "x": clamp((float(left) + float(right)) / (2.0 * width)),
                    "y": clamp((float(top) + float(bottom)) / (2.0 * height)),
                    "left": clamp(float(left) / width),
                    "top": clamp(float(top) / height),
                    "right": clamp(float(right) / width),
                    "bottom": clamp(float(bottom) / height),
                    "area": clamp((box_width * box_height) / float(width * height)),
                    "confidence": 0.9,
                })
        except (RuntimeError, ValueError):
            # A single unreadable frame must not disable montage analysis.
            pass

    model = _load_person_model()
    people: list[dict[str, Any]] = []
    if model is not None:
        try:
            results = model.predict(
                source=frame,
                classes=[0],
                conf=0.25,
                imgsz=384,
                device="cpu",
                verbose=False,
            )
            for result in results[:1]:
                for box in result.boxes[:8]:
                    left, top, right, bottom = (float(value) for value in box.xyxy[0].tolist())
                    box_width = max(1.0, right - left)
                    box_height = max(1.0, bottom - top)
                    confidence = float(box.conf[0].item()) if box.conf is not None else 0.25
                    people.append({
                        "kind": "person",
                        "x": clamp((left + right) / (2.0 * width)),
                        "y": clamp((top + bottom) / (2.0 * height)),
                        "left": clamp(left / width),
                        "top": clamp(top / height),
                        "right": clamp(right / width),
                        "bottom": clamp(bottom / height),
                        "area": clamp((box_width * box_height) / float(width * height)),
                        "confidence": clamp(confidence),
                    })
        except (AttributeError, RuntimeError, TypeError, ValueError):
            people = []

    # A face only helps the person whose upper body actually contains it. This
    # prevents a small centered bystander from stealing the crop from a large
    # foreground cosplayer near an edge.
    associated_faces: set[int] = set()
    for person in people:
        person_height = float(person["bottom"]) - float(person["top"])
        matches = []
        for index, face in enumerate(faces):
            face_x = float(face["x"])
            face_y = float(face["y"])
            inside = (
                float(person["left"]) - 0.025 <= face_x <= float(person["right"]) + 0.025
                and float(person["top"]) - 0.025 <= face_y
                <= float(person["top"]) + person_height * 0.68
            )
            if inside:
                matches.append((index, face))
        if matches:
            face_index, face = max(matches, key=lambda pair: float(pair[1]["area"]))
            associated_faces.add(face_index)
            person.update({
                "face_x": face["x"],
                "face_y": face["y"],
                "face_area": face["area"],
                "face_confidence": face["confidence"],
            })

    subjects = people + [face for index, face in enumerate(faces) if index not in associated_faces]
    return sorted(subjects, key=_foreground_prominence, reverse=True)


def _subject_quality(subjects: Sequence[Mapping[str, Any]]) -> float:
    if not subjects:
        return 0.0
    people = [item for item in subjects if item.get("kind") == "person"]
    primary = max(people or list(subjects), key=_foreground_prominence)
    area = clamp(finite_float(primary.get("area"), 0.0))
    confidence = clamp(finite_float(primary.get("confidence"), 0.5))
    if primary.get("kind") == "face":
        prominence = clamp(area / 0.035)
        return clamp(0.58 + prominence * 0.30 + confidence * 0.12)
    prominence = clamp(area / 0.24)
    return clamp(0.34 + prominence * 0.42 + confidence * 0.14)


def choose_subject_focus(
    features: Sequence[Mapping[str, Any]],
    peak_index: int,
    start: float,
    end: float,
) -> dict[str, Any]:
    """Track the most persistent, prominent foreground subject through a shot."""
    relevant = [
        item for item in features
        if start - 0.15 <= finite_float(item.get("time"), -1.0) <= end + 0.15
    ]
    if not relevant:
        return {
            "x": 0.5, "y": 0.5, "kind": "none", "confidence": 0.0, "count": 0,
            "left": None, "top": None, "right": None, "bottom": None,
        }

    # Greedy short-shot tracking is deliberately based on the complete box,
    # not just x. IoU, 2D distance, and scale consistency stop a similarly
    # aligned background attendee from taking over the foreground track.
    tracks: list[dict[str, Any]] = []
    for frame_index, feature in enumerate(relevant):
        subjects = sorted(
            (_normalized_subject_box(item) for item in (feature.get("subjects") or [])),
            key=_foreground_prominence,
            reverse=True,
        )
        assigned_tracks: set[int] = set()
        for subject in subjects:
            best_index: int | None = None
            best_score = -1.0
            for track_index, track_info in enumerate(tracks):
                if track_index in assigned_tracks or track_info["kind"] != subject["kind"]:
                    continue
                if frame_index - int(track_info["last_frame"]) > 3:
                    continue
                previous = track_info["detections"][-1]
                iou = _box_iou(previous, subject)
                distance = math.hypot(
                    float(previous["x"]) - float(subject["x"]),
                    float(previous["y"]) - float(subject["y"]),
                )
                previous_area = max(0.000001, finite_float(previous.get("area"), 0.0))
                subject_area = max(0.000001, finite_float(subject.get("area"), 0.0))
                scale_similarity = min(previous_area, subject_area) / max(previous_area, subject_area)
                if iou < 0.02 and (distance > 0.22 or scale_similarity < 0.45):
                    continue
                match_score = (
                    0.58 * iou
                    + 0.24 * clamp(1.0 - distance / 0.36)
                    + 0.18 * scale_similarity
                )
                if match_score > best_score:
                    best_index, best_score = track_index, match_score
            if best_index is None or best_score < 0.20:
                tracks.append({
                    "kind": subject["kind"],
                    "detections": [subject],
                    "frames": [frame_index],
                    "last_frame": frame_index,
                })
                assigned_tracks.add(len(tracks) - 1)
            else:
                tracks[best_index]["detections"].append(subject)
                tracks[best_index]["frames"].append(frame_index)
                tracks[best_index]["last_frame"] = frame_index
                assigned_tracks.add(best_index)

    if not tracks:
        return {
            "x": 0.5, "y": 0.5, "kind": "none", "confidence": 0.0,
            "count": 0, "left": None, "top": None, "right": None, "bottom": None,
        }

    peak_time = finite_float(features[max(0, min(len(features) - 1, peak_index))].get("time"), start)

    def track_metrics(track_info: Mapping[str, Any]) -> dict[str, float]:
        detections = list(track_info["detections"])
        frames = set(track_info["frames"])
        areas = [finite_float(item.get("area"), 0.0) for item in detections]
        heights = [finite_float(item.get("bottom"), 1.0) - finite_float(item.get("top"), 0.0) for item in detections]
        persistence = len(frames) / max(1, len(relevant))
        prominence = statistics.median(_foreground_prominence(item) for item in detections)
        mean_confidence = statistics.fmean(clamp(finite_float(item.get("confidence"), 0.5)) for item in detections)
        peak_present = any(
            abs(finite_float(relevant[index].get("time"), start) - peak_time) <= 0.36
            for index in frames
        )
        return {
            "area": statistics.median(areas),
            "height": statistics.median(heights),
            "persistence": persistence,
            "prominence": prominence,
            "confidence": mean_confidence,
            "score": clamp(
                0.58 * prominence
                + 0.28 * persistence
                + 0.10 * mean_confidence
                + (0.04 if peak_present else 0.0)
            ),
        }

    scored = [(track_info, track_metrics(track_info)) for track_info in tracks]
    person_tracks = [
        pair for pair in scored
        if pair[0]["kind"] == "person"
        and (pair[1]["area"] >= 0.018 or pair[1]["height"] >= 0.20)
    ]
    face_tracks = [pair for pair in scored if pair[0]["kind"] == "face"]
    best_person = max(person_tracks, key=lambda pair: pair[1]["score"], default=None)
    best_face = max(face_tracks, key=lambda pair: pair[1]["score"], default=None)
    # Person/body boxes are the primary signal. A face-only track wins only
    # when every person detection is too small to be a credible foreground body.
    selected = best_person
    if selected is None or (
        selected[1]["prominence"] < 0.26
        and best_face is not None
        and best_face[1]["score"] > selected[1]["score"] + 0.08
    ):
        selected = best_face
    if selected is None:
        selected = max(scored, key=lambda pair: pair[1]["score"])

    track_info, metrics = selected
    track = list(track_info["detections"])
    face_x_values = [finite_float(item.get("face_x"), math.nan) for item in track]
    face_y_values = [finite_float(item.get("face_y"), math.nan) for item in track]
    face_x_values = [value for value in face_x_values if math.isfinite(value)]
    face_y_values = [value for value in face_y_values if math.isfinite(value)]
    focus_x = clamp(statistics.median(face_x_values or [finite_float(item.get("x"), 0.5) for item in track]))
    focus_y = clamp(statistics.median(face_y_values or [finite_float(item.get("y"), 0.5) for item in track]))
    detection_ratio = metrics["persistence"]
    mean_confidence = metrics["confidence"]
    confidence = clamp(detection_ratio * mean_confidence)
    if confidence < 0.12:
        return {
            "x": 0.5,
            "y": 0.5,
            "kind": "none",
            "confidence": round(confidence, 5),
            "count": max(len(item.get("subjects") or []) for item in relevant),
            "left": None, "top": None, "right": None, "bottom": None,
        }
    return {
        "x": round(focus_x, 5),
        "y": round(focus_y, 5),
        "kind": str(track_info["kind"]),
        "confidence": round(confidence, 5),
        "count": max(len(item.get("subjects") or []) for item in relevant),
        # The envelope follows the chosen identity over the complete shot. It
        # intentionally does not union unrelated detections or average people.
        "left": round(min(finite_float(item.get("left"), focus_x) for item in track), 5),
        "top": round(min(finite_float(item.get("top"), focus_y) for item in track), 5),
        "right": round(max(finite_float(item.get("right"), focus_x) for item in track), 5),
        "bottom": round(max(finite_float(item.get("bottom"), focus_y) for item in track), 5),
    }


def portrait_framing(
    source_width: int,
    source_height: int,
    target_width: int,
    target_height: int,
    *,
    subject_x: float = 0.5,
    subject_y: float = 0.5,
    subject_kind: str = "none",
    subject_left: float | None = None,
    subject_top: float | None = None,
    subject_right: float | None = None,
    subject_bottom: float | None = None,
) -> dict[str, Any]:
    """Plan a stable crop, falling back to contextual contain when necessary."""
    source_width = max(2, int(source_width))
    source_height = max(2, int(source_height))
    target_ratio = max(0.01, float(target_width) / max(1.0, float(target_height)))
    source_ratio = float(source_width) / float(source_height)
    # A portrait or square source cannot safely fill a landscape canvas without
    # discarding most of the frame. Keep the complete displayed source over the
    # renderer's blurred background even when no subject detector is available.
    horizontal_narrow_contain = target_ratio > 1.0 and source_ratio <= 1.0
    has_subject = subject_kind in {"face", "person"}
    focus_x = clamp(subject_x)
    focus_y = clamp(subject_y)

    if source_ratio >= target_ratio:
        crop_height = source_height - (source_height % 2)
        crop_width = min(source_width, max(2, int(round(crop_height * target_ratio))))
        crop_width -= crop_width % 2
        default_y = 0
    else:
        crop_width = source_width - (source_width % 2)
        crop_height = min(source_height, max(2, int(round(crop_width / target_ratio))))
        crop_height -= crop_height % 2
        default_y = int(clamp(
            round(source_height * focus_y - crop_height * (1.0 / 3.0 if subject_kind == "face" else 0.42)),
            0,
            max(0, source_height - crop_height),
        ))
        default_y -= default_y % 2

    raw_bounds = [subject_left, subject_top, subject_right, subject_bottom]
    numeric_bounds = [finite_float(value, math.nan) for value in raw_bounds]
    bounds_valid = has_subject and all(math.isfinite(value) for value in numeric_bounds)
    safe_bounds: tuple[float, float, float, float] | None = None
    if bounds_valid:
        left, top, right, bottom = numeric_bounds
        left, right = sorted((clamp(left), clamp(right)))
        top, bottom = sorted((clamp(top), clamp(bottom)))
        if right - left >= 0.001 and bottom - top >= 0.001:
            if subject_kind == "face":
                face_width = right - left
                face_height = bottom - top
                # When only a face is found, reserve torso/costume context
                # instead of producing a disembodied close-up.
                left -= max(0.06, face_width * 1.25)
                right += max(0.06, face_width * 1.25)
                top -= max(0.025, face_height * 0.45)
                bottom += max(0.34, face_height * 3.8)
            else:
                horizontal_padding = max(0.006, min(0.018, 0.04 * crop_width / source_width))
                left -= horizontal_padding
                right += horizontal_padding
                top -= 0.012
                bottom += 0.018
            safe_bounds = (clamp(left), clamp(top), clamp(right), clamp(bottom))

    if has_subject and focus_x < 0.45:
        horizontal_anchor = 1.0 / 3.0
    elif has_subject and focus_x > 0.55:
        horizontal_anchor = 2.0 / 3.0
    else:
        horizontal_anchor = 0.5
    crop_x = int(round(source_width * focus_x - crop_width * horizontal_anchor))
    crop_x = int(clamp(crop_x, 0, max(0, source_width - crop_width)))
    crop_x -= crop_x % 2
    crop_y = default_y

    mode = "subject_crop" if has_subject else "center"
    if safe_bounds is not None:
        safe_left, safe_top, safe_right, safe_bottom = safe_bounds
        if source_ratio >= target_ratio:
            minimum_x = max(0.0, safe_right * source_width - crop_width)
            maximum_x = min(float(source_width - crop_width), safe_left * source_width)
            if minimum_x <= maximum_x:
                crop_x = int(clamp(crop_x, math.ceil(minimum_x), math.floor(maximum_x)))
                crop_x -= crop_x % 2
                # Flooring to an even coordinate can move one pixel below the
                # safe range, so correct in the containment-preserving direction.
                if crop_x < minimum_x:
                    crop_x = min(source_width - crop_width, crop_x + 2)
            else:
                mode = "contextual_contain"
        else:
            minimum_y = max(0.0, safe_bottom * source_height - crop_height)
            maximum_y = min(float(source_height - crop_height), safe_top * source_height)
            if minimum_y <= maximum_y:
                crop_y = int(clamp(crop_y, math.ceil(minimum_y), math.floor(maximum_y)))
                crop_y -= crop_y % 2
                if crop_y < minimum_y:
                    crop_y = min(source_height - crop_height, crop_y + 2)
            else:
                mode = "contextual_contain"

    if horizontal_narrow_contain:
        mode = "contextual_contain"

    if horizontal_narrow_contain:
        region = (
            source_width - (source_width % 2),
            source_height - (source_height % 2),
            0,
            0,
        )
    elif safe_bounds is None:
        region = (crop_width, crop_height, crop_x, crop_y)
    else:
        left, top, right, bottom = safe_bounds
        context_x = 0.018
        context_y = 0.025
        region_x = int(math.floor(clamp(left - context_x) * source_width))
        region_y = int(math.floor(clamp(top - context_y) * source_height))
        region_right = int(math.ceil(clamp(right + context_x) * source_width))
        region_bottom = int(math.ceil(clamp(bottom + context_y) * source_height))
        region_x -= region_x % 2
        region_y -= region_y % 2
        region_width = max(2, region_right - region_x)
        region_height = max(2, region_bottom - region_y)
        region_width -= region_width % 2
        region_height -= region_height % 2
        region_width = min(region_width, source_width - region_x)
        region_height = min(region_height, source_height - region_y)
        region_width -= region_width % 2
        region_height -= region_height % 2
        region = (max(2, region_width), max(2, region_height), region_x, region_y)

    return {
        "mode": mode,
        "crop": (crop_width, crop_height, crop_x, crop_y),
        "region": region,
        "safe_bbox": safe_bounds,
    }


def portrait_crop(
    source_width: int,
    source_height: int,
    target_width: int,
    target_height: int,
    *,
    subject_x: float = 0.5,
    subject_y: float = 0.5,
    subject_kind: str = "none",
    subject_left: float | None = None,
    subject_top: float | None = None,
    subject_right: float | None = None,
    subject_bottom: float | None = None,
) -> tuple[int, int, int, int]:
    """Return the crop portion of :func:`portrait_framing` for compatibility."""
    return portrait_framing(
        source_width, source_height, target_width, target_height,
        subject_x=subject_x, subject_y=subject_y, subject_kind=subject_kind,
        subject_left=subject_left, subject_top=subject_top,
        subject_right=subject_right, subject_bottom=subject_bottom,
    )["crop"]


def _shot_range(pacing: str, montage_format: str = "vertical_short") -> tuple[float, float]:
    if montage_format == "horizontal_longform":
        return {
            "rapid": (1.5, 2.5),
            "fast": (2.5, 4.5),
            "balanced": (4.0, 7.0),
            "cinematic": (6.0, 10.0),
        }[pacing]
    return {
        "rapid": (0.9, 1.7),
        "fast": (1.4, 2.6),
        "balanced": (2.2, 3.8),
        "cinematic": (3.4, 5.8),
    }[pacing]


def _goal_score(
    goal: str,
    *,
    motion: float,
    scene: float,
    sharpness: float,
    saturation: float,
    exposure: float,
    subject_quality: float = 0.0,
) -> float:
    if goal == "cosplay_showcase":
        visual = 0.25 * motion + 0.16 * scene + 0.24 * sharpness + 0.24 * saturation + 0.11 * exposure
        return clamp(visual * 0.76 + subject_quality * 0.24)
    if goal == "cinematic":
        visual = 0.24 * motion + 0.25 * scene + 0.23 * sharpness + 0.10 * saturation + 0.18 * exposure
        return clamp(visual * 0.88 + subject_quality * 0.12)
    visual = 0.48 * motion + 0.25 * scene + 0.12 * sharpness + 0.08 * saturation + 0.07 * exposure
    return clamp(visual * 0.90 + subject_quality * 0.10)


def snap_window_to_safe_boundaries(
    features: Sequence[Mapping[str, float]], peak_index: int,
    desired_duration: float, source_duration: float,
) -> tuple[float, float]:
    """Place cuts near low-motion valleys or real scene boundaries around a peak."""
    peak_time = float(features[peak_index]["time"])
    nominal_start = max(0.0, peak_time - desired_duration * 0.45)
    nominal_end = min(source_duration, nominal_start + desired_duration)
    nominal_start = max(0.0, nominal_end - desired_duration)

    def choose(target: float, *, before_peak: bool) -> float:
        options = []
        for feature in features:
            time_sec = float(feature["time"])
            if abs(time_sec - target) > 0.55:
                continue
            if before_peak and time_sec >= peak_time - 0.2:
                continue
            if not before_peak and time_sec <= peak_time + 0.2:
                continue
            motion = clamp(float(feature.get("motion", 0.0)))
            scene = clamp(float(feature.get("scene", 0.0)))
            # A true scene change is safe even when the adjacent frames differ;
            # otherwise favor a motion valley and stay near the requested pace.
            cost = motion * 0.72 + (1.0 - scene) * 0.18 + abs(time_sec - target) * 0.10
            options.append((cost, time_sec))
        return min(options)[1] if options else target

    start = clamp(choose(nominal_start, before_peak=True), 0, source_duration)
    end = clamp(choose(nominal_end, before_peak=False), 0, source_duration)
    minimum = max(0.65, desired_duration * 0.62)
    if start >= peak_time or end <= peak_time or end - start < minimum:
        return nominal_start, nominal_end
    return start, end


def analyze_source(source: SourceInfo, settings: Mapping[str, Any]) -> list[Candidate]:
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("Action compilation requires OpenCV and NumPy in the configured Python environment") from exc
    capture = cv2.VideoCapture(source.path)
    if not capture.isOpened():
        raise RuntimeError(f"OpenCV could not open {source.name}")
    try:
        montage_format = str(settings.get("format", "vertical_short"))
        minimum, maximum = _shot_range(str(settings["pacing"]), montage_format)
        margin = min(0.35, source.duration * 0.05)
        interval = max(0.18, source.duration / 540.0)
        sample_times = np.arange(margin, max(margin + interval, source.duration - margin), interval)
        previous_gray: np.ndarray | None = None
        previous_hist: np.ndarray | None = None
        features: list[dict[str, Any]] = []
        last_subject_sample = -math.inf
        last_subjects: list[dict[str, Any]] = []
        for time_sec in sample_times:
            capture.set(cv2.CAP_PROP_POS_MSEC, float(time_sec) * 1000.0)
            ok, frame = capture.read()
            if not ok or frame is None:
                continue
            original_height, original_width = frame.shape[:2]
            detection_scale = min(1.0, 480.0 / max(1.0, float(max(original_width, original_height))))
            detection_frame = cv2.resize(
                frame,
                (
                    max(2, int(round(original_width * detection_scale))),
                    max(2, int(round(original_height * detection_scale))),
                ),
                interpolation=cv2.INTER_AREA,
            )
            if float(time_sec) - last_subject_sample >= 0.34:
                last_subjects = detect_visual_subjects(detection_frame)
                last_subject_sample = float(time_sec)

            metric_frame = cv2.resize(frame, (192, 108), interpolation=cv2.INTER_AREA)
            gray = cv2.cvtColor(metric_frame, cv2.COLOR_BGR2GRAY)
            hsv = cv2.cvtColor(metric_frame, cv2.COLOR_BGR2HSV)
            brightness = float(np.mean(gray)) / 255.0
            contrast = float(np.std(gray)) / 64.0
            exposure = clamp(1.0 - abs(brightness - 0.52) / 0.52) * clamp(contrast)
            saturation = clamp(float(np.mean(hsv[:, :, 1])) / 150.0)
            sharpness = clamp(float(cv2.Laplacian(gray, cv2.CV_64F).var()) / 900.0)
            motion = 0.0 if previous_gray is None else clamp(float(np.mean(cv2.absdiff(previous_gray, gray))) / 34.0)
            hist = cv2.calcHist([hsv], [0, 1], None, [24, 24], [0, 180, 0, 256])
            cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
            scene = 0.0 if previous_hist is None else clamp(cv2.compareHist(previous_hist, hist, cv2.HISTCMP_BHATTACHARYYA) * 1.5)
            score = _goal_score(
                str(settings["goal"]), motion=motion, scene=scene,
                sharpness=sharpness, saturation=saturation, exposure=exposure,
                subject_quality=_subject_quality(last_subjects),
            )
            # Black, badly exposed, or almost featureless frames should not
            # become a hook simply because a fade caused a large difference.
            if brightness < 0.045 or exposure < 0.05:
                score *= 0.12
            features.append({
                "time": float(time_sec), "score": score, "motion": motion,
                "scene": scene, "sharpness": sharpness,
                "saturation": saturation, "exposure": exposure,
                "subjects": [dict(item) for item in last_subjects],
                "subject_quality": _subject_quality(last_subjects),
            })
            previous_gray, previous_hist = gray, hist
    finally:
        capture.release()

    candidates: list[Candidate] = []
    if features:
        ordered = sorted(range(len(features)), key=lambda index: features[index]["score"], reverse=True)
        candidate_limit = 480 if montage_format == "horizontal_longform" else 24
        maximum_candidates = max(
            4,
            min(candidate_limit, math.ceil(source.duration / max(minimum, 0.8))),
        )
        for index in ordered:
            feature = features[index]
            if feature["score"] <= 0.04:
                continue
            duration = minimum + (maximum - minimum) * (0.35 + 0.35 * (1.0 - feature["motion"]))
            start, end = snap_window_to_safe_boundaries(features, index, duration, source.duration)
            if end - start < 0.65:
                continue
            overlap = any(
                max(0.0, min(end, item.end) - max(start, item.start))
                / min(end - start, item.duration)
                > MAX_REUSED_SOURCE_OVERLAP
                for item in candidates
            )
            if overlap:
                continue
            framing = choose_subject_focus(features, index, start, end)
            framing_plan = portrait_framing(
                source.width,
                source.height,
                int(settings["output_width"]),
                int(settings["output_height"]),
                subject_x=float(framing["x"]),
                subject_y=float(framing["y"]),
                subject_kind=str(framing["kind"]),
                subject_left=framing["left"],
                subject_top=framing["top"],
                subject_right=framing["right"],
                subject_bottom=framing["bottom"],
            )
            reasons = []
            if framing["kind"] == "face": reasons.append("face-aware portrait framing")
            elif framing["kind"] == "person": reasons.append("person-aware costume framing")
            if framing_plan["mode"] == "contextual_contain":
                reasons.append("full-costume safe framing")
            if feature["motion"] >= 0.42: reasons.append("motion peak")
            if feature["scene"] >= 0.34: reasons.append("clean scene change")
            if feature["sharpness"] >= 0.55: reasons.append("sharp subject detail")
            if feature["saturation"] >= 0.55: reasons.append("strong costume color")
            if not reasons: reasons.append("strong visual moment")
            reasons.append("safe action boundaries")
            candidates.append(Candidate(
                id=f"{source.id}-shot-{len(candidates) + 1:03d}",
                source_id=source.id, source_order=source.order,
                source_path=source.path, source_name=source.name,
                start=round(start, 3), end=round(end, 3),
                score=round(float(feature["score"]), 6),
                motion=round(float(feature["motion"]), 6),
                scene_change=round(float(feature["scene"]), 6),
                reasons=reasons[:3],
                subject_x=float(framing["x"]),
                subject_y=float(framing["y"]),
                subject_kind=str(framing["kind"]),
                subject_confidence=float(framing["confidence"]),
                subject_count=int(framing["count"]),
                subject_left=framing["left"],
                subject_top=framing["top"],
                subject_right=framing["right"],
                subject_bottom=framing["bottom"],
                framing_mode=str(framing_plan["mode"]),
            ))
            if len(candidates) >= maximum_candidates:
                break
    if not candidates:
        candidates = fallback_candidates(source, settings)
    return candidates


def fallback_candidates(source: SourceInfo, settings: Mapping[str, Any]) -> list[Candidate]:
    montage_format = str(settings.get("format", "vertical_short"))
    minimum, maximum = _shot_range(str(settings["pacing"]), montage_format)
    duration = min(maximum, max(0.7, source.duration / 3.0))
    candidate_limit = 480 if montage_format == "horizontal_longform" else 4
    count = max(1, min(candidate_limit, int(source.duration / max(duration, 0.7))))
    output = []
    for index in range(count):
        center = source.duration * ((index + 1) / (count + 1))
        start = max(0.0, min(source.duration - duration, center - duration / 2))
        end = min(source.duration, start + duration)
        output.append(Candidate(
            id=f"{source.id}-fallback-{index + 1:03d}", source_id=source.id,
            source_order=source.order, source_path=source.path,
            source_name=source.name, start=round(start, 3), end=round(end, 3),
            score=0.08, motion=0.0, scene_change=0.0,
            reasons=["evenly spaced fallback"],
        ))
    return output


def temporal_overlap(first: Candidate, second: Candidate) -> float:
    if first.source_id != second.source_id:
        return 0.0
    intersection = max(0.0, min(first.end, second.end) - max(first.start, second.start))
    denominator = max(0.001, min(first.duration, second.duration))
    return intersection / denominator


def _creator_transition_ordinal(clip_number: int) -> int | None:
    """Return a stable transition ordinal at alternating 3/4-clip gaps.

    One-based outgoing clip positions are 3, 7, 10, 14, 17, 21... This
    produces the sparse, varied rhythm common in automatic Shorts editors
    without decorating every join.
    """
    quotient, remainder = divmod(max(0, int(clip_number)), 7)
    if remainder == 3:
        return quotient * 2
    if remainder == 0 and clip_number > 0:
        return quotient * 2 - 1
    return None


def _transition_for(shot: Candidate, index: int, settings: Mapping[str, Any]) -> dict[str, Any]:
    mode = settings["transition_mode"]
    if mode == "none":
        return {"kind": "cut", "duration": 0.0}
    if mode == "minimal":
        return {"kind": "fade", "duration": 0.10 if settings["pacing"] in {"rapid", "fast"} else 0.16}
    ordinal = _creator_transition_ordinal(index + 1)
    if ordinal is None:
        return {"kind": "cut", "duration": 0.0, "reason": "clean action cut"}
    kind, label = CREATOR_TRANSITIONS[ordinal % len(CREATOR_TRANSITIONS)]
    duration = {"rapid": 0.16, "fast": 0.22, "balanced": 0.30, "cinematic": 0.38}[settings["pacing"]]
    return {
        "kind": kind,
        "duration": duration,
        "label": label,
        "reason": "creator transition after 3 or 4 clips",
    }


def _space_repeated_sources(
    items: Sequence[Candidate],
    *,
    order_mode: str,
) -> list[Candidate]:
    """Distribute repeated source clips without ever creating adjacent repeats."""
    remaining = list(items)
    # A no-repeat sequence exists only when the most frequent source has no
    # more shots than all other sources combined plus one. If analysis selected
    # an impossible imbalance, discard that source's weakest excess moments
    # instead of publishing two cuts from the same upload back-to-back.
    while remaining:
        counts = Counter(item.source_id for item in remaining)
        dominant_id, dominant_count = max(
            counts.items(),
            key=lambda pair: (pair[1], -min(
                item.source_order for item in remaining if item.source_id == pair[0]
            )),
        )
        other_count = len(remaining) - dominant_count
        if dominant_count <= other_count + 1:
            break
        weakest = min(
            (item for item in remaining if item.source_id == dominant_id),
            key=lambda item: (item.score, item.motion, -item.start, item.id),
        )
        remaining.remove(weakest)

    grouped: dict[str, list[Candidate]] = defaultdict(list)
    for item in remaining:
        grouped[item.source_id].append(item)
    if not grouped:
        return []

    source_order = {
        source_id: min(item.source_order for item in source_items)
        for source_id, source_items in grouped.items()
    }
    source_peak = {
        source_id: max(item.score for item in source_items)
        for source_id, source_items in grouped.items()
    }
    original_counts = {source_id: len(source_items) for source_id, source_items in grouped.items()}
    remaining_counts = dict(original_counts)
    placed_counts: Counter[str] = Counter()
    source_sequence: list[str] = []
    previous_source: str | None = None

    def can_finish_after(source_id: str) -> bool:
        after = dict(remaining_counts)
        after[source_id] -= 1
        total_after = sum(after.values())
        for candidate_source, count in after.items():
            other_count = total_after - count
            # The source just emitted cannot occupy the first remaining slot,
            # so it has one fewer legal separator slot than every other source.
            maximum = other_count if candidate_source == source_id else other_count + 1
            if count > maximum:
                return False
        return True

    for _position in range(len(remaining)):
        eligible = [
            source_id for source_id, count in remaining_counts.items()
            if count > 0 and source_id != previous_source
        ]
        safe = [source_id for source_id in eligible if can_finish_after(source_id)]
        if not safe:
            raise RuntimeError("Could not distribute repeated source clips safely")

        def source_priority(source_id: str) -> tuple[float, int, float, int, str]:
            # Ideal occurrence centers are 1/(2n), 3/(2n), ... across the
            # finished sequence. Choosing the next earliest center distributes
            # both frequent and singleton sources across the full montage.
            next_due = (placed_counts[source_id] + 0.5) / original_counts[source_id]
            mode_priority = (
                float(source_order[source_id])
                if order_mode == "manual"
                else -float(source_peak[source_id])
            )
            return (
                next_due,
                original_counts[source_id],
                mode_priority,
                source_order[source_id],
                source_id,
            )

        chosen_source = min(safe, key=source_priority)
        source_sequence.append(chosen_source)
        remaining_counts[chosen_source] -= 1
        placed_counts[chosen_source] += 1
        previous_source = chosen_source

    ordered: list[Candidate] = []
    total = len(source_sequence)
    for position, source_id in enumerate(source_sequence):
        choices = grouped[source_id]
        if order_mode == "manual":
            chosen = min(choices, key=lambda item: (item.start, -item.score, item.id))
        elif position == 0 or position == total - 1:
            chosen = max(choices, key=lambda item: (item.score, item.motion, -item.start))
        else:
            target_energy = 0.35 + 0.55 * (position / max(1, total - 1))
            chosen = min(
                choices,
                key=lambda item: (
                    abs(item.score - target_energy) - item.motion * 0.08,
                    -item.score,
                    item.start,
                ),
            )
        ordered.append(chosen)
        choices.remove(chosen)

    if any(left.source_id == right.source_id for left, right in zip(ordered, ordered[1:])):
        raise RuntimeError("Repeated source clips could not be safely separated")
    return ordered


def _space_longform_sources(
    items: Sequence[Candidate],
    *,
    order_mode: str,
) -> list[Candidate]:
    """Sequence long-form moments without discarding valid selections.

    Manual mode preserves upload order and source chronology. Automatic mode
    prefers alternating sources, but may emit a repeat when no other source has
    an unplaced moment.
    """
    if order_mode == "manual":
        return sorted(
            items,
            key=lambda item: (item.source_order, item.start, -item.score, item.id),
        )

    grouped: dict[str, list[Candidate]] = defaultdict(list)
    for item in items:
        grouped[item.source_id].append(item)
    if not grouped:
        return []

    source_order = {
        source_id: min(item.source_order for item in source_items)
        for source_id, source_items in grouped.items()
    }
    source_peak = {
        source_id: max(item.score for item in source_items)
        for source_id, source_items in grouped.items()
    }
    original_counts = {
        source_id: len(source_items) for source_id, source_items in grouped.items()
    }
    remaining_counts = dict(original_counts)
    placed_counts: Counter[str] = Counter()
    source_sequence: list[str] = []
    previous_source: str | None = None

    for _position in range(len(items)):
        alternatives = [
            source_id for source_id, count in remaining_counts.items()
            if count > 0 and source_id != previous_source
        ]
        eligible = alternatives or [
            source_id for source_id, count in remaining_counts.items() if count > 0
        ]

        def source_priority(source_id: str) -> tuple[float, float, int, str]:
            next_due = (placed_counts[source_id] + 0.5) / original_counts[source_id]
            mode_priority = -float(source_peak[source_id])
            return next_due, mode_priority, source_order[source_id], source_id

        chosen_source = min(eligible, key=source_priority)
        source_sequence.append(chosen_source)
        remaining_counts[chosen_source] -= 1
        placed_counts[chosen_source] += 1
        previous_source = chosen_source

    ordered: list[Candidate] = []
    total = len(source_sequence)
    for position, source_id in enumerate(source_sequence):
        choices = grouped[source_id]
        if position == 0 or position == total - 1:
            chosen = max(choices, key=lambda item: (item.score, item.motion, -item.start))
        else:
            target_energy = 0.35 + 0.55 * (position / max(1, total - 1))
            chosen = min(
                choices,
                key=lambda item: (
                    abs(item.score - target_energy) - item.motion * 0.08,
                    -item.score,
                    item.start,
                ),
            )
        ordered.append(chosen)
        choices.remove(chosen)
    return ordered


def select_timeline(candidates_by_source: Sequence[Sequence[Candidate]], settings: Mapping[str, Any]) -> list[Candidate]:
    pools = [sorted(list(items), key=lambda item: (-item.score, item.start)) for items in candidates_by_source if items]
    horizontal_longform = str(settings.get("format", "vertical_short")) == "horizontal_longform"
    minimum_sources = 1 if horizontal_longform else 2
    if len(pools) < minimum_sources:
        raise RuntimeError("At least two valid source clips are required")
    target = float(settings["target_duration_sec"])
    minimum, maximum = _shot_range(
        str(settings["pacing"]),
        str(settings.get("format", "vertical_short")),
    )
    timeline_limit = 480 if horizontal_longform else 80
    minimum_shots = 1 if horizontal_longform else 2
    expected = max(
        minimum_shots,
        min(timeline_limit, math.ceil(target / ((minimum + maximum) / 2))),
    )
    if settings["selection_mode"] == "use_every_clip":
        expected = max(expected, len(pools))

    selected: list[Candidate] = []
    used_ids: set[str] = set()
    if settings["selection_mode"] == "use_every_clip":
        for pool in pools:
            selected.append(pool[0])
            used_ids.add(pool[0].id)

    flattened = sorted((item for pool in pools for item in pool), key=lambda item: (-item.score, item.source_order, item.start))
    while len(selected) < expected:
        available = [
            item for item in flattened
            if item.id not in used_ids
            and all(
                temporal_overlap(item, prior) <= MAX_REUSED_SOURCE_OVERLAP
                for prior in selected
            )
        ]
        if not available:
            break
        source_counts = Counter(item.source_id for item in selected)
        represented = set(source_counts)
        if len(represented) < 2:
            different_source = [item for item in available if item.source_id not in represented]
        else:
            different_source = []
        choices = different_source or available
        feasible_choices = list(choices) if horizontal_longform else []
        if not horizontal_longform:
            for item in choices:
                prospective = Counter(source_counts)
                prospective[item.source_id] += 1
                total = sum(prospective.values())
                dominant = max(prospective.values())
                if dominant <= total - dominant + 1:
                    feasible_choices.append(item)
        if not feasible_choices:
            break
        chosen = max(
            feasible_choices,
            key=lambda item: (
                item.score
                - source_counts[item.source_id] * 0.16
                + (0.10 if item.source_id not in represented else 0.0),
                item.motion,
                -item.source_order,
                -item.start,
            ),
        )
        selected.append(chosen)
        used_ids.add(chosen.id)

    if horizontal_longform:
        selected = _space_longform_sources(
            selected,
            order_mode=str(settings["order_mode"]),
        )
    else:
        selected = _space_repeated_sources(
            selected,
            order_mode=str(settings["order_mode"]),
        )

    # Stop near the requested duration while keeping at least one moment from
    # every source when that mode was requested.
    final: list[Candidate] = []
    elapsed = 0.0
    required_ids = {pool[0].source_id for pool in pools} if settings["selection_mode"] == "use_every_clip" else set()
    for item in selected:
        missing_required = required_ids - {shot.source_id for shot in final}
        if final and elapsed >= target * 0.96 and item.source_id not in missing_required:
            continue
        transition = _transition_for(item, len(final), settings)
        item.transition_out = transition
        overlap = float((final[-1].transition_out or {}).get("duration", 0.0)) if final else 0.0
        projected = elapsed + item.duration - overlap
        final.append(item)
        elapsed = projected
    if not final:
        raise RuntimeError("No usable action moments were selected")
    if len({item.id for item in final}) != len(final):
        raise RuntimeError("A selected montage moment was repeated")
    if not horizontal_longform and any(
        left.source_id == right.source_id for left, right in zip(final, final[1:])
    ):
        raise RuntimeError("Repeated source clips were not safely separated")
    if any(
        temporal_overlap(left, right) > MAX_REUSED_SOURCE_OVERLAP
        for index, left in enumerate(final)
        for right in final[index + 1:]
        if left.source_id == right.source_id
    ):
        raise RuntimeError("Overlapping moments from one source were selected")
    final[-1].transition_out = {"kind": "cut", "duration": 0.0}
    return final


def estimated_duration(timeline: Sequence[Candidate]) -> float:
    total = sum(item.duration for item in timeline)
    overlaps = sum(float((item.transition_out or {}).get("duration", 0.0)) for item in timeline[:-1])
    return max(0.0, total - overlaps)


def source_spacing_summary(timeline: Sequence[Candidate]) -> dict[str, Any]:
    positions: dict[str, list[int]] = defaultdict(list)
    for position, item in enumerate(timeline):
        positions[item.source_id].append(position)
    intervening = [
        right - left - 1
        for source_positions in positions.values()
        for left, right in zip(source_positions, source_positions[1:])
    ]
    reused_overlaps = [
        temporal_overlap(left, right)
        for index, left in enumerate(timeline)
        for right in timeline[index + 1:]
        if left.source_id == right.source_id
    ]
    return {
        "unique_moments": len({item.id for item in timeline}) == len(timeline),
        "adjacent_repeats": any(
            left.source_id == right.source_id
            for left, right in zip(timeline, timeline[1:])
        ),
        "repeated_source_count": sum(len(source_positions) > 1 for source_positions in positions.values()),
        "minimum_intervening_shots": min(intervening) if intervening else None,
        "maximum_reused_source_overlap": round(max(reused_overlaps), 5) if reused_overlaps else 0.0,
    }


def _normalization_filter(
    source: SourceInfo,
    shot: Candidate,
    width: int,
    height: int,
    fps: int,
) -> str:
    framing = portrait_framing(
        source.width,
        source.height,
        width,
        height,
        subject_x=shot.subject_x,
        subject_y=shot.subject_y,
        subject_kind=shot.subject_kind,
        subject_left=shot.subject_left,
        subject_top=shot.subject_top,
        subject_right=shot.subject_right,
        subject_bottom=shot.subject_bottom,
    )
    if framing["mode"] == "contextual_contain":
        region_width, region_height, region_x, region_y = framing["region"]
        scale = min(width / region_width, height / region_height)
        foreground_width = max(2, int(region_width * scale) // 2 * 2)
        foreground_height = max(2, int(region_height * scale) // 2 * 2)
        return (
            f"crop={region_width}:{region_height}:{region_x}:{region_y},"
            f"scale={foreground_width}:{foreground_height}:flags=lanczos,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,"
            f"setsar=1,fps={fps},format=yuv420p"
        )
    crop_width, crop_height, crop_x, crop_y = framing["crop"]
    return (
        f"crop={crop_width}:{crop_height}:{crop_x}:{crop_y},"
        f"scale={width}:{height}:flags=lanczos,setsar=1,fps={fps},format=yuv420p"
    )


def _normalization_video_filter(
    source: SourceInfo,
    shot: Candidate,
    width: int,
    height: int,
    fps: int,
) -> str:
    """Build a labeled video graph with a contextual full-subject fallback."""
    framing = portrait_framing(
        source.width,
        source.height,
        width,
        height,
        subject_x=shot.subject_x,
        subject_y=shot.subject_y,
        subject_kind=shot.subject_kind,
        subject_left=shot.subject_left,
        subject_top=shot.subject_top,
        subject_right=shot.subject_right,
        subject_bottom=shot.subject_bottom,
    )
    if framing["mode"] != "contextual_contain":
        crop_width, crop_height, crop_x, crop_y = framing["crop"]
        return (
            f"[0:v:0]crop={crop_width}:{crop_height}:{crop_x}:{crop_y},"
            f"scale={width}:{height}:flags=lanczos,setsar=1,fps={fps},format=yuv420p[v]"
        )

    region_width, region_height, region_x, region_y = framing["region"]
    scale = min(width / region_width, height / region_height)
    foreground_width = max(2, int(region_width * scale) // 2 * 2)
    foreground_height = max(2, int(region_height * scale) // 2 * 2)
    return (
        "[0:v:0]split=2[background-source][foreground-source];"
        f"[background-source]scale={width}:{height}:force_original_aspect_ratio=increase:flags=fast_bilinear,"
        f"crop={width}:{height},boxblur=20:1,eq=brightness=-0.08:saturation=0.72[background];"
        f"[foreground-source]crop={region_width}:{region_height}:{region_x}:{region_y},"
        f"scale={foreground_width}:{foreground_height}:flags=lanczos,setsar=1[foreground];"
        f"[background][foreground]overlay=(W-w)/2:(H-h)/2:shortest=1,"
        f"setsar=1,fps={fps},format=yuv420p[v]"
    )


def render_intermediate(
    shot: Candidate,
    source: SourceInfo,
    output: Path,
    settings: Mapping[str, Any],
    *,
    ffmpeg_bin: str,
) -> None:
    duration = shot.duration
    command = [
        ffmpeg_bin, "-y", "-nostdin", "-v", "error",
        "-ss", f"{shot.start:.3f}", "-t", f"{duration:.3f}", "-i", source.path,
    ]
    audio_input = "0:a:0"
    if not source.has_audio:
        command += ["-f", "lavfi", "-t", f"{duration:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
        audio_input = "1:a:0"
    fade = min(0.04, duration / 4)
    audio_out_start = max(0.0, duration - fade)
    filters = (
        f"{_normalization_video_filter(source, shot, settings['output_width'], settings['output_height'], settings['fps'])};"
        f"[{audio_input}]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
        f"apad=pad_dur={duration:.3f},atrim=duration={duration:.3f},"
        f"afade=t=in:st=0:d={fade:.3f},afade=t=out:st={audio_out_start:.3f}:d={fade:.3f}[a]"
    )
    command += [
        "-filter_complex", filters, "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-movflags", "+faststart", "-shortest", str(output),
    ]
    run_command(command, timeout=max(300, duration * 30))


def build_join_filter(timeline: Sequence[Candidate], *, transitions: bool) -> tuple[str, str, str]:
    if not transitions:
        streams = "".join(f"[{index}:v:0][{index}:a:0]" for index in range(len(timeline)))
        return f"{streams}concat=n={len(timeline)}:v=1:a=1[vout][aout]", "[vout]", "[aout]"

    # concat emits AV_TIME_BASE while MP4 inputs commonly use a track-specific
    # timebase (for example 1/12288). Normalize every input first so a later
    # xfade can safely follow one or more hard-cut concat nodes.
    filters: list[str] = []
    for index in range(len(timeline)):
        filters.append(
            f"[{index}:v:0]settb=AVTB,setpts=PTS-STARTPTS[vin{index}]"
        )
        filters.append(
            f"[{index}:a:0]asettb=AVTB,asetpts=PTS-STARTPTS[ain{index}]"
        )
    video_current = "[vin0]"
    audio_current = "[ain0]"
    elapsed = timeline[0].duration
    for index in range(1, len(timeline)):
        transition = timeline[index - 1].transition_out or {"kind": "cut", "duration": 0.0}
        duration = max(0.0, float(transition.get("duration", 0.0)))
        kind = str(transition.get("kind", "fade"))
        next_video = f"[v{index}]"
        next_audio = f"[a{index}]"
        if kind == "cut" or duration <= 0.0:
            filters.append(
                f"{video_current}[vin{index}]concat=n=2:v=1:a=0{next_video}"
            )
            filters.append(
                f"{audio_current}[ain{index}]concat=n=2:v=0:a=1{next_audio}"
            )
            video_current, audio_current = next_video, next_audio
            elapsed += timeline[index].duration
            continue
        duration = max(0.04, duration)
        offset = max(0.01, elapsed - duration)
        filters.append(
            f"{video_current}[vin{index}]xfade=transition={kind}:duration={duration:.3f}:offset={offset:.3f}{next_video}"
        )
        filters.append(
            f"{audio_current}[ain{index}]acrossfade=d={duration:.3f}:c1=tri:c2=tri{next_audio}"
        )
        video_current, audio_current = next_video, next_audio
        elapsed += timeline[index].duration - duration
    return ";".join(filters), video_current, audio_current


def render_timeline(
    timeline: Sequence[Candidate], sources: Mapping[str, SourceInfo], output: Path,
    settings: Mapping[str, Any], *, ffmpeg_bin: str = "ffmpeg", work_dir: Path | None = None,
) -> bool:
    owned_temp = None
    if work_dir is None:
        owned_temp = tempfile.TemporaryDirectory(prefix="vcf-action-compilation-")
        work_dir = Path(owned_temp.name)
    work_dir.mkdir(parents=True, exist_ok=True)
    intermediates: list[Path] = []
    try:
        for index, shot in enumerate(timeline):
            print(f"ANALYSIS_PROGRESS normalize {index + 1}/{len(timeline)} {shot.source_name}", flush=True)
            intermediate = work_dir / f"shot-{index:03d}.mp4"
            render_intermediate(shot, sources[shot.source_id], intermediate, settings, ffmpeg_bin=ffmpeg_bin)
            intermediates.append(intermediate)

        def join(use_transitions: bool) -> None:
            command = [ffmpeg_bin, "-y", "-nostdin", "-v", "error"]
            for item in intermediates:
                command += ["-i", str(item)]
            filters, video_map, audio_map = build_join_filter(timeline, transitions=use_transitions)
            command += [
                "-filter_complex", filters, "-map", video_map, "-map", audio_map,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-f", "mp4", str(output),
            ]
            run_command(command, timeout=max(600, estimated_duration(timeline) * 45))

        transitions_requested = settings["transition_mode"] != "none" and len(timeline) > 1
        try:
            join(transitions_requested)
            return False
        except RuntimeError as error:
            if not transitions_requested:
                raise
            print(f"⚠️ Transition render failed ({error}); retrying with clean hard cuts", flush=True)
            join(False)
            return True
    finally:
        if owned_temp is not None:
            owned_temp.cleanup()


def load_manifest(path: Path, ffprobe_bin: str) -> tuple[dict[str, Any], list[SourceInfo]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    raw_settings = dict(data.get("settings") or {})
    if "format" not in raw_settings and data.get("format") is not None:
        raw_settings["format"] = data.get("format")
    settings = normalize_settings(raw_settings)
    raw_sources = data.get("sources")
    minimum_sources = 1 if settings["format"] == "horizontal_longform" else 2
    if not isinstance(raw_sources, list) or not minimum_sources <= len(raw_sources) <= 20:
        raise RuntimeError(
            f"Compilation manifest requires {minimum_sources} to 20 sources"
        )
    sources: list[SourceInfo] = []
    for index, item in enumerate(raw_sources):
        source_path = Path(str(item.get("path", ""))).resolve()
        if not source_path.is_file() or source_path.suffix.lower() not in VIDEO_EXTENSIONS:
            raise RuntimeError(f"Invalid compilation source: {source_path.name}")
        probed = probe_media(source_path, ffprobe_bin)
        sources.append(SourceInfo(
            id=str(item.get("id") or f"source-{index + 1:03d}"), path=probed.path,
            name=str(item.get("name") or probed.name), order=index,
            duration=probed.duration, width=probed.width, height=probed.height,
            has_audio=probed.has_audio,
        ))
    return {**data, "settings": settings}, sources


def compile_manifest(
    manifest_path: Path, output: Path, *, ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe", analysis_only: bool = False,
    work_dir: Path | None = None,
) -> dict[str, Any]:
    manifest, sources = load_manifest(manifest_path, ffprobe_bin)
    settings = manifest["settings"]
    candidates = []
    for index, source in enumerate(sources):
        print(f"ANALYSIS_PROGRESS analyze {index + 1}/{len(sources)} {source.name}", flush=True)
        candidates.append(analyze_source(source, settings))
    timeline = select_timeline(candidates, settings)
    fallback_used = False
    partial_output = output.with_suffix(output.suffix + ".part")
    sidecar = output.with_suffix(".json")
    sidecar_part = sidecar.with_suffix(sidecar.suffix + ".part")
    rendered_media: dict[str, Any] | None = None
    if not analysis_only:
        output.parent.mkdir(parents=True, exist_ok=True)
        for stale in (partial_output, sidecar_part):
            try:
                stale.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            fallback_used = render_timeline(
                timeline, {source.id: source for source in sources}, partial_output, settings,
                ffmpeg_bin=ffmpeg_bin, work_dir=work_dir,
            )
            print("ANALYSIS_PROGRESS validate 1/1 playback compatibility", flush=True)
            rendered_media = validate_rendered_output(
                partial_output,
                expected_duration=estimated_duration(timeline),
                expected_width=settings["output_width"],
                expected_height=settings["output_height"],
                ffmpeg_bin=ffmpeg_bin,
                ffprobe_bin=ffprobe_bin,
            )
        except BaseException:
            partial_output.unlink(missing_ok=True)
            sidecar_part.unlink(missing_ok=True)
            raise

    duration = (
        float(rendered_media["duration"])
        if rendered_media is not None
        else estimated_duration(timeline)
    )
    average_score = sum(item.score for item in timeline) / max(1, len(timeline))
    horizontal_longform = settings["format"] == "horizontal_longform"
    payload = {
        "kind": "longform" if horizontal_longform else "shorts",
        "source_kind": "action_compilation",
        "montage_format": settings["format"],
        "compilation_name": str(manifest.get("name") or output.stem),
        "source": str(output.resolve()),
        "start": 0.0,
        "end": round(duration, 3),
        "duration": round(duration, 3),
        "score": round(average_score * 100.0, 2),
        "candidate_score": round(average_score * 10.0, 3),
        "reasons": ["visual motion analysis", "multi-source diversity", "action-aware pacing"],
        "topics": ["action compilation", settings["goal"].replace("_", " ")],
        "words": [],
        "baked": True,
        "export_preset": "youtube_1080p" if horizontal_longform else "generic",
        "output_width": settings["output_width"],
        "output_height": settings["output_height"],
        "transition_fallback": fallback_used,
        "source_spacing": source_spacing_summary(timeline),
        "media_validation": (
            {**rendered_media, "passed": True}
            if rendered_media is not None
            else {"passed": False, "reason": "analysis_only"}
        ),
        "settings": settings,
        "sources": [
            {
                "id": source.id, "name": source.name, "order": source.order,
                "duration": source.duration, "width": source.width,
                "height": source.height, "has_audio": source.has_audio,
            }
            for source in sources
        ],
        "shots": [
            {
                **{key: value for key, value in asdict(item).items() if key != "source_path"},
                "duration": round(item.duration, 3),
            }
            for item in timeline
        ],
    }
    if analysis_only:
        sidecar.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    else:
        try:
            sidecar_part.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
            os.replace(sidecar_part, sidecar)
            os.replace(partial_output, output)
        except BaseException:
            partial_output.unlink(missing_ok=True)
            sidecar_part.unlink(missing_ok=True)
            if not output.exists():
                sidecar.unlink(missing_ok=True)
            raise
    print(json.dumps({"status": "pass", "output": str(output), "duration": duration, "shots": len(timeline)}), flush=True)
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Build a wordless action compilation from one or more videos")
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ffmpeg", default=os.environ.get("VCF_FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--ffprobe", default=os.environ.get("VCF_FFPROBE_PATH", "ffprobe"))
    parser.add_argument("--work-dir", type=Path, default=None)
    parser.add_argument("--analysis-only", action="store_true")
    parser.add_argument("--mode", default="action-compilation")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    signal.signal(signal.SIGTERM, _cancel_active_process)
    signal.signal(signal.SIGINT, _cancel_active_process)
    args = build_parser().parse_args(argv)
    try:
        compile_manifest(
            args.manifest.resolve(), args.output.resolve(), ffmpeg_bin=args.ffmpeg,
            ffprobe_bin=args.ffprobe, analysis_only=args.analysis_only,
            work_dir=args.work_dir.resolve() if args.work_dir else None,
        )
        return 0
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(f"Action compilation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
