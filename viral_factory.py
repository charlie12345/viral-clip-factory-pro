#!/usr/bin/env python3
import os
import sys
import signal
import time

# Fast paths only need cv2, yaml, subprocess, and json — skip the ML imports.
_LIGHTWEIGHT_MODES = {"rerender", "longform-edit"}
_REQUESTED_MODE = None
if '--mode' in sys.argv and sys.argv.index('--mode') + 1 < len(sys.argv):
    _REQUESTED_MODE = sys.argv[sys.argv.index('--mode') + 1]
_IS_RERENDER = _REQUESTED_MODE in _LIGHTWEIGHT_MODES or '--rerender-json' in sys.argv

import re
import shutil
import yaml
import subprocess
import cv2
import numpy as np
import json
import argparse
import tempfile
import warnings
import traceback

from hardware_accel import (
    available_video_backends,
    encoder_args,
    encoder_filter,
    encoder_global_args,
    run_with_encoder_fallback,
    select_compute_device,
    system_capabilities,
)
from export_presets import get_export_preset, safe_output_name
from speaker_tracking import (
    SmartSpeakerTracker,
    TrackingConfig,
    build_diarization_timeline,
    diarization_cue_at_time,
    merge_speaker_samples,
)
from longform_editor import (
    analyze_source,
    cuts_to_keep_segments,
    probe_duration,
    summarize_analysis,
    write_longform_sidecars,
)
from transcription_backends import probe_whisper_cpp, transcribe_media, whisper_cpp_model_name
from viral_intelligence import (
    GeminiVideoClient,
    LocalSemanticClient,
    build_candidate_windows,
    dedupe_temporal_candidates,
    ensemble_score,
    select_semantic_candidates,
    temporal_iou,
)
from shorts_yield import (
    active_speech_duration,
    build_yield_batch,
    confidence_tier,
    transcript_for_analysis_range,
)

# Graceful cancel — the dashboard sends SIGTERM to stop a running job.
# We set a flag that long-running loops should poll; if SIGTERM arrives
# twice (or after the grace period), we hard-exit.
_CANCEL_REQUESTED = False

def _on_sigterm(signum, frame):
    global _CANCEL_REQUESTED
    _CANCEL_REQUESTED = True
    print('⚠️  Cancel signal received — finishing current step and exiting…', flush=True)

def _on_sigint(signum, frame):
    global _CANCEL_REQUESTED
    _CANCEL_REQUESTED = True
    print('⚠️  Interrupt received — finishing current step and exiting…', flush=True)

try:
    signal.signal(signal.SIGTERM, _on_sigterm)
    signal.signal(signal.SIGINT, _on_sigint)
except (ValueError, OSError):
    pass  # not main thread (subprocess) — ignore

def is_cancelled():
    return _CANCEL_REQUESTED

def raise_if_cancelled():
    if _CANCEL_REQUESTED:
        raise KeyboardInterrupt('cancelled')

try:
    sys.stdout.reconfigure(line_buffering=True)
    sys.stderr.reconfigure(line_buffering=True)
except Exception:
    pass

if not _IS_RERENDER:
    # Suppress deprecation warnings from face_recognition
    warnings.filterwarnings('ignore', category=UserWarning, module='face_recognition_models')
    warnings.filterwarnings('ignore', message='.*pkg_resources is deprecated.*')

    import whisper
    import torch
    import face_recognition
    from ultralytics import YOLO

    try:
        import librosa
        LIBROSA_AVAILABLE = True
    except ImportError:
        LIBROSA_AVAILABLE = False
        print("⚠️  librosa not installed - emotion analysis will be limited")
else:
    import types
    torch = types.SimpleNamespace(
        cuda=types.SimpleNamespace(
            is_available=lambda: False,
            empty_cache=lambda: None
        )
    )
    LIBROSA_AVAILABLE = False

# Resolve paths relative to this script so the app works from any CWD
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Load Config
with open(os.path.join(_SCRIPT_DIR, "clip_config.yaml"), "r") as f:
    CONFIG = yaml.safe_load(f)

RUNTIME_HARDWARE = {
    "compute_device": "auto",
    "video_encoder": "auto",
    "vaapi_device": os.environ.get("VCF_VAAPI_DEVICE", "/dev/dri/renderD128"),
    "ffmpeg_bin": os.environ.get("VCF_FFMPEG_PATH", "ffmpeg"),
    "ffprobe_bin": os.environ.get("VCF_FFPROBE_PATH", "ffprobe"),
    "transcription_provider": "auto",
    "transcription_model": None,
    "transcription_language": "auto",
    "resolved_transcription_provider": None,
    "transcription_topics": [],
    "local_semantic": False,
    "gemini_analysis": False,
    "resolved_compute": "cpu",
    "resolved_video_encoder": None,
}

# Constants
TEMP_DIR = os.path.join(_SCRIPT_DIR, "temp_processing")
OUTPUT_DIR = os.path.join(_SCRIPT_DIR, "viral_clips")
SOURCES_DIR = os.path.join(OUTPUT_DIR, "_sources")
CANDIDATE_MANIFESTS_DIR = os.path.join(OUTPUT_DIR, "_candidate_manifests")

# Ensure Dirs
if not os.path.exists(TEMP_DIR): os.makedirs(TEMP_DIR)
if not os.path.exists(OUTPUT_DIR): os.makedirs(OUTPUT_DIR)
if not os.path.exists(SOURCES_DIR): os.makedirs(SOURCES_DIR)
if not os.path.exists(CANDIDATE_MANIFESTS_DIR): os.makedirs(CANDIDATE_MANIFESTS_DIR)


def gpu_acceleration_enabled():
    return bool(CONFIG.get("processing", {}).get("gpu_acceleration", True))


def configured_video_backends(is_hdr=False):
    backends = available_video_backends(
        RUNTIME_HARDWARE["video_encoder"],
        RUNTIME_HARDWARE["ffmpeg_bin"],
        RUNTIME_HARDWARE["vaapi_device"],
        is_hdr,
        gpu_acceleration_enabled(),
    )
    requested = RUNTIME_HARDWARE["video_encoder"]
    if requested not in ("auto", "cpu") and backends[0] != requested:
        print(f"  > Requested encoder '{requested}' is unavailable; falling back to {backends[0]}")
    return backends


def build_encoder_command_prefix(backend):
    return [
        RUNTIME_HARDWARE["ffmpeg_bin"],
        *encoder_global_args(backend, RUNTIME_HARDWARE["vaapi_device"]),
    ]


def resolve_compute_device():
    device, backend = select_compute_device(
        RUNTIME_HARDWARE["compute_device"],
        torch,
        gpu_acceleration_enabled(),
    )
    RUNTIME_HARDWARE["resolved_compute"] = backend
    return device, backend


def load_whisper_model():
    model_name = RUNTIME_HARDWARE["transcription_model"] or CONFIG["transcription"]["model_size"]
    device, backend = resolve_compute_device()
    print(f"  > Compute backend: {backend.upper()}")
    model_cache = os.path.expanduser(f"~/.cache/whisper/{model_name}.pt")
    model = whisper.load_model(model_cache if os.path.isfile(model_cache) else model_name, device=device)
    return model, device, backend


def transcribe_source(media_path):
    """Transcribe with the requested backend and fall back to another local backend.

    Auto mode never selects a cloud service. Deepgram is attempted only when the
    job explicitly requests it; a cloud/configuration failure falls back locally
    so a long render is not discarded after upload and preprocessing.
    """
    requested = str(RUNTIME_HARDWARE.get("transcription_provider") or "auto")
    model_name = RUNTIME_HARDWARE.get("transcription_model") or CONFIG["transcription"]["model_size"]
    requested_language = str(RUNTIME_HARDWARE.get("transcription_language") or "auto").strip().lower()
    backend_language = None if requested_language == "auto" else requested_language
    cpp_model_path = os.environ.get("VCF_WHISPER_CPP_MODEL")
    cpp_model_name = whisper_cpp_model_name(cpp_model_path)
    _, compute_backend = resolve_compute_device()
    accelerated = compute_backend in ("cuda", "rocm")
    cpp_probe = probe_whisper_cpp(
        executable=os.environ.get("VCF_WHISPER_CPP_PATH"),
        model_path=cpp_model_path,
    )
    cpp_available = bool(cpp_probe.get("available"))
    preferred_local = ["openai_whisper", "whisper_cpp"] if accelerated else ["whisper_cpp", "openai_whisper"]
    if not cpp_available:
        preferred_local = [provider for provider in preferred_local if provider != "whisper_cpp"]

    if requested == "auto":
        attempts = preferred_local
    elif requested == "deepgram":
        attempts = ["deepgram", *preferred_local]
    elif requested == "whisper_cpp":
        attempts = ["whisper_cpp", "openai_whisper"]
    else:
        attempts = ["openai_whisper"] + (["whisper_cpp"] if cpp_available else [])

    attempts = list(dict.fromkeys(attempts))
    failures = []
    for provider in attempts:
        model = None
        device = None
        try:
            if provider == "openai_whisper":
                print(f"🎙️ Transcribing with PyTorch Whisper ({model_name})...")
                model, device, _ = load_whisper_model()
                result = transcribe_media(
                    media_path,
                    provider=provider,
                    whisper_model=model,
                    openai_model_name=model_name,
                    openai_accelerated=accelerated,
                    openai_options={"verbose": False, "word_timestamps": True},
                    language=backend_language,
                    ffmpeg_bin=RUNTIME_HARDWARE["ffmpeg_bin"],
                )
            elif provider == "whisper_cpp":
                print(f"🎙️ Transcribing with whisper.cpp ({cpp_model_name})...")
                result = transcribe_media(
                    media_path,
                    provider=provider,
                    whisper_cpp_executable=os.environ.get("VCF_WHISPER_CPP_PATH"),
                    whisper_cpp_model_path=cpp_model_path,
                    language=requested_language,
                    ffmpeg_bin=RUNTIME_HARDWARE["ffmpeg_bin"],
                )
            else:
                print("🎙️ Transcribing with Deepgram Nova-3 (cloud opt-in)...")
                result = transcribe_media(
                    media_path,
                    provider=provider,
                    deepgram_model="nova-3",
                    language=backend_language,
                    ffmpeg_bin=RUNTIME_HARDWARE["ffmpeg_bin"],
                )

            RUNTIME_HARDWARE["resolved_transcription_provider"] = result.get("provider", provider)
            RUNTIME_HARDWARE["transcription_model"] = result.get("model") or model_name
            RUNTIME_HARDWARE["transcription_topics"] = result.get("topics", []) or []
            print(
                f"  > Transcription provider: {RUNTIME_HARDWARE['resolved_transcription_provider']}"
                f" | segments: {len(result.get('segments', []))}"
            )
            return result
        except Exception as error:
            failures.append(f"{provider}: {error}")
            if len(attempts) > 1:
                print(f"  ⚠️  {provider} transcription unavailable ({error}); trying fallback...")
        finally:
            if model is not None:
                del model
            if device is not None:
                release_compute_cache(device)

    raise RuntimeError("All transcription providers failed: " + " | ".join(failures))


def release_compute_cache(device):
    if device == "cuda":
        torch.cuda.empty_cache()

GENERIC_KEYWORDS = {
    "best", "most", "least", "show", "review", "reaction", "story", "movie",
    "film", "show", "series", "game", "gaming", "tech", "money", "music",
    "fashion", "style", "brand", "theory", "new", "latest", "recent", "bro",
    "dude", "literally", "actually", "honestly", "seriously", "viral",
}

HOOK_PHRASES = [
    "let me tell you", "here's the thing", "you need to know", "nobody talks about",
    "the truth is", "you won't believe", "this is huge", "breaking", "exclusive",
    "first look", "revealed", "leaked", "unpopular opinion", "hot take",
    "before you go", "real quick", "by the way", "fun fact", "did you know",
    "believe it or not", "get this", "guess what", "plot twist", "surprise",
    "never seen before", "rare footage", "caught on camera", "happening now",
    "they don't want you to know", "wake up", "red pill", "rabbit hole",
]

QUESTION_OPENERS = [
    "why", "how", "what if", "what happens when", "ever wondered", "did you know",
    "have you noticed", "want to know", "guess what",
]

CURIOSITY_PHRASES = [
    "but here's what", "what happened next", "turns out", "the reason is",
    "the trick is", "the secret is", "and then", "but then", "here's why",
    "this is when", "the crazy part", "the wild part",
]

PAYOFF_PHRASES = [
    "that's why", "which means", "the answer is", "the reason is", "the point is",
    "what i learned", "what happened was", "the result was", "so the fix is",
    "so the trick is", "in the end", "bottom line", "that's how", "therefore",
    "it works because", "this is why", "that was the moment", "turns out",
]

VALUE_PATTERNS = [
    "here's how", "step by step", "tutorial", "guide", "breakdown", "explained",
    "the trick", "the secret", "mistake", "never do this", "always do this",
    "stop doing", "start doing", "what to do", "what not to do",
]

CONTROVERSY_PHRASES = [
    "unpopular opinion", "hot take", "controversial", "people are mad", "backlash",
    "cancelled", "drama", "beef", "exposed", "called out", "clapped back",
    "went off", "destroyed", "ratio", "most people think", "what they don't tell you",
]

PERSONAL_MARKERS = [
    "i was", "i remember", "when i", "let me tell you about", "my story",
    "it happened to me", "i've been", "i had", "true story", "personal experience",
    "i used to", "growing up",
]

SOCIAL_PROOF_PHRASES = [
    "million", "billion", "everyone", "most people", "studies show", "research shows",
    "scientists", "experts say", "proven", "thousands", "according to",
    "statistically", "data shows", "survey", "study found", "percent of people",
]

URGENCY_PHRASES = [
    "right now", "don't wait", "before it's too late", "you need to act",
    "immediately", "urgent", "deadline", "limited time", "running out",
    "last chance", "while you can", "disappears", "going away", "won't last",
]

CLIFFHANGER_PHRASES = [
    "and then", "but then", "what happened next", "turns out", "the twist is",
    "you won't believe what", "suddenly", "out of nowhere", "this is when",
    "everything changed", "and that's when", "here's what happened", "the moment",
]

LIST_PATTERNS = [
    "number one", "number two", "number three", "#1", "#2", "#3", "first,",
    "second,", "third,", "three things", "five ways", "top 10", "top 5",
    "here are", "the reasons", "steps to",
]

CONTRAST_PHRASES = [
    "but now", "everything changed", "used to", "not anymore", "i thought",
    "i was wrong", "the opposite", "completely different", "before i knew",
    "changed my life", "what i learned", "the reality is", "most people think",
    "what they don't tell you",
]

EXCLAMATION_TRIGGERS = [
    "!", "oh my god", "holy", "no way", "wow", "damn", "insane", "crazy",
    "unbelievable", "incredible", "amazing", "shocking", "epic", "wild",
]

NUMBER_PATTERNS = [
    r"\d+%",
    r"\$\d+",
    r"\d+ (million|billion|thousand|hundred)",
    r"(top|number) \d+",
    r"\d+ (times|years|days|hours|minutes)",
    r"\d+x",
]

BAD_OPENERS = {
    "and", "so", "but", "because", "well", "um", "uh", "like", "anyway", "okay",
}

FILLER_WORDS = {
    "um", "uh", "like", "literally", "actually", "basically", "honestly",
    "seriously", "really", "just",
}

FILLER_PHRASES = [
    "you know", "i mean", "sort of", "kind of", "so yeah", "okay so",
]

TOPIC_KEYWORDS = {
    "cosplay": ["cosplay", "costume", "con", "convention", "anime expo", "comic con"],
    "photography": ["camera", "lens", "photo", "shoot", "lighting", "editing"],
    "entertainment": ["movie", "film", "series", "netflix", "marvel", "trailer"],
    "pop_culture": ["celebrity", "trending", "viral", "meme", "influencer"],
    "conspiracy": ["conspiracy", "theory", "cover up", "secret", "leaked", "classified"],
    "security": ["hacker", "breach", "cyber", "malware", "scam", "exploit"],
    "true_crime": ["crime", "murder", "killer", "suspect", "trial", "mystery"],
    "gaming": ["game", "gameplay", "speedrun", "esports", "tournament"],
    "tech": ["tech", "gadget", "iphone", "samsung", "specs", "upgrade"],
    "money": ["money", "million", "crypto", "investment", "rich", "business"],
}

DEFAULT_RERANK_WEIGHTS = {
    "hook": 0.24,
    "payoff": 0.18,
    "retention": 0.18,
    "shareability": 0.14,
    "information_density": 0.12,
    "production_quality": 0.10,
    "clarity": 0.04,
}

_YOLO_MODEL = None
_SUBJECT_DETECTION_CACHE = {}
_SUBJECT_DETECTION_CACHE_SOURCES = []
_SUBJECT_SAMPLE_STEP_SEC = 0.45
_MAX_SUBJECT_CACHE_SOURCES = 3


def clamp(value, low, high):
    return max(low, min(value, high))


def clamp01(value):
    return clamp(value, 0.0, 1.0)


def safe_div(num, den):
    return num / den if den else 0.0


def get_longform_config():
    cfg = CONFIG.get("longform", {})
    return {
        "min_segment_sec": max(float(cfg.get("min_segment_sec", 0.5)), 0.05),
        "min_silence_to_cut_sec": max(float(cfg.get("min_silence_to_cut_sec", cfg.get("merge_gap_sec", 0.5))), 0.0),
        "silence_threshold_db": float(cfg.get("silence_threshold_db", -35.0)),
        "edge_pad_sec": max(float(cfg.get("edge_pad_sec", 0.08)), 0.0),
        "word_snap_window_sec": max(float(cfg.get("word_snap_window_sec", 0.35)), 0.0),
        "audio_fade_sec": max(float(cfg.get("audio_fade_sec", 0.03)), 0.0),
        "video_fade_sec": max(float(cfg.get("video_fade_sec", 0.0)), 0.0),
    }


def merge_time_ranges(ranges, gap=0.0):
    merged = []
    for start, end in sorted(ranges):
        if end <= start:
            continue
        if not merged or start - merged[-1][1] > gap:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return [(start, end) for start, end in merged]


def collect_word_timestamps(transcript_segments):
    words = []
    for seg in transcript_segments:
        for word in seg.get("words", []) or []:
            try:
                start = float(word.get("start", seg["start"]))
                end = float(word.get("end", start))
            except (TypeError, ValueError):
                continue
            if end <= start:
                continue
            item = {
                "word": (word.get("word") or "").strip(),
                "start": start,
                "end": end,
            }
            confidence = word.get("confidence", word.get("probability"))
            if confidence is not None:
                try:
                    item["confidence"] = float(confidence)
                except (TypeError, ValueError):
                    pass
            speaker = word.get("speaker", seg.get("speaker"))
            if speaker is not None:
                item["speaker"] = speaker
            speaker_confidence = word.get("speaker_confidence", seg.get("speaker_confidence"))
            if speaker_confidence is not None:
                try:
                    item["speaker_confidence"] = float(speaker_confidence)
                except (TypeError, ValueError):
                    pass
            words.append(item)
    words.sort(key=lambda w: (w["start"], w["end"]))
    return words


def snap_time_to_word_boundary(words, target_time, mode="end", window=0.35):
    if not words or window <= 0:
        return target_time

    best_boundary = None
    best_score = float("inf")
    for word in words:
        boundary = word["start"] if mode == "start" else word["end"]
        if boundary < target_time - window or boundary > target_time + window:
            continue
        score = abs(boundary - target_time)
        # Prefer preserving the full spoken word over trimming into it.
        if mode == "start" and boundary > target_time:
            score += 0.01
        if mode == "end" and boundary < target_time:
            score += 0.01
        if score < best_score:
            best_score = score
            best_boundary = boundary

    if best_boundary is not None:
        return best_boundary

    for word in words:
        if word["start"] <= target_time <= word["end"]:
            return word["start"] if mode == "start" else word["end"]
    return target_time


def snap_segment_to_word_boundaries(start, end, words, window=0.35):
    if not words or window <= 0 or end <= start:
        return start, end

    snapped_start = snap_time_to_word_boundary(words, start, mode="start", window=window)
    snapped_end = snap_time_to_word_boundary(words, end, mode="end", window=window)
    if snapped_end <= snapped_start:
        return start, end
    return snapped_start, snapped_end


def build_longform_segments(transcript_segments, window_start, window_end, words=None):
    cfg = get_longform_config()
    speech_ranges = [
        (float(seg["start"]), float(seg["end"]))
        for seg in transcript_segments
        if float(seg["end"]) - float(seg["start"]) >= cfg["min_segment_sec"]
    ]

    active_segments = merge_time_ranges(speech_ranges, gap=cfg["min_silence_to_cut_sec"])
    active_segments = [
        (max(start, window_start), min(end, window_end))
        for start, end in active_segments
        if end > window_start and start < window_end
    ]

    if words and cfg["word_snap_window_sec"] > 0:
        active_segments = [
            snap_segment_to_word_boundaries(start, end, words, window=cfg["word_snap_window_sec"])
            for start, end in active_segments
        ]
        active_segments = merge_time_ranges(active_segments, gap=0.0)

    if cfg["edge_pad_sec"] > 0:
        # Keep a touch of room tone so joins do not land directly on speech.
        active_segments = merge_time_ranges([
            (
                max(window_start, start - cfg["edge_pad_sec"]),
                min(window_end, end + cfg["edge_pad_sec"]),
            )
            for start, end in active_segments
        ], gap=0.0)

    return active_segments, cfg


def round_float(value, digits=3):
    return round(float(value), digits)


def get_yolo_model():
    global _YOLO_MODEL
    if _YOLO_MODEL is None:
        model_path = CONFIG.get("tracking", {}).get("model", "yolov8n.pt")
        try:
            _YOLO_MODEL = YOLO(model_path)
        except Exception as error:
            raise RuntimeError(
                f"Could not load tracking model '{model_path}'. "
                "Check network access for the first-run download or place the weight file in the project root."
            ) from error
    return _YOLO_MODEL


def _source_cache_identity(video_path):
    """Return a stable cache key that invalidates when a source is replaced."""
    absolute = os.path.abspath(video_path)
    try:
        stat = os.stat(absolute)
        return absolute, int(stat.st_mtime_ns), int(stat.st_size)
    except OSError:
        return absolute, 0, 0


def _quantized_sample_time(time_sec, step_sec=_SUBJECT_SAMPLE_STEP_SEC):
    step = max(0.05, float(step_sec))
    return max(0.0, round(float(time_sec) / step) * step)


def detect_frame_subjects_cached(video_path, frame_time, frame, model=None):
    """Reuse face/person detections across overlapping Shorts candidates.

    Candidate windows intentionally overlap, so without a source-time cache the
    same frame can be sent through face recognition many times.  Cache only the
    small detection dictionaries; frames remain owned by OpenCV and are never
    retained in memory.
    """
    source_key = _source_cache_identity(video_path)
    if source_key not in _SUBJECT_DETECTION_CACHE:
        _SUBJECT_DETECTION_CACHE[source_key] = {}
        _SUBJECT_DETECTION_CACHE_SOURCES.append(source_key)
        while len(_SUBJECT_DETECTION_CACHE_SOURCES) > _MAX_SUBJECT_CACHE_SOURCES:
            stale = _SUBJECT_DETECTION_CACHE_SOURCES.pop(0)
            _SUBJECT_DETECTION_CACHE.pop(stale, None)

    sample_key = (
        int(round(float(frame_time) * 1000.0)),
        bool(model is not None),
    )
    source_cache = _SUBJECT_DETECTION_CACHE[source_key]
    cached = source_cache.get(sample_key)
    # Person detection is only a fallback when no face is visible.  Reuse a
    # face-only result produced by visual scoring instead of running the same
    # face detector again when smart framing later asks for YOLO fallback too.
    if cached is None and model is not None:
        face_only = source_cache.get((sample_key[0], False))
        if face_only:
            cached = face_only
    if cached is None:
        cached = [dict(item) for item in detect_frame_subjects(frame, model=model)]
        source_cache[sample_key] = cached
    return [dict(item) for item in cached]


def detect_frame_subjects(frame, model=None):
    detections = []
    small_frame = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
    rgb_small_frame = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)
    face_locations = face_recognition.face_locations(rgb_small_frame)

    for top, right, bottom, left in face_locations:
        top *= 4
        right *= 4
        bottom *= 4
        left *= 4
        detections.append({
            "cx": int((left + right) / 2),
            "cy": int((top + bottom) / 2),
            "top": int(top),
            "left": int(left),
            "right": int(right),
            "bottom": int(bottom),
            "area": int(max(right - left, 1) * max(bottom - top, 1)),
            "kind": "face",
        })

    if detections:
        detections.sort(key=lambda d: d["area"], reverse=True)
        return detections

    if model is None:
        return []

    results = model(frame, classes=[0], verbose=False)
    for r in results:
        count = 0
        for box in r.boxes:
            x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
            detections.append({
                "cx": int((x1 + x2) / 2),
                "cy": int((y1 + y2) / 2),
                "top": int(y1),
                "left": int(x1),
                "right": int(x2),
                "bottom": int(y2),
                "area": int(max(x2 - x1, 1) * max(y2 - y1, 1)),
                "kind": "person",
            })
            count += 1
            if count >= 8:
                break
        break

    detections.sort(key=lambda d: d["area"], reverse=True)
    return detections


def normalize_frame_layout(frame_layout, width, height=None):
    if isinstance(frame_layout, dict):
        layout = dict(frame_layout)
    else:
        layout = {"mode": "single", "static_center": int(frame_layout)}

    layout["mode"] = layout.get("mode", "single")
    if layout["mode"] == "smart_switch":
        segments = layout.get("switch_segments", [])
        normalized_segments = []
        for segment in segments:
            try:
                start = float(segment.get("start", 0.0))
                end = float(segment.get("end", start))
                center = int(round(
                    float(segment.get("center_x_ratio")) * width
                    if segment.get("center_x_ratio") is not None
                    else segment.get("center_x", segment.get("center", layout.get("static_center", width // 2)))
                ))
            except Exception:
                continue
            if end <= start:
                continue
            normalized_segment = {
                "start": round_float(max(0.0, start), 3),
                "end": round_float(max(0.0, end), 3),
                "center": int(clamp(center, 0, width)),
                "center_x": int(clamp(center, 0, width)),
                "track_id": segment.get("track_id", segment.get("side")),
                "side": segment.get("track_id", segment.get("side")),
            }
            for field in ("speaker", "speaker_confidence", "speakers"):
                if segment.get(field) is not None:
                    normalized_segment[field] = (
                        list(segment[field])
                        if field == "speakers" and isinstance(segment[field], (list, tuple))
                        else segment[field]
                    )
            if height:
                center_y = (
                    float(segment.get("center_y_ratio")) * height
                    if segment.get("center_y_ratio") is not None
                    else segment.get("center_y", layout.get("center_y", height // 2))
                )
                crop_height = (
                    float(segment.get("crop_height_ratio")) * height
                    if segment.get("crop_height_ratio") is not None
                    else segment.get("crop_height", segment.get("suggested_crop_height", layout.get("crop_height", height)))
                )
                normalized_segment.update({
                    "center_y": int(clamp(round(float(center_y)), 0, height)),
                    "crop_height": int(clamp(round(float(crop_height)), 2, height)),
                })
                if segment.get("crop_top_ratio") is not None or segment.get("crop_top") is not None:
                    crop_top = (
                        float(segment.get("crop_top_ratio")) * height
                        if segment.get("crop_top_ratio") is not None
                        else float(segment.get("crop_top"))
                    )
                    normalized_segment["crop_top"] = int(clamp(
                        round(crop_top),
                        0,
                        max(0, height - normalized_segment["crop_height"]),
                    ))
            normalized_segments.append(normalized_segment)
        layout["switch_segments"] = normalized_segments
        if "static_center_ratio" in layout:
            layout["static_center"] = int(round(layout["static_center_ratio"] * width))
        elif "static_center" not in layout:
            layout["static_center"] = normalized_segments[0]["center"] if normalized_segments else width // 2
        layout["static_center"] = int(clamp(layout["static_center"], 0, width))
        if height:
            if layout.get("center_y_ratio") is not None:
                layout["center_y"] = int(round(float(layout["center_y_ratio"]) * height))
            elif "center_y" not in layout:
                layout["center_y"] = normalized_segments[0].get("center_y", height // 2) if normalized_segments else height // 2
            if layout.get("crop_height_ratio") is not None:
                layout["crop_height"] = int(round(float(layout["crop_height_ratio"]) * height))
            elif "crop_height" not in layout:
                heights = [segment.get("crop_height") for segment in normalized_segments if segment.get("crop_height")]
                layout["crop_height"] = int(np.median(heights)) if heights else height
            layout["center_y"] = int(clamp(layout["center_y"], 0, height))
            layout["crop_height"] = int(clamp(layout["crop_height"], 2, height))
            if layout.get("crop_top_ratio") is not None:
                layout["crop_top"] = int(round(float(layout["crop_top_ratio"]) * height))
            elif "crop_top" not in layout:
                tops = [segment.get("crop_top") for segment in normalized_segments if segment.get("crop_top") is not None]
                if tops:
                    layout["crop_top"] = int(np.median(tops))
            if layout.get("crop_top") is not None:
                layout["crop_top"] = int(clamp(
                    layout["crop_top"],
                    0,
                    max(0, height - layout["crop_height"]),
                ))
    elif layout["mode"] == "dual_stack":
        if "split_x_ratio" in layout:
            layout["split_x"] = int(round(layout["split_x_ratio"] * width))
        elif "split_x" not in layout:
            layout["split_x"] = width // 2
        layout["split_x"] = int(clamp(layout["split_x"], int(width * 0.25), int(width * 0.75)))
        layout.setdefault("static_center", width // 2)
    else:
        if "static_center_ratio" in layout:
            layout["static_center"] = int(round(layout["static_center_ratio"] * width))
        elif "static_center" not in layout:
            layout["static_center"] = width // 2
        layout["static_center"] = int(clamp(layout["static_center"], 0, width))

    if width > 0:
        layout.setdefault("static_center_ratio", round_float(safe_div(layout.get("static_center", width // 2), width), 4))
        if layout["mode"] == "dual_stack":
            layout.setdefault("split_x_ratio", round_float(safe_div(layout["split_x"], width), 4))
    if height and layout.get("mode") == "smart_switch":
        layout.setdefault("center_y_ratio", round_float(safe_div(layout.get("center_y", height // 2), height), 4))
        layout.setdefault("crop_height_ratio", round_float(safe_div(layout.get("crop_height", height), height), 4))
        if layout.get("crop_top") is not None:
            layout.setdefault("crop_top_ratio", round_float(safe_div(layout["crop_top"], height), 4))

    return layout


def _dedupe_subjects(detections, width, max_subjects=8):
    subjects = []
    min_sep = max(28, width * 0.035)
    for detection in sorted(detections, key=lambda d: d.get("area", 0), reverse=True):
        cx = detection.get("cx", 0)
        cy = detection.get("cy", (detection.get("top", 0) + detection.get("bottom", 0)) / 2)
        if any(
            abs(cx - subject.get("cx", 0)) < min_sep
            and abs(cy - subject.get("cy", (subject.get("top", 0) + subject.get("bottom", 0)) / 2)) < min_sep
            for subject in subjects
        ):
            continue
        subjects.append(detection)
        if len(subjects) >= max_subjects:
            break
    subjects.sort(key=lambda d: d.get("cx", 0))
    return subjects


def _choose_active_subject(subjects, prev_gray, gray, last_center=None):
    if not subjects:
        return None, 0.0
    scored = []
    max_area = max(max(subject.get("area", 1), 1) for subject in subjects)
    for subject in subjects:
        motion = _motion_score(prev_gray, gray, subject)
        area_weight = safe_div(subject.get("area", 1), max_area) * 0.45
        continuity = 0.0
        if last_center is not None:
            distance = abs(subject.get("cx", 0) - last_center)
            continuity = max(0.0, 0.35 - safe_div(distance, 900))
        scored.append((motion + area_weight + continuity, motion, subject))
    scored.sort(key=lambda row: row[0], reverse=True)
    return scored[0][2], scored[0][1]


def _group_subjects_by_side(detections, width):
    if len(detections) < 2:
        return []
    left_candidates = [d for d in detections if d["cx"] < width * 0.58]
    right_candidates = [d for d in detections if d["cx"] > width * 0.42]
    if not left_candidates or not right_candidates:
        ordered = sorted(detections[:2], key=lambda d: d["cx"])
        left, right = ordered[0], ordered[1]
    else:
        left = max(left_candidates, key=lambda d: d["area"])
        right = max(right_candidates, key=lambda d: d["area"])
    if right["cx"] <= left["cx"]:
        return []
    separation = right["cx"] - left["cx"]
    min_subject_width = min(left["right"] - left["left"], right["right"] - right["left"])
    if separation <= max(width * 0.16, min_subject_width * 1.05):
        return []
    return [left, right]


def _motion_score(prev_gray, gray, subject):
    if prev_gray is None or gray is None:
        return 0.0
    h, w = gray.shape[:2]
    left = int(clamp(subject["left"], 0, w - 1))
    right = int(clamp(subject["right"], left + 1, w))
    top = int(clamp(subject["top"], 0, h - 1))
    bottom = int(clamp(subject["bottom"], top + 1, h))
    if right - left < 8 or bottom - top < 8:
        return 0.0

    if subject.get("kind") == "face":
        face_height = bottom - top
        # Mouth/jaw motion is a better talking signal than general movement.
        # Subtract a portion of upper-face/camera motion so a listener moving
        # their head, or a static avatar inside a moving layout, does not win.
        mouth_top = top + int(face_height * 0.52)
        mouth_bottom = top + int(face_height * 0.96)
        control_top = top + int(face_height * 0.12)
        control_bottom = top + int(face_height * 0.43)

        mouth_prev = prev_gray[mouth_top:mouth_bottom, left:right]
        mouth_curr = gray[mouth_top:mouth_bottom, left:right]
        control_prev = prev_gray[control_top:control_bottom, left:right]
        control_curr = gray[control_top:control_bottom, left:right]
        if mouth_prev.size == 0 or mouth_curr.size == 0 or mouth_prev.shape != mouth_curr.shape:
            return 0.0
        mouth_motion = float(np.mean(cv2.absdiff(mouth_prev, mouth_curr)))
        control_motion = 0.0
        if control_prev.size and control_curr.size and control_prev.shape == control_curr.shape:
            control_motion = float(np.mean(cv2.absdiff(control_prev, control_curr)))
        return max(0.0, mouth_motion - (control_motion * 0.55))
    else:
        roi_top = top
        roi_bottom = top + int((bottom - top) * 0.42)

    roi_top = int(clamp(roi_top, 0, h - 1))
    roi_bottom = int(clamp(roi_bottom, roi_top + 1, h))
    prev_roi = prev_gray[roi_top:roi_bottom, left:right]
    curr_roi = gray[roi_top:roi_bottom, left:right]
    if prev_roi.size == 0 or curr_roi.size == 0 or prev_roi.shape != curr_roi.shape:
        return 0.0
    diff = cv2.absdiff(prev_roi, curr_roi)
    return float(np.mean(diff))


def _active_speaker_border_strength(frame, subject):
    """Return confidence for a conferencing-app active-speaker rectangle.

    Zoom and similar apps draw a saturated green rectangle around the current
    speaker. Requiring both a long horizontal and vertical run avoids treating
    ordinary green objects or a neighboring tile border as the active tile.
    This is only a hint for an already-detected real face; camera-off tiles do
    not become candidates merely because their border lights up.
    """
    if frame is None or subject.get("kind") != "face":
        return 0.0
    frame_h, frame_w = frame.shape[:2]
    face_w = max(1, int(subject.get("right", 0) - subject.get("left", 0)))
    face_h = max(1, int(subject.get("bottom", 0) - subject.get("top", 0)))
    cx = int(subject.get("cx", 0))
    cy = int(subject.get("cy", (subject.get("top", 0) + subject.get("bottom", 0)) / 2))
    x1 = int(clamp(cx - (face_w * 2.5), 0, frame_w - 1))
    x2 = int(clamp(cx + (face_w * 2.5), x1 + 1, frame_w))
    y1 = int(clamp(cy - (face_h * 1.8), 0, frame_h - 1))
    y2 = int(clamp(cy + (face_h * 1.5), y1 + 1, frame_h))
    roi = frame[y1:y2, x1:x2]
    if roi.size == 0:
        return 0.0
    blue = roi[:, :, 0].astype(np.float32)
    green = roi[:, :, 1].astype(np.float32)
    red = roi[:, :, 2].astype(np.float32)
    green_mask = (green > 130.0) & (green > red * 1.3) & (green > blue * 1.3)
    if not np.any(green_mask):
        return 0.0
    row_strength = float(np.max(np.mean(green_mask, axis=1)))
    column_strength = float(np.max(np.mean(green_mask, axis=0)))
    return min(row_strength, column_strength)


def _smart_crop_top(center_y, crop_height, frame_height, vertical_position, detected_top=None):
    """Place a face naturally while honoring a detected tile content edge."""
    crop_height = max(2, min(int(crop_height), int(frame_height)))
    maximum = max(0, int(frame_height) - crop_height)
    base = int(round(float(center_y) - (crop_height * float(vertical_position))))
    if detected_top is not None:
        # Matte fitting may move the window either down past a header or up
        # above a footer.  Treat the fitted position as authoritative instead
        # of only allowing downward movement.
        base = int(round(float(detected_top)))
    return int(clamp(base, 0, maximum))


def _detect_top_matte_bottom(
    frame,
    crop_x,
    crop_y,
    crop_width,
    crop_height,
    face_top=None,
    return_height=False,
):
    """Fit a portrait crop between uniform conferencing-app matte bands.

    Meeting grids often put a dark header above a tile and a dark gutter below
    it.  Moving past only the header can expose the lower gutter, so inspect
    both crop edges and shift the window into the visible tile content.  Face
    headroom caps downward movement; the low-variance requirement avoids
    treating ordinary dark backgrounds or clothing as application chrome.
    """
    fallback = (int(crop_y), int(crop_height)) if return_height else int(crop_y)
    if frame is None or getattr(frame, "size", 0) == 0:
        return fallback
    frame_height, frame_width = frame.shape[:2]
    x1 = int(clamp(crop_x, 0, max(0, frame_width - 1)))
    x2 = int(clamp(crop_x + crop_width, x1 + 1, frame_width))
    proposed_top = int(clamp(crop_y, 0, max(0, frame_height - 1)))
    original_height = int(clamp(crop_height, 2, frame_height))
    scan_padding = max(12, int(original_height * 0.35))
    y1 = max(0, proposed_top - scan_padding)
    y2 = min(frame_height, proposed_top + original_height + scan_padding)
    if y2 - y1 < 8 or x2 - x1 < 8:
        return fallback

    roi = frame[y1:y2, x1:x2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    inset = max(1, int(gray.shape[1] * 0.08))
    rows = gray[:, inset:gray.shape[1] - inset] if gray.shape[1] > inset * 2 else gray
    color_rows = roi[:, inset:roi.shape[1] - inset] if roi.shape[1] > inset * 2 else roi
    row_mean = np.mean(rows, axis=1)
    row_std = np.std(rows, axis=1)
    channel_means = np.mean(color_rows, axis=1)
    row_saturation = np.max(channel_means, axis=1) - np.min(channel_means, axis=1)
    # Application gutters are far more uniform than dark clothing or a dim
    # room.  The strict variance threshold is what keeps those real image
    # regions from being mistaken for tile chrome.
    matte = (row_mean < 40.0) & (row_std < 8.0)
    minimum_matte_rows = max(4, int(original_height * 0.01))
    runs = []
    run_start = None
    for index, is_matte in enumerate(matte):
        if is_matte and run_start is None:
            run_start = index
        if run_start is not None and (not is_matte or index == len(matte) - 1):
            run_end = index if not is_matte else index + 1
            if run_end - run_start >= minimum_matte_rows:
                runs.append((y1 + run_start, y1 + run_end))
            run_start = None

    face_anchor = int(face_top) if face_top is not None else proposed_top + int(original_height * 0.35)
    top_runs = [run for run in runs if run[1] <= face_anchor]
    bottom_runs = [
        run for run in runs
        if run[0] >= face_anchor + int(original_height * 0.18)
        and run[0] <= proposed_top + original_height + scan_padding
    ]
    content_top = max(top_runs, key=lambda run: run[1])[1] if top_runs else None
    content_bottom = min(bottom_runs, key=lambda run: run[0])[0] if bottom_runs else None

    if content_top is not None:
        border_rows = 0
        while (
            content_top - y1 < len(matte)
            and border_rows < 12
            and row_std[content_top - y1] < 12.0
            and row_saturation[content_top - y1] > 60.0
        ):
            content_top += 1
            border_rows += 1
        if face_top is not None:
            headroom = max(6, int(original_height * 0.07))
            content_top = min(content_top, max(0, int(face_top) - headroom))

    if content_bottom is not None:
        border_rows = 0
        while (
            content_bottom - y1 > 0
            and border_rows < 12
            and row_std[content_bottom - y1 - 1] < 12.0
            and row_saturation[content_bottom - y1 - 1] > 60.0
        ):
            content_bottom -= 1
            border_rows += 1

    fitted_height = original_height
    if content_top is not None and content_bottom is not None:
        available_height = content_bottom - content_top
        if available_height >= int(original_height * 0.82):
            fitted_height = min(original_height, max(2, (available_height // 2) * 2))

    minimum_top = content_top if content_top is not None else 0
    maximum_top = frame_height - fitted_height
    if content_bottom is not None:
        maximum_top = min(maximum_top, content_bottom - fitted_height)
    if maximum_top < minimum_top:
        minimum_top = max(0, maximum_top)
    adjusted = int(clamp(proposed_top, minimum_top, max(minimum_top, maximum_top)))
    if return_height:
        return adjusted, fitted_height
    return adjusted


def _merge_switch_segments(samples, clip_duration, min_segment=1.2):
    return merge_speaker_samples(samples, clip_duration, min_segment_sec=min_segment)


def unique_phrase_hits(text, phrases):
    return [phrase for phrase in phrases if phrase in text]


def count_regex_hits(text, patterns):
    return sum(1 for pattern in patterns if re.search(pattern, text))


def keyword_hit_weight(keyword):
    if keyword in GENERIC_KEYWORDS:
        return 0.35
    if " " in keyword:
        return 1.0
    if len(keyword) >= 8:
        return 0.8
    if len(keyword) >= 5:
        return 0.55
    return 0.4


def words_to_text(words):
    if not words:
        return ""
    return " ".join(w.get("word", "").strip() for w in words if w.get("word", "").strip()).strip()


def slice_text_words(text, count, from_end=False):
    tokens = text.split()
    if not tokens:
        return ""
    subset = tokens[-count:] if from_end else tokens[:count]
    return " ".join(subset)


def compute_filler_ratio(text):
    tokens = re.findall(r"\b[\w']+\b", text.lower())
    if not tokens:
        return 0.0
    filler_count = sum(1 for token in tokens if token in FILLER_WORDS)
    filler_count += sum(text.count(phrase) for phrase in FILLER_PHRASES)
    return filler_count / len(tokens)


def compute_confidence(seg):
    direct_confidence = seg.get("confidence")
    if direct_confidence is not None:
        try:
            return clamp01(float(direct_confidence))
        except (TypeError, ValueError):
            pass
    avg_logprob = seg.get("avg_logprob")
    if avg_logprob is None:
        return 0.55
    no_speech_prob = seg.get("no_speech_prob", 0.0)
    logprob_component = clamp01((avg_logprob + 1.2) / 0.9)
    silence_component = 1.0 - clamp01(no_speech_prob / 0.7)
    return clamp01((logprob_component * 0.7) + (silence_component * 0.3))


def make_reason_list(score_map, limit=4):
    return [name for name, value in sorted(score_map.items(), key=lambda item: item[1], reverse=True) if value > 0][:limit]


def duration_fit_score(duration):
    if 15 <= duration <= 45:
        return 1.0
    if 10 <= duration <= 60:
        return 0.82
    if 8 <= duration <= 75:
        return 0.62
    if 6 <= duration <= 90:
        return 0.4
    return 0.15


def build_segment_signals(seg, text, duration, wps, keywords, audio_score=0.0, audio_features=None, audio_metrics=None,
                          visual_score=0.0, visual_features=None, visual_metrics=None):
    opener = slice_text_words(text, 16)
    closer = slice_text_words(text, 18, from_end=True)
    matched_keywords = [kw for kw in keywords if kw in text]
    strong_keywords = [kw for kw in matched_keywords if keyword_hit_weight(kw) >= 0.8]
    weak_keywords = [kw for kw in matched_keywords if keyword_hit_weight(kw) < 0.8]
    keyword_weight = sum(keyword_hit_weight(kw) for kw in matched_keywords)
    opener_keyword_weight = sum(keyword_hit_weight(kw) for kw in matched_keywords if kw in opener)

    detected_topics = [topic for topic, topic_kws in TOPIC_KEYWORDS.items() if any(kw in text for kw in topic_kws)]
    hook_hits = unique_phrase_hits(opener, HOOK_PHRASES)
    curiosity_hits = unique_phrase_hits(opener, CURIOSITY_PHRASES)
    payoff_hits = unique_phrase_hits(text, PAYOFF_PHRASES)
    opener_question_hits = unique_phrase_hits(opener, QUESTION_OPENERS)
    value_hits = unique_phrase_hits(text, VALUE_PATTERNS)
    controversy_hits = unique_phrase_hits(text, CONTROVERSY_PHRASES)
    personal_hits = unique_phrase_hits(text, PERSONAL_MARKERS)
    social_hits = unique_phrase_hits(text, SOCIAL_PROOF_PHRASES)
    urgency_hits = unique_phrase_hits(text, URGENCY_PHRASES)
    cliffhanger_hits = unique_phrase_hits(text, CLIFFHANGER_PHRASES)
    list_hits = unique_phrase_hits(text, LIST_PATTERNS)
    contrast_hits = unique_phrase_hits(text, CONTRAST_PHRASES)
    emotion_hits = unique_phrase_hits(text, EXCLAMATION_TRIGGERS)
    number_matches = count_regex_hits(text, NUMBER_PATTERNS)
    filler_ratio = compute_filler_ratio(text)
    tokens = re.findall(r"\b[\w']+\b", text)
    unique_word_ratio = safe_div(len(set(t.lower() for t in tokens)), len(tokens))
    first_word = tokens[0].lower() if tokens else ""
    sentence_count = max(1, text.count(".") + text.count("!") + text.count("?"))
    punctuation_density = safe_div(sentence_count, max(duration, 1.0))

    return {
        "duration": duration,
        "wps": wps,
        "text": text,
        "opener_text": opener,
        "closer_text": closer,
        "matched_keywords": matched_keywords,
        "strong_keywords": strong_keywords,
        "weak_keywords": weak_keywords,
        "keyword_weight": keyword_weight,
        "opener_keyword_weight": opener_keyword_weight,
        "detected_topics": detected_topics,
        "hook_hits": hook_hits,
        "curiosity_hits": curiosity_hits,
        "payoff_hits": payoff_hits,
        "opener_question_hits": opener_question_hits,
        "value_hits": value_hits,
        "controversy_hits": controversy_hits,
        "personal_hits": personal_hits,
        "social_hits": social_hits,
        "urgency_hits": urgency_hits,
        "cliffhanger_hits": cliffhanger_hits,
        "list_hits": list_hits,
        "contrast_hits": contrast_hits,
        "emotion_hits": emotion_hits,
        "number_matches": number_matches,
        "filler_ratio": filler_ratio,
        "unique_word_ratio": unique_word_ratio,
        "sentence_count": sentence_count,
        "punctuation_density": punctuation_density,
        "confidence": compute_confidence(seg),
        "weak_opener": first_word in BAD_OPENERS or opener.startswith(("and ", "so ", "but ", "because ", "well ")),
        "audio_score": float(audio_score or 0.0),
        "audio_features": audio_features or [],
        "audio_metrics": audio_metrics or {},
        "visual_score": float(visual_score or 0.0),
        "visual_features": visual_features or [],
        "visual_metrics": visual_metrics or {},
    }


def score_segment_candidate(signals):
    pace_score = clamp01((signals["wps"] - 1.3) / 1.7)
    hook_score = clamp01(
        (len(signals["hook_hits"]) * 0.65) +
        (len(signals["curiosity_hits"]) * 0.45) +
        (len(signals["opener_question_hits"]) * 0.3)
    )
    value_score = clamp01(
        (signals["number_matches"] * 0.28) +
        (len(signals["value_hits"]) * 0.32) +
        (len(signals["list_hits"]) * 0.3) +
        (signals["keyword_weight"] * 0.12)
    )
    shareability_score = clamp01(
        (len(signals["emotion_hits"]) * 0.22) +
        (len(signals["controversy_hits"]) * 0.35) +
        (len(signals["personal_hits"]) * 0.3) +
        (len(signals["social_hits"]) * 0.2) +
        (len(signals["contrast_hits"]) * 0.2)
    )
    quality_score = clamp01((signals["audio_score"] + signals["visual_score"]) / 6.0)
    clarity_score = clamp01(
        (signals["confidence"] * 0.55) +
        (clamp01((signals["unique_word_ratio"] - 0.45) / 0.35) * 0.2) +
        (clamp01(signals["punctuation_density"] / 0.3) * 0.1) +
        (clamp01((0.18 - signals["filler_ratio"]) / 0.18) * 0.15)
    )

    component_points = {
        "Strong opener": hook_score * 2.8,
        "Information density": value_score * 2.4,
        "Shareable angle": shareability_score * 1.9,
        "Speaker energy": pace_score * 1.3,
        "Production quality": quality_score * 1.6,
        "Transcript clarity": clarity_score * 1.2,
    }

    penalty = 0.0
    if signals["weak_opener"]:
        penalty += 0.55
    if signals["filler_ratio"] > 0.18:
        penalty += min((signals["filler_ratio"] - 0.18) * 3.5, 0.85)

    total = max(0.0, sum(component_points.values()) - penalty)
    return round(total, 3), make_reason_list(component_points)


def build_rerank_breakdown(clip):
    duration = clip["end"] - clip["start"]
    text = clip.get("text", "").strip()
    words = clip.get("words", [])
    tokens = re.findall(r"\b[\w']+\b", text.lower())
    unique_word_ratio = safe_div(len(set(tokens)), len(tokens))
    opener = words_to_text(words[:16]) or slice_text_words(text, 16)
    closer = words_to_text(words[-18:]) or slice_text_words(text, 18, from_end=True)
    midpoint = clip["start"] + (duration / 2.0)
    first_half_words = [w for w in words if w.get("start", clip["start"]) < midpoint]
    second_half_words = [w for w in words if w.get("start", clip["start"]) >= midpoint]
    first_half_text = words_to_text(first_half_words) or text
    second_half_text = words_to_text(second_half_words) or text

    segments = clip.get("segments", [])
    weighted_duration = sum(max(seg["end"] - seg["start"], 0.01) for seg in segments) or max(duration, 0.01)
    avg_audio = safe_div(sum(seg["signals"].get("audio_score", 0.0) * max(seg["end"] - seg["start"], 0.01) for seg in segments), weighted_duration)
    avg_visual = safe_div(sum(seg["signals"].get("visual_score", 0.0) * max(seg["end"] - seg["start"], 0.01) for seg in segments), weighted_duration)
    avg_confidence = safe_div(sum(seg["signals"].get("confidence", 0.55) * max(seg["end"] - seg["start"], 0.01) for seg in segments), weighted_duration)
    avg_wps = safe_div(sum(seg["signals"].get("wps", 0.0) * max(seg["end"] - seg["start"], 0.01) for seg in segments), weighted_duration)
    peak_candidate = max((seg.get("candidate_score", 0.0) for seg in segments), default=clip.get("candidate_score", 0.0))
    unique_topics = sorted({topic for seg in segments for topic in seg["signals"].get("detected_topics", [])})
    matched_keywords = sorted({kw for seg in segments for kw in seg["signals"].get("matched_keywords", [])})
    strong_keywords = [kw for kw in matched_keywords if keyword_hit_weight(kw) >= 0.8]
    filler_ratio = compute_filler_ratio(text)
    sentence_count = max(1, text.count(".") + text.count("!") + text.count("?"))
    punctuation_density = safe_div(sentence_count, max(duration, 1.0))
    number_matches = count_regex_hits(text, NUMBER_PATTERNS)
    opener_hook_hits = unique_phrase_hits(opener, HOOK_PHRASES)
    opener_curiosity_hits = unique_phrase_hits(opener, CURIOSITY_PHRASES)
    opener_questions = ("?" in opener) or bool(unique_phrase_hits(opener, QUESTION_OPENERS))
    weak_opener = opener.split()[0].lower() in BAD_OPENERS if opener.split() else False
    payoff_hits = unique_phrase_hits(second_half_text, PAYOFF_PHRASES)
    contrast_hits = unique_phrase_hits(text, CONTRAST_PHRASES)
    cliffhanger_hits = unique_phrase_hits(text, CLIFFHANGER_PHRASES)
    value_hits = unique_phrase_hits(text, VALUE_PATTERNS)
    list_hits = unique_phrase_hits(text, LIST_PATTERNS)
    personal_hits = unique_phrase_hits(text, PERSONAL_MARKERS)
    social_hits = unique_phrase_hits(text, SOCIAL_PROOF_PHRASES)
    controversy_hits = unique_phrase_hits(text, CONTROVERSY_PHRASES)
    emotion_hits = unique_phrase_hits(text, EXCLAMATION_TRIGGERS)
    duration_fit = duration_fit_score(duration)
    open_loop = bool(opener_hook_hits or opener_curiosity_hits or opener_questions or controversy_hits)
    resolves_loop = bool(payoff_hits or value_hits or contrast_hits)
    clean_ending = closer.endswith((".", "!", "?")) or bool(unique_phrase_hits(closer, PAYOFF_PHRASES))
    filler_penalty = clamp01((filler_ratio - 0.12) / 0.18)
    first_token = opener.split()[0].strip("'\".,!?;:").lower() if opener.split() else ""
    last_token = closer.split()[-1].strip("'\".,!?;:").lower() if closer.split() else ""
    dependent_openers = {"and", "but", "because", "then", "also", "he", "she", "they", "it", "this", "that"}
    dangling_endings = {"and", "but", "because", "so", "then", "with", "to", "of", "if"}
    standalone_opening = clamp(
        8.5
        + (1.0 if opener_hook_hits or opener_questions else 0.0)
        - (3.2 if first_token in dependent_openers else 0.0)
        - (1.5 if weak_opener else 0.0),
        0.0,
        10.0,
    )
    complete_ending = clamp(
        5.5
        + (3.0 if clean_ending else 0.0)
        + (1.0 if payoff_hits else 0.0)
        - (3.0 if last_token in dangling_endings else 0.0),
        0.0,
        10.0,
    )
    topic_coherence = clamp(
        5.0
        + (2.0 if sentence_count >= 2 else 0.0)
        + (1.5 * clamp01((unique_word_ratio - 0.42) / 0.28))
        + (1.0 if unique_topics else 0.0)
        - (1.5 * filler_penalty),
        0.0,
        10.0,
    )
    specificity = clamp01((len(strong_keywords) * 0.22) + (len(unique_topics) * 0.18) + (number_matches * 0.12))
    opener_keyword_weight = sum(keyword_hit_weight(kw) for kw in matched_keywords if kw in opener)

    hook_component = clamp(
        (4.2 if opener_hook_hits else 0.0) +
        (2.2 if opener_curiosity_hits or opener_questions else 0.0) +
        (1.2 * clamp01((avg_wps - 1.5) / 1.7)) +
        (1.4 * clamp01(opener_keyword_weight / 2.0)) -
        (1.8 if weak_opener else 0.0) -
        (1.5 * filler_penalty),
        0.0, 10.0
    )

    payoff_component = clamp(
        (4.0 if payoff_hits else 0.0) +
        (2.2 if open_loop and resolves_loop else 0.0) +
        (1.4 * min(len(contrast_hits) + len(cliffhanger_hits), 2)) +
        (1.0 if clean_ending else 0.0) +
        (0.8 if sentence_count >= 2 else 0.0),
        0.0, 10.0
    )

    shareability_component = clamp(
        (2.7 if controversy_hits else 0.0) +
        (2.0 if personal_hits else 0.0) +
        (1.8 * min(len(social_hits), 2) / 2.0) +
        (1.4 * min(len(emotion_hits), 2) / 2.0) +
        (1.4 if value_hits or list_hits else 0.0) +
        (0.8 if unique_topics else 0.0),
        0.0, 10.0
    )

    information_component = clamp(
        (2.4 * min(number_matches, 2) / 2.0) +
        (2.0 if value_hits else 0.0) +
        (1.6 if list_hits else 0.0) +
        (1.8 * specificity) +
        (1.2 * avg_confidence) +
        (1.0 * clamp01((avg_wps - 1.4) / 2.0)) -
        (1.3 * filler_penalty),
        0.0, 10.0
    )

    retention_component = clamp(
        (2.8 if open_loop else 0.0) +
        (2.4 if open_loop and resolves_loop else 0.0) +
        (2.0 * duration_fit) +
        (1.2 if sentence_count >= 2 else 0.0) +
        (1.0 if clean_ending else 0.0) +
        (0.8 * clamp01(peak_candidate / 6.0)),
        0.0, 10.0
    )

    production_component = clamp(
        (5.0 * clamp01(avg_visual / 3.0)) +
        (5.0 * clamp01(avg_audio / 3.0)),
        0.0, 10.0
    )

    clarity_component = clamp(
        (4.2 * avg_confidence) +
        (2.0 * clamp01((0.2 - filler_ratio) / 0.2)) +
        (1.4 * clamp01(punctuation_density / 0.25)) +
        (1.0 * clamp01((avg_wps - 1.1) / 2.0)) +
        (1.4 * clamp01((unique_word_ratio - 0.45) / 0.3)),
        0.0, 10.0
    )

    return {
        "hook": round_float(hook_component),
        "payoff": round_float(payoff_component),
        "retention": round_float(retention_component),
        "shareability": round_float(shareability_component),
        "information_density": round_float(information_component),
        "production_quality": round_float(production_component),
        "clarity": round_float(clarity_component),
        "boundary_quality": {
            "standalone_opening": round_float(standalone_opening),
            "complete_ending": round_float(complete_ending),
            "topic_coherence": round_float(topic_coherence),
            "context_dependency": round_float(10.0 - standalone_opening),
        },
        "metrics": {
            "duration_fit": round_float(duration_fit),
            "confidence": round_float(avg_confidence),
            "filler_ratio": round_float(filler_ratio),
            "avg_wps": round_float(avg_wps),
            "unique_word_ratio": round_float(unique_word_ratio),
            "topics": unique_topics,
            "strong_keywords": strong_keywords[:8],
            "open_loop": open_loop,
            "resolves_loop": resolves_loop,
        },
    }


def score_clip_candidate(clip):
    rerank_cfg = CONFIG.get("scoring", {}).get("rerank", {})
    weights = {**DEFAULT_RERANK_WEIGHTS, **rerank_cfg.get("weights", {})}
    output_scale = float(CONFIG.get("scoring", {}).get("output_scale", 15.0))
    breakdown = build_rerank_breakdown(clip)
    weighted_score = sum(breakdown[name] * weights.get(name, 0.0) for name in DEFAULT_RERANK_WEIGHTS)
    final_score = round_float(weighted_score * (output_scale / 10.0))

    reason_points = {
        "Strong opener": breakdown["hook"],
        "Clear payoff": breakdown["payoff"],
        "Good retention arc": breakdown["retention"],
        "High shareability": breakdown["shareability"],
        "Dense information": breakdown["information_density"],
        "Solid production": breakdown["production_quality"],
        "Clear delivery": breakdown["clarity"],
    }

    if breakdown["metrics"]["open_loop"] and breakdown["metrics"]["resolves_loop"]:
        reason_points["Opens and resolves a loop"] = max(reason_points.get("Clear payoff", 0.0), 7.0)
    if breakdown["metrics"]["strong_keywords"]:
        reason_points["Specific topic language"] = max(reason_points.get("Dense information", 0.0), 6.0)

    return final_score, make_reason_list(reason_points, limit=5), breakdown

def analyze_visual_quality(video_path, start_time, end_time, return_details=False):
    """
    Analyze visual quality of a clip segment:
    - Face visibility and size
    - Lighting quality (brightness, contrast)
    - Motion detection (avoid static boring shots)
    Returns quality score (0-3) and features
    """
    cap = cv2.VideoCapture(video_path)
    try:
        fps = cap.get(cv2.CAP_PROP_FPS)
        start_frame = int(start_time * fps)
        end_frame = int(end_time * fps)

        # Spread samples across the entire candidate.  The previous loop
        # calculated spaced frame indexes but then read consecutive frames,
        # which made visual scoring judge only the opening fraction.
        sample_count = max(1, min(10, end_frame - start_frame))
        sample_times = sorted({
            _quantized_sample_time(float(value) / max(fps, 1.0), _SUBJECT_SAMPLE_STEP_SEC)
            for value in np.linspace(start_frame, max(start_frame, end_frame - 1), sample_count)
        })

        face_sizes = []
        brightness_values = []
        motion_scores = []
        prev_frame = None
        sampled_frames = 0

        for frame_time in sample_times:
            cap.set(cv2.CAP_PROP_POS_MSEC, frame_time * 1000.0)
            ret, frame = cap.read()
            if not ret:
                break
            sampled_frames += 1

            # 1. Face Detection.  Use the same source-time cache as framing so
            # overlapping candidate windows never repeat this expensive work.
            faces = [
                item for item in detect_frame_subjects_cached(
                    video_path,
                    frame_time,
                    frame,
                    model=None,
                )
                if item.get("kind") == "face"
            ]
            if faces:
                largest_face = max(faces, key=lambda item: item.get("area", 0))
                # The historical score thresholds were calibrated against a
                # quarter-resolution face detector, whose area is 1/16 scale.
                face_sizes.append(float(largest_face.get("area", 0)) / 16.0)

            # 2. Brightness/Lighting Quality
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            brightness = np.mean(gray)
            brightness_values.append(brightness)

            # 3. Motion Detection
            if prev_frame is not None:
                diff = cv2.absdiff(prev_frame, gray)
                motion = np.mean(diff)
                motion_scores.append(motion)

            prev_frame = gray
    finally:
        cap.release()

    score = 0
    features = []

    # Evaluate Face Visibility
    if face_sizes:
        avg_face_size = np.mean(face_sizes)
        # Larger face = more engaging
        if avg_face_size > 500:  # Arbitrary threshold for close-up
            score += 1.5
            features.append("Close-up Face")
        elif avg_face_size > 200:
            score += 0.5
            features.append("Face Visible")

    # Evaluate Lighting
    if brightness_values:
        avg_brightness = np.mean(brightness_values)
        brightness_std = np.std(brightness_values)

        # Good brightness range (not too dark/bright)
        if 80 < avg_brightness < 180:
            score += 0.5
            features.append("Good Lighting")

        # Dynamic lighting (not flat/boring)
        if brightness_std > 15:
            score += 0.5
            features.append("Dynamic Lighting")

    # Evaluate Motion
    if motion_scores:
        avg_motion = np.mean(motion_scores)

        # Moderate motion = engaging (not static, not shaky)
        if 5 < avg_motion < 30:
            score += 1
            features.append("Good Motion")
        elif avg_motion < 5:
            # Penalize static shots
            score -= 0.5
            features.append("Static Shot")

    score = max(0, min(score, 3))
    details = {
        "sampled_frames": sampled_frames,
        "face_detection_ratio": round(safe_div(len(face_sizes), sampled_frames), 3),
        "avg_face_size": round(float(np.mean(face_sizes)) if face_sizes else 0.0, 3),
        "avg_brightness": round(float(np.mean(brightness_values)) if brightness_values else 0.0, 3),
        "brightness_std": round(float(np.std(brightness_values)) if brightness_values else 0.0, 3),
        "avg_motion": round(float(np.mean(motion_scores)) if motion_scores else 0.0, 3),
    }
    if return_details:
        return score, features, details
    return score, features


def analyze_audio_emotion(audio_path, start_time, end_time, return_details=False):
    """
    Analyze audio segment for emotional intensity using volume and pitch variations.
    Returns emotion score (0-3) and detected features.
    """
    if not LIBROSA_AVAILABLE:
        if return_details:
            return 0, [], {}
        return 0, []

    try:
        # Load audio segment
        y, sr = librosa.load(audio_path, offset=start_time, duration=end_time-start_time, sr=22050)

        if len(y) < sr * 0.5:  # Too short to analyze
            if return_details:
                return 0, [], {}
            return 0, []

        features = []
        score = 0

        # 1. Energy/Volume Analysis (detect excitement/shouting)
        rms = librosa.feature.rms(y=y)[0]
        rms_mean = np.mean(rms)
        rms_std = np.std(rms)

        # High energy = excitement
        if rms_mean > 0.1:
            score += 1
            features.append("High Energy")

        # High variation = emotional dynamics
        if rms_std > 0.05:
            score += 0.5
            features.append("Dynamic Volume")

        # 2. Pitch Variation Analysis (detect emotional speech patterns)
        pitches, magnitudes = librosa.piptrack(y=y, sr=sr)
        pitch_values = []

        for t in range(pitches.shape[1]):
            index = magnitudes[:, t].argmax()
            pitch = pitches[index, t]
            if pitch > 0:
                pitch_values.append(pitch)

        pitch_std = 0.0
        if pitch_values:
            pitch_std = np.std(pitch_values)
            # High pitch variation = emotional speech
            if pitch_std > 50:
                score += 1
                features.append("Expressive Pitch")

        # 3. Zero Crossing Rate (detect speech clarity/emphasis)
        zcr = librosa.feature.zero_crossing_rate(y)[0]
        zcr_mean = np.mean(zcr)

        if zcr_mean > 0.15:
            score += 0.5
            features.append("Emphatic Speech")

        score = min(score, 3)
        details = {
            "rms_mean": round(float(rms_mean), 4),
            "rms_std": round(float(rms_std), 4),
            "pitch_std": round(float(pitch_std), 4),
            "zcr_mean": round(float(zcr_mean), 4),
            "sample_seconds": round(float(len(y) / sr), 3),
        }
        if return_details:
            return score, features, details
        return score, features

    except Exception as e:
        print(f"    Warning: Audio analysis failed: {e}")
        if return_details:
            return 0, [], {}
        return 0, []


def analyze_speaker_layout(
    video_path,
    start_time=0,
    sample_duration=3,
    framing_mode="auto",
    clip_end_time=None,
    clip_words=None,
):
    """
    Detect speaker framing for shorts.
    auto: keep old behavior, stacking only when a side-by-side pair is reliable.
    smart_switch: build a time-varying crop from lower-face/body motion, using
    diarized clip words as a learned visual-track preference when available.
    dual_stack: force a 2-up stack whenever two subjects are detectable.
    """
    framing_mode = framing_mode if framing_mode in {"auto", "smart_switch", "dual_stack"} else "auto"
    print(f"📍 Analyzing Speaker Layout [{framing_mode.replace('_', ' ')}]...")
    fallback_layout = {
        "mode": "single",
        "static_center": 960,
        "static_center_ratio": round_float(0.5, 4),
    }
    cap = cv2.VideoCapture(video_path)
    width = 1920
    height = 1080
    try:
        fps = cap.get(cv2.CAP_PROP_FPS) or 30
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080
        fallback_layout = {
            "mode": "single",
            "static_center": width // 2,
            "static_center_ratio": round_float(0.5, 4),
        }

        try:
            model = get_yolo_model()
        except Exception as e:
            # Face tracking is sufficient for smart switching. YOLO remains a
            # fallback for ordinary auto framing, but its first-run model
            # download should never disable the on-camera face path.
            model = None
            print(f"  ⚠️  Person detector unavailable; continuing with face tracking: {e}")

        positions = []
        face_tops = []
        left_centers = []
        right_centers = []
        sampled_frames = 0
        dual_frames = 0
        clip_duration = max(0.1, float((clip_end_time - start_time) if clip_end_time else sample_duration))
        analysis_duration = clip_duration if framing_mode == "smart_switch" else sample_duration
        sample_step_sec = 0.45 if framing_mode == "smart_switch" else max(5 / fps, 0.15)
        sample_count = max(2 if framing_mode == "smart_switch" else 1, int(analysis_duration / sample_step_sec) + 1)
        prev_gray = None
        switch_samples = []
        smart_cfg = CONFIG.get("tracking", {}).get("smart_switch", {})
        motion_threshold = max(0.0, float(smart_cfg.get("motion_threshold", 0.8)))
        confirmation_frames = max(1, int(smart_cfg.get("confirmation_frames", 1)))
        switch_confirm_frames = max(1, int(smart_cfg.get("switch_confirm_frames", 2)))
        min_switch_hold = max(0.0, float(smart_cfg.get("min_hold_sec", 1.2)))
        min_crop_ratio = clamp(float(smart_cfg.get("min_crop_height_ratio", 0.42)), 0.2, 1.0)
        max_crop_ratio = clamp(float(smart_cfg.get("max_crop_height_ratio", 1.0)), min_crop_ratio, 1.0)
        crop_vertical_position = clamp(
            float(smart_cfg.get("crop_face_vertical_position", 0.44)),
            0.2,
            0.8,
        )
        tracker = SmartSpeakerTracker(
            width,
            height,
            TrackingConfig(
                mouth_motion_threshold=motion_threshold,
                live_min_face_samples=max(2, confirmation_frames + 1),
                live_min_motion_hits=confirmation_frames,
                switch_confirm_samples=switch_confirm_frames,
                min_switch_interval_sec=min_switch_hold,
                crop_face_height_multiplier=max(1.0, float(smart_cfg.get("crop_face_height_multiplier", 2.15))),
                minimum_crop_height_ratio=min_crop_ratio,
                maximum_crop_height_ratio=max_crop_ratio,
            ),
        ) if framing_mode == "smart_switch" else None
        diarization_timeline = build_diarization_timeline(
            clip_words or [],
            clip_start=start_time,
            clip_end=start_time + clip_duration,
        ) if tracker is not None else []

        for i in range(sample_count):
            rel_time = min(i * sample_step_sec, max(0.0, analysis_duration - 0.05))
            frame_time = _quantized_sample_time(start_time + rel_time, sample_step_sec)
            frame_time = min(start_time + analysis_duration, max(start_time, frame_time))
            rel_time = max(0.0, frame_time - start_time)
            speaker_cue = diarization_cue_at_time(
                diarization_timeline,
                frame_time,
                tolerance_sec=max(0.65, sample_step_sec * 1.25),
            ) if diarization_timeline else None
            speaker_label = speaker_cue.get("speaker") if speaker_cue else None
            speaker_confidence = speaker_cue.get("speaker_confidence") if speaker_cue else None
            cap.set(cv2.CAP_PROP_POS_MSEC, frame_time * 1000.0)
            ret, frame = cap.read()
            if not ret:
                break
            sampled_frames += 1

            detections = detect_frame_subjects_cached(video_path, frame_time, frame, model=model)
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if framing_mode == "smart_switch" else None
            if not detections:
                if tracker is not None:
                    held_sample = tracker.update(
                        rel_time,
                        [],
                        speaker_label=speaker_label,
                        speaker_confidence=speaker_confidence,
                    )
                    if held_sample is not None:
                        switch_samples.append(held_sample)
                    prev_gray = gray
                continue

            best_subject = detections[0]
            if framing_mode != "smart_switch":
                positions.append(best_subject["cx"])
                face_tops.append(best_subject["top"])

            subjects = _dedupe_subjects(detections, width)
            pair = _group_subjects_by_side(subjects, width)
            if pair:
                dual_frames += 1
                left_centers.append(pair[0]["cx"])
                right_centers.append(pair[-1]["cx"])

            if framing_mode == "smart_switch":
                tracked_subjects = []
                for subject in subjects or [best_subject]:
                    tracked = dict(subject)
                    tracked.setdefault("cy", int((tracked.get("top", 0) + tracked.get("bottom", 0)) / 2))
                    motion = _motion_score(prev_gray, gray, tracked)
                    border_strength = _active_speaker_border_strength(frame, tracked)
                    border_threshold = clamp(float(smart_cfg.get("active_border_min_strength", 0.25)), 0.05, 1.0)
                    if border_strength >= border_threshold:
                        motion = max(
                            motion,
                            motion_threshold + (border_strength * max(0.0, float(smart_cfg.get("active_border_motion_bonus", 6.0)))),
                        )
                    tracked["motion"] = motion
                    tracked["active_border_strength"] = border_strength
                    tracked_subjects.append(tracked)
                active_sample = tracker.update(
                    rel_time,
                    tracked_subjects,
                    speaker_label=speaker_label,
                    speaker_confidence=speaker_confidence,
                ) if tracker is not None else None
                if active_sample is not None:
                    crop_height = int(active_sample.get("crop_height", height))
                    crop_width = max(2, int(crop_height * (9 / 16)))
                    crop_x = int(clamp(
                        int(active_sample.get("center_x", width // 2)) - (crop_width // 2),
                        0,
                        max(0, width - crop_width),
                    ))
                    base_top = _smart_crop_top(
                        active_sample.get("center_y", height // 2),
                        crop_height,
                        height,
                        crop_vertical_position,
                    )
                    nearest_face = min(
                        (item for item in tracked_subjects if item.get("kind") == "face"),
                        key=lambda item: (
                            abs(float(item.get("cx", 0)) - float(active_sample.get("center_x", 0)))
                            + abs(float(item.get("cy", 0)) - float(active_sample.get("center_y", 0)))
                        ),
                        default=None,
                    )
                    matte_top, fitted_crop_height = _detect_top_matte_bottom(
                        frame,
                        crop_x,
                        base_top,
                        crop_width,
                        crop_height,
                        face_top=nearest_face.get("top") if nearest_face else None,
                        return_height=True,
                    )
                    active_sample["crop_height"] = fitted_crop_height
                    active_sample["suggested_crop_height"] = fitted_crop_height
                    active_sample["crop_top"] = _smart_crop_top(
                        active_sample.get("center_y", height // 2),
                        fitted_crop_height,
                        height,
                        crop_vertical_position,
                        detected_top=matte_top,
                    )
                    switch_samples.append(active_sample)
                prev_gray = gray
    except Exception as e:
        print(f"  ⚠️  Speaker layout analysis failed: {e}")
        return fallback_layout
    finally:
        cap.release()

    has_reliable_pair = bool(left_centers and right_centers and dual_frames >= max(2, int(sampled_frames * 0.30)))
    if has_reliable_pair:
        left_center = int(np.median(left_centers))
        right_center = int(np.median(right_centers))
        split_x = int((left_center + right_center) / 2)
        split_x = int(clamp(split_x, int(width * 0.28), int(width * 0.72)))

        if framing_mode == "smart_switch":
            switch_segments = _merge_switch_segments(switch_samples, clip_duration, min_segment=min_switch_hold)
            if switch_segments:
                print(f"  > Smart speaker switch timeline: {len(switch_segments)} segment(s)")
                crop_height = int(np.median([segment.get("crop_height", height) for segment in switch_segments]))
                center_y = int(np.median([segment.get("center_y", height // 2) for segment in switch_segments]))
                crop_tops = [segment.get("crop_top") for segment in switch_segments if segment.get("crop_top") is not None]
                crop_top = int(np.median(crop_tops)) if crop_tops else None
                for segment in switch_segments:
                    segment["center_x_ratio"] = round_float(safe_div(segment["center_x"], width), 4)
                    segment["center_y_ratio"] = round_float(safe_div(segment["center_y"], height), 4)
                    segment["crop_height_ratio"] = round_float(safe_div(crop_height, height), 4)
                    segment["crop_height"] = crop_height
                    if segment.get("crop_top") is not None:
                        segment["crop_top_ratio"] = round_float(safe_div(segment["crop_top"], height), 4)
                return {
                    "mode": "smart_switch",
                    "switch_segments": switch_segments,
                    "static_center": switch_segments[0]["center_x"],
                    "static_center_ratio": round_float(safe_div(switch_segments[0]["center_x"], width), 4),
                    "center_y": center_y,
                    "center_y_ratio": round_float(safe_div(center_y, height), 4),
                    "crop_height": crop_height,
                    "crop_height_ratio": round_float(safe_div(crop_height, height), 4),
                    "speaker_track_map": tracker.speaker_track_map,
                    **({
                        "crop_top": crop_top,
                        "crop_top_ratio": round_float(safe_div(crop_top, height), 4),
                    } if crop_top is not None else {}),
                    "split_x": split_x,
                    "split_x_ratio": round_float(safe_div(split_x, width), 4),
                }

        print("  > Two-speaker side-by-side layout detected; stacking speakers vertically")
        return {
            "mode": "dual_stack",
            "split_x": split_x,
            "split_x_ratio": round_float(safe_div(split_x, width), 4),
            "left_center_ratio": round_float(safe_div(left_center, width), 4),
            "right_center_ratio": round_float(safe_div(right_center, width), 4),
            "static_center": width // 2,
            "static_center_ratio": round_float(0.5, 4),
        }

    if framing_mode == "smart_switch":
        switch_segments = _merge_switch_segments(switch_samples, clip_duration, min_segment=min_switch_hold)
        if switch_segments:
            print(f"  > Smart speaker switch timeline: {len(switch_segments)} segment(s)")
            crop_height = int(np.median([segment.get("crop_height", height) for segment in switch_segments]))
            center_y = int(np.median([segment.get("center_y", height // 2) for segment in switch_segments]))
            crop_tops = [segment.get("crop_top") for segment in switch_segments if segment.get("crop_top") is not None]
            crop_top = int(np.median(crop_tops)) if crop_tops else None
            for segment in switch_segments:
                segment["center_x_ratio"] = round_float(safe_div(segment["center_x"], width), 4)
                segment["center_y_ratio"] = round_float(safe_div(segment["center_y"], height), 4)
                segment["crop_height_ratio"] = round_float(safe_div(crop_height, height), 4)
                segment["crop_height"] = crop_height
                if segment.get("crop_top") is not None:
                    segment["crop_top_ratio"] = round_float(safe_div(segment["crop_top"], height), 4)
            return {
                "mode": "smart_switch",
                "switch_segments": switch_segments,
                "static_center": switch_segments[0]["center_x"],
                "static_center_ratio": round_float(safe_div(switch_segments[0]["center_x"], width), 4),
                "center_y": center_y,
                "center_y_ratio": round_float(safe_div(center_y, height), 4),
                "crop_height": crop_height,
                "crop_height_ratio": round_float(safe_div(crop_height, height), 4),
                "speaker_track_map": tracker.speaker_track_map,
                **({
                    "crop_top": crop_top,
                    "crop_top_ratio": round_float(safe_div(crop_top, height), 4),
                } if crop_top is not None else {}),
            }

    if framing_mode == "dual_stack":
        print("  > Forced stack requested, but only one speaker was detected")

    if positions:
        static_center = int(np.median(positions))
        avg_face_top = int(np.median(face_tops)) if face_tops else 0
        if avg_face_top < height * 0.2 and avg_face_top > 0:
            print("  > Adjusting position to show full head")
        print(f"  > Locked onto speaker at X={static_center} (Full head visible)")
        return {
            "mode": "single",
            "static_center": static_center,
            "static_center_ratio": round_float(safe_div(static_center, width), 4),
        }

    print("  > No speaker detected, using center")
    return fallback_layout


def get_static_speaker_position(video_path, start_time=0, sample_duration=3, clip_words=None):
    return analyze_speaker_layout(
        video_path,
        start_time,
        sample_duration,
        clip_words=clip_words,
    ).get("static_center", 960)

def snap_to_sentence_end(words, target_time, window=4.0):
    """Snap clip end to the nearest sentence-ending punctuation within window seconds.
    Falls back to the nearest word boundary if no sentence end is found."""
    if not words:
        return target_time

    # First pass: find sentence-ending punctuation near target
    best_sentence = None
    best_sentence_dist = float('inf')
    for w in words:
        if w['end'] < target_time - window:
            continue
        if w['end'] > target_time + window:
            break
        if w['word'].rstrip().endswith(('.', '!', '?')):
            dist = abs(w['end'] - target_time)
            if dist < best_sentence_dist:
                best_sentence_dist = dist
                best_sentence = w['end']

    if best_sentence is not None:
        return best_sentence

    # Second pass: nearest word boundary (prefer not cutting mid-word)
    last_word_before = None
    for w in words:
        if w['end'] <= target_time + 1.0:
            last_word_before = w['end']
    return last_word_before if last_word_before is not None else target_time


def extract_audio_for_analysis(video_path):
    """Extract audio from video to a WAV file once, for librosa analysis."""
    audio_path = os.path.join(TEMP_DIR, "analysis_audio.wav")
    if os.path.exists(audio_path):
        os.remove(audio_path)
    cmd = [
        RUNTIME_HARDWARE["ffmpeg_bin"], "-y", "-nostdin", "-v", "error",
        "-i", video_path,
        "-vn", "-ac", "1", "-ar", "22050",
        "-f", "wav", audio_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if result.returncode == 0 and os.path.exists(audio_path):
        return audio_path
    print(f"  ⚠️  Audio extraction failed: {result.stderr.strip()}")
    return None


def topics_for_range(topics, start, end):
    names = []
    for topic in topics or []:
        if isinstance(topic, str):
            name = topic.strip()
            topic_start = topic_end = None
        elif isinstance(topic, dict):
            name = str(topic.get("topic") or topic.get("name") or "").strip()
            try:
                topic_start = float(topic["start"]) if topic.get("start") is not None else None
                topic_end = float(topic["end"]) if topic.get("end") is not None else None
            except (TypeError, ValueError):
                topic_start = topic_end = None
        else:
            continue
        if not name:
            continue
        if topic_start is not None and topic_end is not None and not (topic_end > start and topic_start < end):
            continue
        if name.casefold() not in {existing.casefold() for existing in names}:
            names.append(name)
    return names[:12]


def clip_from_intelligence_window(window, segment_records, provider_topics=None):
    start = float(window.get("start", 0.0))
    end = float(window.get("end", start))
    overlapping = [
        segment for segment in segment_records
        if float(segment.get("end", 0.0)) > start and float(segment.get("start", 0.0)) < end
    ]
    words = [
        dict(word)
        for segment in overlapping
        for word in segment.get("words", [])
        if float(word.get("end", 0.0)) > start and float(word.get("start", 0.0)) < end
    ]
    if window.get("words"):
        words = [dict(word) for word in window["words"]]
    words.sort(key=lambda word: (float(word.get("start", 0.0)), float(word.get("end", 0.0))))
    text = str(window.get("text") or words_to_text(words)).strip()
    peak = max((float(segment.get("candidate_score", 0.0)) for segment in overlapping), default=0.0)
    reason_points = {
        reason: float(segment.get("candidate_score", 0.0))
        for segment in overlapping
        for reason in segment.get("reasons", [])
    }
    topics = topics_for_range(provider_topics, start, end)
    for topic in window.get("topics", []) or []:
        value = str(topic).strip()
        if value and value.casefold() not in {existing.casefold() for existing in topics}:
            topics.append(value)
    return {
        "id": str(window.get("id") or f"candidate-{start:.3f}-{end:.3f}"),
        "start": start,
        "end": end,
        "text": text.lower(),
        "context_before": str(window.get("context_before") or "").strip(),
        "context_after": str(window.get("context_after") or "").strip(),
        "words": words,
        "candidate_score": peak,
        "score": peak,
        "reasons": make_reason_list(reason_points),
        "topics": topics[:12],
        "segments": overlapping,
    }


def build_broad_candidate_clips(transcript, segment_records):
    max_duration = min(float(CONFIG["selection"]["max_clip_duration"]), 75.0)
    provider_topics = transcript.get("topics", []) if isinstance(transcript, dict) else []
    configured_min = max(6.0, float(CONFIG["selection"]["min_clip_duration"]))
    clips = []
    seen = set()
    for requested_target in (20.0, 35.0, 50.0, 70.0):
        target_duration = min(max_duration, requested_target)
        min_duration = min(target_duration, max(configured_min, target_duration * 0.55))
        if target_duration < configured_min:
            continue
        windows = build_candidate_windows(
            transcript,
            target_duration_sec=target_duration,
            stride_sec=max(5.0, target_duration * 0.5),
            min_duration_sec=min_duration,
            max_duration_sec=max_duration,
        )
        for window_index, window in enumerate(windows):
            identity = (
                round(float(window.get("start", 0.0)), 3),
                round(float(window.get("end", 0.0)), 3),
                str(window.get("text", "")).casefold(),
            )
            if identity in seen:
                continue
            seen.add(identity)
            window = dict(window)
            window["id"] = f"candidate-{int(target_duration):02d}-{window_index:04d}"
            window["window_target_sec"] = target_duration
            clips.append(clip_from_intelligence_window(window, segment_records, provider_topics))
    return clips


def create_gemini_proxy_chunk(video_path, start, duration):
    """Create a small deterministic proxy that stays below Gemini inline limits."""
    handle = tempfile.NamedTemporaryFile(prefix="gemini_proxy_", suffix=".mp4", dir=TEMP_DIR, delete=False)
    output_path = handle.name
    handle.close()
    try:
        os.remove(output_path)
    except OSError:
        pass
    command = [
        RUNTIME_HARDWARE["ffmpeg_bin"], "-y", "-nostdin", "-v", "error",
        "-ss", str(max(0.0, start)), "-t", str(max(0.1, duration)), "-i", video_path,
        "-map", "0:v:0", "-map", "0:a?",
        "-vf", "scale=480:-2:force_original_aspect_ratio=decrease,fps=12",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-b:v", "140k", "-maxrate", "160k", "-bufsize", "320k",
        "-c:a", "aac", "-b:a", "32k", "-ac", "1", "-ar", "16000",
        "-movflags", "+faststart", output_path,
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=max(180, int(duration * 2)))
    if result.returncode != 0 or not os.path.exists(output_path):
        try:
            os.remove(output_path)
        except OSError:
            pass
        raise RuntimeError(f"Gemini proxy creation failed: {summarize_process_error(result.stderr)}")
    return output_path


def analyze_with_gemini(video_path, analysis_start=0.0, analysis_end=None):
    client = GeminiVideoClient.from_environment(
        model=os.environ.get("VCF_GEMINI_MODEL", "gemini-3.5-flash"),
        timeout_sec=float(os.environ.get("VCF_GEMINI_TIMEOUT_SEC", "900")),
    )
    source_duration = probe_duration(video_path, ffprobe_bin=RUNTIME_HARDWARE["ffprobe_bin"])
    analysis_start = max(0.0, min(source_duration, float(analysis_start or 0.0)))
    analysis_end = source_duration if analysis_end is None else min(source_duration, float(analysis_end))
    duration = max(0.1, analysis_end - analysis_start)
    print("☁️  Gemini analysis enabled: uploading one compact video/audio proxy...")
    proxy_path = create_gemini_proxy_chunk(video_path, analysis_start, duration)
    try:
        results = client.analyze_media_path(proxy_path, duration_sec=duration, mime_type="video/mp4")
        for index, result in enumerate(results):
            result["id"] = f"gemini-{index:04d}-{result.get('id', 'moment')}"
            result["start"] = analysis_start + float(result.get("start", 0.0))
            result["end"] = analysis_start + float(result.get("end", result["start"] - analysis_start))
            for word in result.get("words", []) or []:
                word["start"] = analysis_start + float(word.get("start", 0.0))
                word["end"] = analysis_start + float(word.get("end", word["start"] - analysis_start))
        return results, client.model
    finally:
        try:
            os.remove(proxy_path)
        except OSError:
            pass


def apply_optional_viral_intelligence(
    video_path,
    clips,
    segment_records,
    transcript,
    analysis_start=0.0,
    analysis_end=None,
):
    """Apply local semantic and optional Gemini scores without making them fatal."""
    output_scale = float(CONFIG.get("scoring", {}).get("output_scale", 15.0))
    providers = {
        "heuristic": {"status": "success", "provider": "hybrid_v2", "cloud": False},
        "local_semantic": {"status": "disabled", "cloud": False},
        "gemini": {"status": "disabled", "cloud": True},
    }
    provider_topics = transcript.get("topics", []) if isinstance(transcript, dict) else []
    for index, clip in enumerate(clips):
        clip.setdefault("id", f"candidate-{index:04d}")
        clip["heuristic_score"] = round(float(clip.get("score", 0.0)) * (10.0 / output_scale), 3)
        clip["topics"] = list(dict.fromkeys([
            *clip.get("topics", []),
            *topics_for_range(provider_topics, float(clip.get("start", 0.0)), float(clip.get("end", 0.0))),
        ]))[:12]

    semantic_by_id = {}
    if RUNTIME_HARDWARE.get("local_semantic") and clips:
        try:
            client = LocalSemanticClient.from_environment(
                timeout_sec=float(os.environ.get("VCF_LOCAL_LLM_TIMEOUT_SEC", "90"))
            )
            selected = select_semantic_candidates(clips, top_heuristic=60, time_diverse=20)
            # Smaller batches fit ordinary local-model context windows and make
            # one malformed response less likely to discard the whole rerank.
            batch_size = max(1, int(os.environ.get("VCF_LOCAL_LLM_BATCH_SIZE", "12")))
            for batch_start in range(0, len(selected), batch_size):
                batch = selected[batch_start:batch_start + batch_size]
                for item in client.rank_candidates(batch):
                    semantic_by_id[item["candidate_id"]] = item
            providers["local_semantic"] = {
                "status": "success", "provider": "openai_compatible", "model": client.model,
                "cloud": False, "scored_candidates": len(semantic_by_id),
            }
            print(f"🧠 Local semantic reranker scored {len(semantic_by_id)} candidate window(s)")
        except Exception as error:
            providers["local_semantic"] = {
                "status": "failed", "provider": "openai_compatible", "cloud": False,
                "fallback": "heuristic", "error": str(error)[:500],
            }
            print(f"  ⚠️  Local semantic reranking unavailable ({error}); using heuristic scores")

    gemini_results = []
    if RUNTIME_HARDWARE.get("gemini_analysis"):
        try:
            gemini_results, gemini_model = analyze_with_gemini(
                video_path,
                analysis_start=analysis_start,
                analysis_end=analysis_end,
            )
            providers["gemini"] = {
                "status": "success", "provider": "gemini", "model": gemini_model,
                "cloud": True, "candidates": len(gemini_results),
            }
            print(f"✨ Gemini returned {len(gemini_results)} timestamped candidate moment(s)")
        except Exception as error:
            providers["gemini"] = {
                "status": "failed", "provider": "gemini", "cloud": True,
                "fallback": "local", "error": str(error)[:500],
            }
            print(f"  ⚠️  Gemini analysis unavailable ({error}); continuing with local analysis")

    gemini_clips = []
    for result in gemini_results:
        gemini_clip = clip_from_intelligence_window(result, segment_records, provider_topics)
        heuristic_score, reasons, breakdown = score_clip_candidate(gemini_clip)
        gemini_clip.update({
            "score": heuristic_score,
            "heuristic_score": round(heuristic_score * (10.0 / output_scale), 3),
            "candidate_score": gemini_clip.get("candidate_score", 0.0),
            "reasons": list(dict.fromkeys([*result.get("reasons", []), *reasons])),
            "score_breakdown": breakdown,
            "gemini_score": result.get("gemini_score"),
        })
        gemini_clips.append(gemini_clip)

    combined = [*clips, *gemini_clips]
    for clip in combined:
        semantic = semantic_by_id.get(str(clip.get("id")))
        best_gemini = None
        best_overlap = 0.0
        if clip.get("gemini_score") is not None:
            best_gemini = clip
            best_overlap = 1.0
        else:
            for candidate in gemini_results:
                overlap = temporal_iou(clip, candidate)
                if overlap > best_overlap:
                    best_overlap = overlap
                    best_gemini = candidate
            if best_overlap < 0.2:
                best_gemini = None

        semantic_score = semantic.get("semantic_score") if semantic else None
        gemini_score = best_gemini.get("gemini_score") if best_gemini else None
        score, weights = ensemble_score(
            clip.get("heuristic_score", 0.0),
            semantic_score=semantic_score,
            gemini_score=gemini_score,
        )
        clip["ensemble_score"] = score
        clip["score"] = round_float(score * (output_scale / 10.0))
        clip["semantic_score"] = semantic_score
        clip["gemini_score"] = gemini_score
        clip["topics"] = list(dict.fromkeys([
            *clip.get("topics", []),
            *(semantic.get("topics", []) if semantic else []),
            *(best_gemini.get("topics", []) if best_gemini else []),
        ]))[:12]
        clip["reasons"] = list(dict.fromkeys([
            *(semantic.get("reasons", []) if semantic else []),
            *(best_gemini.get("reasons", []) if best_gemini else []),
            *clip.get("reasons", []),
        ]))[:8]
        breakdown = dict(clip.get("score_breakdown", {}))
        breakdown["intelligence"] = {
            "heuristic_score": clip.get("heuristic_score"),
            "semantic_score": semantic_score,
            "gemini_score": gemini_score,
            "weights": weights,
            "topics": clip["topics"],
        }
        clip["score_breakdown"] = breakdown
        clip["intelligence_providers"] = providers
        clip["ranking_version"] = "ensemble_v3"

    if RUNTIME_HARDWARE.get("local_semantic") or RUNTIME_HARDWARE.get("gemini_analysis"):
        combined = dedupe_temporal_candidates(combined, iou_threshold=0.65, score_key="ensemble_score")
    return combined


def analyze_transcript(video_path, analysis_start=0.0, analysis_end=None):
    """Transcribe, generate broad segment candidates, then ensemble-rerank clips."""
    result = transcript_for_analysis_range(
        transcribe_source(video_path),
        analysis_start=analysis_start,
        analysis_end=analysis_end,
    )

    viral_candidates = []
    all_segment_records = []
    audio_path_for_analysis = None
    if LIBROSA_AVAILABLE:
        print("🎵 Extracting audio for emotion analysis...")
        audio_path_for_analysis = extract_audio_for_analysis(video_path)

    print("📊 Analyzing Viral Potential (HYBRID RERANK MODE)...")
    keywords = CONFIG['keywords']

    for seg in result["segments"]:
        duration = seg["end"] - seg["start"]
        if duration < 0.15:
            continue

        text = seg["text"].strip().lower()
        if not text:
            continue

        word_count = len(text.split())
        wps = word_count / duration if duration > 0 else 0.0

        audio_score, audio_features, audio_metrics = (0.0, [], {})
        if LIBROSA_AVAILABLE and audio_path_for_analysis:
            audio_score, audio_features, audio_metrics = analyze_audio_emotion(
                audio_path_for_analysis,
                seg["start"],
                seg["end"],
                return_details=True,
            )

        visual_score, visual_features, visual_metrics = analyze_visual_quality(
            video_path,
            seg["start"],
            seg["end"],
            return_details=True,
        )

        signals = build_segment_signals(
            seg,
            text,
            duration,
            wps,
            keywords,
            audio_score=audio_score,
            audio_features=audio_features,
            audio_metrics=audio_metrics,
            visual_score=visual_score,
            visual_features=visual_features,
            visual_metrics=visual_metrics,
        )
        candidate_score, reasons = score_segment_candidate(signals)

        words = []
        for w in seg.get("words", []):
            word_record = {
                "word": w["word"].strip(),
                "start": w["start"],
                "end": w["end"],
            }
            if w.get("confidence") is not None:
                word_record["confidence"] = w["confidence"]
            speaker = w.get("speaker", seg.get("speaker"))
            if speaker is not None:
                word_record["speaker"] = speaker
            speaker_confidence = w.get("speaker_confidence", seg.get("speaker_confidence"))
            if speaker_confidence is not None:
                try:
                    word_record["speaker_confidence"] = float(speaker_confidence)
                except (TypeError, ValueError):
                    pass
            words.append(word_record)

        segment_record = {
            "start": seg["start"],
            "end": seg["end"],
            "text": text,
            "words": words,
            "candidate_score": candidate_score,
            "reasons": reasons,
            "signals": signals,
        }
        for key in ("speaker", "speaker_confidence", "speakers"):
            if seg.get(key) is not None:
                segment_record[key] = (
                    list(seg[key]) if key == "speakers" and isinstance(seg[key], (list, tuple))
                    else seg[key]
                )
        all_segment_records.append(segment_record)

    if audio_path_for_analysis and os.path.exists(audio_path_for_analysis):
        os.remove(audio_path_for_analysis)

    if all_segment_records:
        # Always start from overlapping sentence-aligned windows. Keywords and
        # semantic providers improve ranking, but never gate candidate recall.
        viral_candidates = build_broad_candidate_clips(result, all_segment_records)

    print(f"  > Found {len(viral_candidates)} candidate segments. Processing...")
    if not viral_candidates and not RUNTIME_HARDWARE.get("gemini_analysis"):
        return {
            "selected": [],
            "reserves": [],
            "ranked_candidates": [],
            "yield": {
                "volume": RUNTIME_HARDWARE.get("clip_volume", "balanced"),
                "active_speech_seconds": active_speech_duration(result.get("segments", [])),
                "target": 0,
                "soft_min": 0,
                "max_clips": int(CONFIG['selection']['max_clips_to_export']),
                "target_met": False,
                "soft_min_met": False,
                "stats": {},
            },
        }

    reranked_clips = []
    for clip in viral_candidates:
        final_score, reasons, breakdown = score_clip_candidate(clip)
        clip["score"] = final_score
        clip["reasons"] = reasons
        clip["score_breakdown"] = breakdown
        clip["boundary_quality"] = breakdown.get("boundary_quality", {})
        clip["ranking_version"] = "hybrid_v3"
        reranked_clips.append(clip)

    reranked_clips = apply_optional_viral_intelligence(
        video_path,
        reranked_clips,
        all_segment_records,
        result,
        analysis_start=analysis_start,
        analysis_end=analysis_end,
    )

    reranked_clips.sort(key=lambda x: x["score"], reverse=True)

    max_clips = int(CONFIG['selection']['max_clips_to_export'])
    yield_batch = build_yield_batch(
        reranked_clips,
        active_speech_duration(result.get("segments", [])),
        volume=RUNTIME_HARDWARE.get("clip_volume", "balanced"),
        max_clips=max_clips,
        exact_count=RUNTIME_HARDWARE.get("target_clips"),
    )
    cluster_metadata = {}
    for cluster in yield_batch.get("clusters", []):
        representative_id = str(cluster.get("representative_id") or "")
        for variant_rank, candidate_id in enumerate(cluster.get("candidate_ids", []), start=1):
            cluster_metadata[str(candidate_id)] = {
                "cluster_id": cluster.get("cluster_id"),
                "variant_rank": variant_rank,
                "duplicate_of": None if variant_rank == 1 else representative_id,
            }
    for clip in reranked_clips:
        candidate_id = str(clip.get("yield_id") or clip.get("id") or "")
        if candidate_id in cluster_metadata:
            clip.update(cluster_metadata[candidate_id])
    for clip in reranked_clips:
        clip["confidence_tier"] = confidence_tier(clip.get("score"))
    for clip in [*yield_batch["selected"], *yield_batch["reserves"]]:
        clip["confidence_tier"] = clip.get("yield_tier") or confidence_tier(clip.get("score"))
        clip["yield_plan"] = {
            "volume": yield_batch["volume"],
            "target": yield_batch["target"],
            "soft_min": yield_batch["soft_min"],
            "active_speech_minutes": yield_batch["active_speech_minutes"],
        }

    stats = yield_batch["stats"]
    print(
        f"  > Shorts yield: {len(yield_batch['selected'])} primary +"
        f" {len(yield_batch['reserves'])} reserve from {stats['deduped']} diverse candidates"
    )
    print(
        f"  > Volume={yield_batch['volume']} | target={yield_batch['target']} |"
        f" soft minimum={yield_batch['soft_min']} | cap={yield_batch['max_clips']}"
    )
    print(
        "  > Confidence tiers:"
        f" {stats['tiers']['best']} best, {stats['tiers']['strong']} strong,"
        f" {stats['tiers']['review']} worth reviewing"
    )
    if yield_batch["selected"]:
        selected_scores = [float(clip.get("score", 0.0)) for clip in yield_batch["selected"]]
        print(f"  > Selected score range: {max(selected_scores):.1f} to {min(selected_scores):.1f}")

    return {
        "selected": yield_batch["selected"],
        "reserves": yield_batch["reserves"],
        "ranked_candidates": reranked_clips,
        "yield": {
            key: yield_batch[key]
            for key in (
                "volume", "active_speech_seconds", "active_speech_minutes", "target",
                "soft_min", "max_clips", "exact", "target_met", "soft_min_met", "stats",
            )
        },
    }

def summarize_process_error(stderr, max_lines=3):
    if not stderr:
        return ""

    lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    if not lines:
        return ""

    return " | ".join(lines[-max_lines:])


def probe_video_stream(video_path):
    try:
        probe = subprocess.run([
            RUNTIME_HARDWARE["ffprobe_bin"], "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=color_transfer,pix_fmt",
            "-of", "json",
            video_path
        ], capture_output=True, text=True, check=True)
        info = json.loads(probe.stdout or "{}")
        return (info.get("streams") or [{}])[0]
    except Exception as e:
        print(f"  ⚠️  Stream probe failed, using default 8-bit preprocessing filter: {e}")
        return {}


def build_preprocess_filter(video_path):
    base_scale = "scale=1920:1080:force_original_aspect_ratio=decrease"
    stream = probe_video_stream(video_path)
    is_hdr = stream.get("color_transfer") in ["smpte2084", "arib-std-b67"]
    is_ten_bit = "10" in str(stream.get("pix_fmt") or "")

    if is_hdr or is_ten_bit:
        print("  > HDR/10-bit input detected; normalizing to 8-bit SDR for preprocessing")

    return f"{base_scale},format=yuv420p"


def sanitize_video_for_processing(video_path):
    """Create a decoder-friendly mezzanine file to avoid corrupted frame stalls."""
    safe_path = os.path.join(TEMP_DIR, "input_sanitized.mp4")

    # Always regenerate per run to avoid stale/corrupted leftovers
    if os.path.exists(safe_path):
        os.remove(safe_path)

    print("🧹 Sanitizing input for stable decoding...")
    sanitize_filter = build_preprocess_filter(video_path)

    common_flags = [
        "-y", "-v", "error",
        "-probesize", "100M", "-analyzeduration", "100M",
        "-fflags", "+discardcorrupt+genpts",
        "-err_detect", "ignore_err",
        "-i", video_path,
    ]

    def build_command(backend):
        vf = encoder_filter(sanitize_filter, backend, False)
        return [
            *build_encoder_command_prefix(backend),
            *common_flags,
            "-vf", vf,
            *encoder_args(backend, False, "proxy"),
            "-c:a", "aac",
            "-movflags", "+faststart",
            safe_path,
        ]

    try:
        backend, _ = run_with_encoder_fallback(
            build_command,
            configured_video_backends(False),
            context="Input sanitization",
        )
        RUNTIME_HARDWARE["resolved_video_encoder"] = backend
        print(f"✅ Sanitized input ready ({backend})")
        return safe_path
    except RuntimeError as error:
        print(f"⚠️  Sanitization failed: {error}")

    print("⚠️  All sanitization attempts failed, using original input")
    return video_path


def create_proxy(video_path):
    """Create a 1080p proxy for faster analysis. Skip if source is already <= 1080p."""
    proxy_path = os.path.join(TEMP_DIR, "proxy_analysis.mp4")

    # Check source resolution — skip proxy if already 1080p or smaller
    cap = cv2.VideoCapture(video_path)
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    if src_h <= 1080:
        print(f"🎥 Source is {src_h}p — skipping proxy, using original")
        return video_path

    print("🎥 Creating 1080p Proxy...")
    # Remove stale proxy
    if os.path.exists(proxy_path):
        os.remove(proxy_path)

    proxy_filter = build_preprocess_filter(video_path)
    common_args = [
        "-y", "-v", "error",
        "-i", video_path,
    ]

    def build_command(backend):
        vf = encoder_filter(proxy_filter, backend, False)
        return [
            *build_encoder_command_prefix(backend),
            *common_args,
            "-vf", vf,
            *encoder_args(backend, False, "proxy"),
            "-c:a", "aac",
            proxy_path,
        ]

    try:
        backend, _ = run_with_encoder_fallback(
            build_command,
            configured_video_backends(False),
            context="Analysis proxy",
        )
        RUNTIME_HARDWARE["resolved_video_encoder"] = backend
        return proxy_path
    except RuntimeError as error:
        print(f"  ⚠️  Proxy creation failed: {error}")

    print("  ⚠️  Proxy creation failed, using source directly")
    return video_path

def get_render_settings(is_hdr, src_w, src_h, target_upscale=False):
    """Return encoder candidates and output resolution."""
    target_w, target_h = src_w, src_h
    if target_upscale:
        if src_w < 7680:
            target_w = 7680
            target_h = int(target_w * (src_h / src_w))
            print(f"  > Upscaling to 8K ({target_w}x{target_h})...")

    if is_hdr:
        print("  > Detected HDR Source. Preserving 10-bit Color.")
    else:
        print("  > Detected SDR Source. Standard Export.")

    return configured_video_backends(is_hdr), target_w, target_h


_LONGFORM_TRANSITIONS = {
    "dissolve": "dissolve",
    "fade_black": "fadeblack",
    "fade_white": "fadewhite",
    "wipe_left": "wipeleft",
    "slide_left": "slideleft",
}


def _normalize_longform_transitions(creative, segments):
    """Validate transition requests and clamp overlap to adjacent program."""
    output = []
    seen_joins = set()
    join_count = max(0, len(segments) - 1)
    for raw in (creative or {}).get("transitions", []) or []:
        if not isinstance(raw, dict):
            continue
        try:
            join_index = int(raw.get("joinIndex"))
        except (TypeError, ValueError):
            continue
        transition_type = str(raw.get("type") or "cut")
        if join_index < 0 or join_index >= join_count or join_index in seen_joins:
            continue
        if transition_type != "cut" and transition_type not in _LONGFORM_TRANSITIONS:
            continue
        left_duration = max(0.0, float(segments[join_index][1]) - float(segments[join_index][0]))
        right_duration = max(0.0, float(segments[join_index + 1][1]) - float(segments[join_index + 1][0]))
        maximum = min(2.0, left_duration * 0.45, right_duration * 0.45)
        duration = 0.0
        if transition_type != "cut":
            if maximum < 0.08:
                continue
            duration = clamp(float(raw.get("duration", 0.35)), 0.08, maximum)
        maximum_audio_offset = min(2.0, left_duration * 0.45, right_duration * 0.45)
        audio_offset = clamp(
            float(raw.get("audioOffsetSec", 0.0)),
            -maximum_audio_offset,
            maximum_audio_offset,
        )
        if transition_type == "cut" and abs(audio_offset) < 0.001:
            continue
        output.append({
            **raw,
            "joinIndex": join_index,
            "type": transition_type,
            "ffmpegKind": _LONGFORM_TRANSITIONS.get(transition_type),
            "duration": round(duration, 3),
            "audioOffsetSec": round(audio_offset, 3),
        })
        seen_joins.add(join_index)
    return sorted(output, key=lambda item: item["joinIndex"])


def _longform_transition_durations(transitions, segment_count):
    durations = [0.0] * max(0, int(segment_count) - 1)
    for transition in transitions or []:
        join_index = int(transition.get("joinIndex", -1))
        if 0 <= join_index < len(durations):
            durations[join_index] = max(0.0, float(transition.get("duration", 0.0)))
    return durations


def _edited_time_for_source(source_time, segments, transition_durations=None):
    elapsed = 0.0
    point = float(source_time)
    overlaps = list(transition_durations or [])
    for index, (start, end) in enumerate(segments):
        if point < start:
            return elapsed
        if point <= end:
            return elapsed + max(0.0, point - start)
        elapsed += end - start
        if index < len(overlaps):
            elapsed -= max(0.0, float(overlaps[index]))
    return elapsed


def _longform_creative_timeline(creative, segments, transitions=None):
    creative = dict(creative or {})
    transition_durations = _longform_transition_durations(transitions, len(segments))
    for key in ("titles", "broll", "adjustmentLayers"):
        output = []
        for raw in creative.get(key, []) or []:
            if not isinstance(raw, dict):
                continue
            source_start = float(raw.get("start", 0.0))
            start = _edited_time_for_source(raw.get("start", 0.0), segments, transition_durations)
            end = _edited_time_for_source(
                raw.get("end", raw.get("start", 0.0)),
                segments,
                transition_durations,
            )
            if end - start < 0.05:
                continue
            item = {
                **raw,
                "sourceStart": round(source_start, 3),
                "start": round(start, 3),
                "end": round(end, 3),
            }
            if key == "broll":
                item["keyframes"] = [
                    {
                        **keyframe,
                        "time": round(
                            _edited_time_for_source(
                                keyframe.get("time", source_start),
                                segments,
                                transition_durations,
                            ),
                            3,
                        ),
                    }
                    for keyframe in raw.get("keyframes", []) or []
                    if isinstance(keyframe, dict)
                ]
            output.append(item)
        creative[key] = output
    captions = dict(creative.get("captions") or {})
    caption_cues = []
    for raw in captions.get("cues", []) or []:
        if not isinstance(raw, dict):
            continue
        start = _edited_time_for_source(raw.get("start", 0.0), segments, transition_durations)
        end = _edited_time_for_source(raw.get("end", raw.get("start", 0.0)), segments, transition_durations)
        if end - start >= 0.05 and str(raw.get("text") or "").strip():
            caption_cues.append({**raw, "start": round(start, 3), "end": round(end, 3)})
    captions["cues"] = caption_cues
    creative["captions"] = captions
    audio = dict(creative.get("audio") or {})
    audio["keyframes"] = [
        {
            **keyframe,
            "time": round(
                _edited_time_for_source(
                    keyframe.get("time", 0.0),
                    segments,
                    transition_durations,
                ),
                3,
            ),
        }
        for keyframe in audio.get("keyframes", []) or []
        if isinstance(keyframe, dict)
    ]
    creative["audio"] = audio
    multicam = dict(creative.get("multicam") or {})
    multicam_cuts = []
    for raw in multicam.get("cuts", []) or []:
        if not isinstance(raw, dict):
            continue
        source_start = float(raw.get("start", 0.0))
        start = _edited_time_for_source(source_start, segments, transition_durations)
        end = _edited_time_for_source(raw.get("end", source_start), segments, transition_durations)
        if end - start >= 0.05:
            multicam_cuts.append({
                **raw,
                "sourceStart": round(source_start, 3),
                "start": round(start, 3),
                "end": round(end, 3),
            })
    multicam["cuts"] = multicam_cuts
    creative["multicam"] = multicam
    creative["transitions"] = list(transitions or [])
    creative["outputDuration"] = max(
        0.0,
        sum(float(end) - float(start) for start, end in segments) - sum(transition_durations),
    )
    return creative


def _longform_export_size(preset, width, height, delivery=None):
    preset = str(preset or "source")
    delivery = dict(delivery or {})
    aspect = str(delivery.get("aspect") or "source")
    if aspect == "1:1":
        edge = 2160 if preset == "youtube_4k" else 1080
        return edge, edge
    if aspect == "9:16":
        return (2160, 3840) if preset == "youtube_4k" else (1080, 1920)
    if aspect == "16:9":
        return (3840, 2160) if preset == "youtube_4k" else (1920, 1080)
    if preset in {"youtube_1080p", "podcast"}:
        return 1920, 1080
    if preset == "youtube_4k":
        return 3840, 2160
    return int(width), int(height)


def _ffmpeg_filter_path(file_path):
    return str(file_path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def _ffmpeg_color(value, fallback):
    normalized = str(value or "").strip().lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", normalized):
        normalized = str(fallback).strip().lstrip("#")
    return f"0x{normalized.upper()}"


def _ass_color(value, fallback, alpha="00"):
    normalized = str(value or "").strip().lstrip("#")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", normalized):
        normalized = str(fallback).strip().lstrip("#")
    red, green, blue = normalized[0:2], normalized[2:4], normalized[4:6]
    return f"&H{alpha}{blue}{green}{red}"


def _ass_timestamp(value):
    total_centiseconds = max(0, int(round(float(value) * 100)))
    hours, remainder = divmod(total_centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    seconds, centiseconds = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centiseconds:02d}"


def _write_longform_ass(path_value, captions, width, height):
    cues = [
        cue for cue in captions.get("cues", []) or []
        if cue.get("text") and float(cue.get("end", 0.0)) > float(cue.get("start", 0.0))
    ]
    if not cues:
        return None
    position = str(captions.get("position") or "bottom")
    alignment = {"top": 8, "center": 5}.get(position, 2)
    margin_v = int(height * (0.08 if position != "center" else 0.0))
    font_size = max(18, min(96, int(float(captions.get("fontSize", 44)))))
    primary = _ass_color(captions.get("textColor"), "#FFFFFF")
    back = _ass_color(captions.get("backgroundColor"), "#09090B", alpha="48")
    with open(path_value, "w", encoding="utf-8") as handle:
        handle.write(
            "[Script Info]\n"
            "ScriptType: v4.00+\n"
            f"PlayResX: {int(width)}\n"
            f"PlayResY: {int(height)}\n"
            "ScaledBorderAndShadow: yes\n\n"
            "[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, "
            "ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, "
            "MarginR, MarginV, Encoding\n"
            f"Style: Caption,DejaVu Sans,{font_size},{primary},{primary},&HCC000000,{back},"
            f"-1,0,0,0,100,100,0,0,3,1,0,{alignment},80,80,{margin_v},1\n\n"
            "[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
        )
        for cue in cues:
            text = str(cue.get("text") or "").replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")
            text = text.replace("\r", " ").replace("\n", r"\N")
            speaker = str(cue.get("speaker") or "").strip()
            if speaker:
                text = f"{speaker}: {text}"
            handle.write(
                f"Dialogue: 0,{_ass_timestamp(cue['start'])},{_ass_timestamp(cue['end'])},"
                f"Caption,,0,0,0,,{text}\n"
            )
    return path_value


def _longform_keyframe_expression(keyframes, field, fallback):
    points = []
    for item in keyframes or []:
        try:
            points.append((float(item.get("time", 0.0)), float(item.get(field, fallback))))
        except (TypeError, ValueError):
            continue
    points.sort(key=lambda item: item[0])
    if not points:
        return f"{float(fallback):.6f}"
    expression = f"{points[-1][1]:.6f}"
    for index in range(len(points) - 2, -1, -1):
        start_t, start_value = points[index]
        end_t, end_value = points[index + 1]
        duration = max(0.001, end_t - start_t)
        interpolation = (
            f"{start_value:.6f}+({end_value - start_value:.6f})*"
            f"clip((t-{start_t:.6f})/{duration:.6f},0,1)"
        )
        expression = f"if(lt(t,{end_t:.6f}),{interpolation},{expression})"
    first_t, first_value = points[0]
    return f"if(lt(t,{first_t:.6f}),{first_value:.6f},{expression})"


def _longform_atempo_chain(rate):
    rate = clamp(float(rate), 0.05, 16.0)
    values = []
    while rate < 0.5 - 1e-6:
        values.append(0.5)
        rate /= 0.5
    while rate > 2.0 + 1e-6:
        values.append(2.0)
        rate /= 2.0
    values.append(rate)
    return [f"atempo={value:.8f}" for value in values if abs(value - 1.0) > 1e-6]


def _longform_speed_segments(clip):
    source_start = max(0.0, float(clip.get("sourceStart", 0.0)))
    source_end = max(source_start + 0.02, float(clip.get("sourceEnd", source_start + 0.02)))
    source_duration = source_end - source_start
    speed = dict(clip.get("speed") or {})
    base_rate = clamp(float(speed.get("rate", 1.0)), 0.05, 16.0)
    keyframes = []
    for item in speed.get("keyframes", []) or []:
        try:
            source_time = clamp(float(item.get("sourceTime", 0.0)), 0.0, source_duration)
            item_rate = clamp(float(item.get("speed", base_rate)), 0.05, 16.0)
        except (TypeError, ValueError):
            continue
        if 0.001 < source_time < source_duration - 0.001:
            keyframes.append((source_time, item_rate))
    keyframes.sort(key=lambda value: value[0])
    boundaries = [0.0, *[item[0] for item in keyframes], source_duration]
    segments = []
    current_rate = base_rate
    keyframe_index = 0
    for index in range(len(boundaries) - 1):
        relative_start = boundaries[index]
        relative_end = boundaries[index + 1]
        if index > 0 and keyframe_index < len(keyframes):
            current_rate = keyframes[keyframe_index][1]
            keyframe_index += 1
        if relative_end - relative_start > 0.001:
            segments.append((
                source_start + relative_start,
                source_start + relative_end,
                current_rate,
            ))
    return segments or [(source_start, source_end, base_rate)]


def _append_longform_sequence_video(
    filters,
    input_index,
    clip,
    *,
    prefix,
    target_w,
    target_h,
    frame_rate,
):
    timeline_start = max(0.0, float(clip.get("timelineStart", 0.0)))
    timeline_end = max(timeline_start + 0.02, float(clip.get("timelineEnd", timeline_start + 0.02)))
    timeline_duration = timeline_end - timeline_start
    speed = dict(clip.get("speed") or {})
    segments = _longform_speed_segments(clip)
    segment_inputs = []
    if len(segments) > 1:
        labels = [f"{prefix}raw{index}" for index in range(len(segments))]
        filters.append(
            f"[{input_index}:v]split={len(labels)}"
            + "".join(f"[{label}]" for label in labels)
        )
        segment_inputs = labels
    else:
        segment_inputs = [f"{input_index}:v"]
    segment_labels = []
    for index, ((source_start, source_end, rate), source_label) in enumerate(zip(segments, segment_inputs)):
        output_label = f"{prefix}seg{index}"
        filters.append(
            f"[{source_label}]trim=start={source_start:.6f}:end={source_end:.6f},"
            f"setpts=(PTS-STARTPTS)/{rate:.8f}[{output_label}]"
        )
        segment_labels.append(output_label)
    if len(segment_labels) > 1:
        joined = f"{prefix}joined"
        filters.append(
            "".join(f"[{label}]" for label in segment_labels)
            + f"concat=n={len(segment_labels)}:v=1:a=0[{joined}]"
        )
        working = joined
    else:
        working = segment_labels[0]
    if speed.get("reverse"):
        reversed_label = f"{prefix}reverse"
        filters.append(f"[{working}]reverse[{reversed_label}]")
        working = reversed_label
    if speed.get("freeze"):
        freeze_at = clamp(float(speed.get("freezeAt", 0.0)), 0.0, max(0.0, float(clip.get("sourceEnd", 0.0)) - float(clip.get("sourceStart", 0.0))))
        frozen = f"{prefix}freeze"
        source_time = max(0.0, float(clip.get("sourceStart", 0.0)) + freeze_at)
        filters.append(
            f"[{input_index}:v]trim=start={source_time:.6f}:duration={max(0.034, 1.0 / max(1.0, frame_rate)):.6f},"
            f"setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration={timeline_duration:.6f},"
            f"trim=duration={timeline_duration:.6f}[{frozen}]"
        )
        working = frozen
    else:
        fitted_duration = f"{prefix}duration"
        filters.append(
            f"[{working}]tpad=stop_mode=clone:stop_duration={timeline_duration:.6f},"
            f"trim=duration={timeline_duration:.6f},setpts=PTS-STARTPTS[{fitted_duration}]"
        )
        working = fitted_duration
    if speed.get("opticalFlow"):
        interpolated = f"{prefix}flow"
        filters.append(
            f"[{working}]minterpolate=fps={frame_rate:.6f}:mi_mode=mci:mc_mode=aobmc:"
            f"me_mode=bidir:vsbmc=1[{interpolated}]"
        )
        working = interpolated
    stabilization = dict(clip.get("stabilization") or {})
    if stabilization.get("enabled"):
        stabilized = f"{prefix}stabilized"
        radius = int(clamp(float(stabilization.get("strength", 12)), 1, 64))
        # FFmpeg's deshake filter only accepts search radii in multiples of 16.
        radius = max(16, min(64, ((radius + 15) // 16) * 16))
        filters.append(
            f"[{working}]deshake=rx={radius}:ry={radius}:edge=mirror:search=less[{stabilized}]"
        )
        working = stabilized
    chroma = dict(clip.get("chromaKey") or {})
    if chroma.get("enabled"):
        keyed = f"{prefix}keyed"
        key_color = _ffmpeg_color(chroma.get("color"), "#00FF00")
        similarity = clamp(float(chroma.get("similarity", 0.18)), 0.01, 1.0)
        blend = clamp(float(chroma.get("blend", 0.08)), 0.0, 1.0)
        filters.append(
            f"[{working}]chromakey=color={key_color}:similarity={similarity:.5f}:blend={blend:.5f},"
            f"format=rgba[{keyed}]"
        )
        working = keyed
    fit = str(clip.get("fit") or "cover")
    if fit == "contain":
        layout = (
            f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black@0"
        )
    elif fit == "stretch":
        layout = f"scale={target_w}:{target_h}:flags=lanczos"
    elif fit == "native":
        layout = "null"
    else:
        layout = (
            f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={target_w}:{target_h}"
        )
    transformed = f"{prefix}transformed"
    scale = clamp(float(clip.get("scale", 1.0)), 0.05, 8.0)
    rotation = clamp(float(clip.get("rotation", 0.0)), -360.0, 360.0)
    opacity = clamp(float(clip.get("opacity", 1.0)), 0.0, 1.0)
    visual_filters = [layout] if layout != "null" else []
    if abs(scale - 1.0) > 1e-6:
        visual_filters.append(f"scale=iw*{scale:.6f}:ih*{scale:.6f}:flags=lanczos")
    if abs(rotation) > 1e-6:
        visual_filters.append(
            f"rotate={rotation:.6f}*PI/180:ow=rotw(iw):oh=roth(ih):c=none"
        )
    visual_filters.append("format=rgba")
    if opacity < 0.9999:
        visual_filters.append(f"colorchannelmixer=aa={opacity:.6f}")
    fade_in = clamp(float(clip.get("fadeIn", 0.0)), 0.0, timeline_duration / 2.0)
    fade_out = clamp(float(clip.get("fadeOut", 0.0)), 0.0, timeline_duration / 2.0)
    transition_in = dict(clip.get("transitionIn") or {})
    transition_out = dict(clip.get("transitionOut") or {})
    if transition_in.get("type") != "cut":
        fade_in = max(fade_in, clamp(float(transition_in.get("duration", 0.0)), 0.0, timeline_duration / 2.0))
    if transition_out.get("type") != "cut":
        fade_out = max(fade_out, clamp(float(transition_out.get("duration", 0.0)), 0.0, timeline_duration / 2.0))
    if fade_in > 0.001:
        visual_filters.append(f"fade=t=in:st=0:d={fade_in:.6f}:alpha=1")
    if fade_out > 0.001:
        visual_filters.append(
            f"fade=t=out:st={max(0.0, timeline_duration - fade_out):.6f}:d={fade_out:.6f}:alpha=1"
        )
    visual_filters.append(f"setpts=PTS-STARTPTS+{timeline_start:.6f}/TB")
    filters.append(f"[{working}]{','.join(visual_filters)}[{transformed}]")
    return transformed


def _append_longform_sequence_audio(filters, input_index, clip, *, prefix):
    timeline_start = max(0.0, float(clip.get("timelineStart", 0.0)))
    timeline_end = max(timeline_start + 0.02, float(clip.get("timelineEnd", timeline_start + 0.02)))
    timeline_duration = timeline_end - timeline_start
    speed = dict(clip.get("speed") or {})
    segments = _longform_speed_segments(clip)
    segment_inputs = []
    if len(segments) > 1:
        labels = [f"{prefix}araw{index}" for index in range(len(segments))]
        filters.append(
            f"[{input_index}:a]asplit={len(labels)}"
            + "".join(f"[{label}]" for label in labels)
        )
        segment_inputs = labels
    else:
        segment_inputs = [f"{input_index}:a"]
    segment_labels = []
    for index, ((source_start, source_end, rate), source_label) in enumerate(zip(segments, segment_inputs)):
        output_label = f"{prefix}aseg{index}"
        chain = [
            f"atrim=start={source_start:.6f}:end={source_end:.6f}",
            "asetpts=PTS-STARTPTS",
            "aresample=48000",
        ]
        if speed.get("pitchPreserve", True):
            chain.extend(_longform_atempo_chain(rate))
        elif abs(rate - 1.0) > 1e-6:
            chain.extend([f"asetrate=48000*{rate:.8f}", "aresample=48000"])
        filters.append(f"[{source_label}]{','.join(chain)}[{output_label}]")
        segment_labels.append(output_label)
    if len(segment_labels) > 1:
        joined = f"{prefix}ajoined"
        filters.append(
            "".join(f"[{label}]" for label in segment_labels)
            + f"concat=n={len(segment_labels)}:v=0:a=1[{joined}]"
        )
        working = joined
    else:
        working = segment_labels[0]
    if speed.get("reverse"):
        reversed_label = f"{prefix}areverse"
        filters.append(f"[{working}]areverse[{reversed_label}]")
        working = reversed_label
    volume_db = clamp(float(clip.get("volumeDb", 0.0)), -60.0, 24.0)
    fade_in = clamp(float(clip.get("fadeIn", 0.0)), 0.0, timeline_duration / 2.0)
    fade_out = clamp(float(clip.get("fadeOut", 0.0)), 0.0, timeline_duration / 2.0)
    finish_filters = [
        f"apad=pad_dur={timeline_duration:.6f}",
        f"atrim=duration={timeline_duration:.6f}",
        "asetpts=PTS-STARTPTS",
    ]
    if abs(volume_db) > 0.001:
        finish_filters.append(f"volume={volume_db:.6f}dB")
    if fade_in > 0.001:
        finish_filters.append(f"afade=t=in:st=0:d={fade_in:.6f}")
    if fade_out > 0.001:
        finish_filters.append(
            f"afade=t=out:st={max(0.0, timeline_duration - fade_out):.6f}:d={fade_out:.6f}"
        )
    delay_ms = max(0, int(round(timeline_start * 1000)))
    finish_filters.append(f"adelay={delay_ms}:all=1")
    output = f"{prefix}audio"
    filters.append(f"[{working}]{','.join(finish_filters)}[{output}]")
    return output


def _append_longform_privacy_masks(filters, current_video, clip, *, prefix, target_w, target_h):
    for index, mask in enumerate(clip.get("masks", []) or []):
        if not mask.get("enabled", True):
            continue
        start = max(0.0, float(clip.get("timelineStart", 0.0)))
        end = max(start + 0.02, float(clip.get("timelineEnd", start + 0.02)))
        keyframes = mask.get("keyframes", []) or []
        x_expression = _longform_keyframe_expression(keyframes, "x", mask.get("x", 0.25))
        y_expression = _longform_keyframe_expression(keyframes, "y", mask.get("y", 0.25))
        width = clamp(float(mask.get("width", 0.25)), 0.005, 1.0)
        height = clamp(float(mask.get("height", 0.25)), 0.005, 1.0)
        pixel_w = max(2, int(round(target_w * width)))
        pixel_h = max(2, int(round(target_h * height)))
        enable = f"between(t,{start:.6f},{end:.6f})"
        effect = str(mask.get("effect") or "blur")
        if effect == "color":
            output = f"{prefix}maskcolor{index}"
            fill_color = _ffmpeg_color(mask.get("fillColor"), "#000000")
            filters.append(
                f"[{current_video}]drawbox=x='iw*({x_expression})':y='ih*({y_expression})':"
                f"w={pixel_w}:h={pixel_h}:color={fill_color}@0.92:t=fill:"
                f"enable='{enable}'[{output}]"
            )
            current_video = output
            continue
        base = f"{prefix}maskbase{index}"
        work = f"{prefix}maskwork{index}"
        patch = f"{prefix}maskpatch{index}"
        output = f"{prefix}masked{index}"
        filters.append(f"[{current_video}]split=2[{base}][{work}]")
        crop = (
            f"crop={pixel_w}:{pixel_h}:"
            f"x='clip(iw*({x_expression})\\,0\\,iw-{pixel_w})':"
            f"y='clip(ih*({y_expression})\\,0\\,ih-{pixel_h})'"
        )
        strength = clamp(float(mask.get("strength", 18.0)), 0.0, 100.0)
        if effect == "mosaic":
            small_w = max(2, int(round(pixel_w / max(3.0, strength / 2.0))))
            small_h = max(2, int(round(pixel_h / max(3.0, strength / 2.0))))
            effect_filter = (
                f"scale={small_w}:{small_h}:flags=neighbor,"
                f"scale={pixel_w}:{pixel_h}:flags=neighbor"
            )
        elif effect == "opacity":
            effect_filter = f"colorchannelmixer=aa={clamp(1.0 - strength / 100.0, 0.0, 1.0):.6f}"
        else:
            effect_filter = f"gblur=sigma={clamp(strength, 0.1, 60.0):.6f}:steps=2"
        filters.append(f"[{work}]{crop},{effect_filter}[{patch}]")
        filters.append(
            f"[{base}][{patch}]overlay="
            f"x='W*({x_expression})':y='H*({y_expression})':"
            f"eof_action=pass:enable='{enable}'[{output}]"
        )
        current_video = output
    return current_video


def _longform_title_x(alignment, *, start, end, animation, x=None, width=None, scale=1.0):
    if x is not None and width is not None:
        left = clamp(float(x), 0.0, 0.95)
        box_width = clamp(float(width), 0.12, 1.0)
        inset = 0.016 * clamp(float(scale), 0.4, 2.5)
        if alignment == "right":
            target = f"w*{min(0.995, left + box_width - inset):.6f}-text_w"
            offscreen = "w+40"
        elif alignment == "center":
            target = f"w*{min(1.0, left + box_width / 2.0):.6f}-text_w/2"
            offscreen = "-text_w-40" if left + box_width / 2.0 < 0.5 else "w+40"
        else:
            target = f"w*{min(0.995, left + inset):.6f}"
            offscreen = "-text_w-40"
    elif alignment == "right":
        target = "w*0.92-text_w"
        offscreen = "w+40"
    elif alignment == "center":
        return "(w-text_w)/2"
    else:
        target = "w*0.08"
        offscreen = "-text_w-40"
    if animation != "slide":
        return target
    entry = 0.28
    exit_duration = 0.22
    return (
        f"if(lt(t,{start + entry:.3f}),"
        f"{offscreen}+({target}-({offscreen}))*(t-{start:.3f})/{entry:.3f},"
        f"if(gt(t,{end - exit_duration:.3f}),"
        f"{target}+({offscreen}-({target}))*(t-{end - exit_duration:.3f})/{exit_duration:.3f},"
        f"{target}))"
    )


def _longform_title_alpha(start, end, animation):
    if animation != "fade":
        return None
    fade = min(0.28, max(0.08, (end - start) / 4.0))
    return (
        f"if(lt(t,{start + fade:.3f}),"
        f"max(0,min(1,(t-{start:.3f})/{fade:.3f})),"
        f"if(gt(t,{end - fade:.3f}),"
        f"max(0,min(1,({end:.3f}-t)/{fade:.3f})),1))"
    )


def apply_longform_creative_finish(
    joined_path,
    output_path,
    *,
    creative,
    width,
    height,
    is_hdr,
    backends,
    work_dir,
    normalize_audio=False,
    target_lufs=-14.0,
    limiter_db=-1.5,
    denoise=False,
    segment_files=None,
    segment_durations=None,
    audio_segment_files=None,
):
    """Composite transitions, graphics, cutaways, color, music, and audio."""
    titles = [item for item in creative.get("titles", []) if item.get("text")]
    broll = [item for item in creative.get("broll", []) if item.get("path") and os.path.exists(item.get("path"))]
    transitions = [
        item for item in creative.get("transitions", [])
        if item.get("ffmpegKind") or abs(float(item.get("audioOffsetSec", 0.0))) >= 0.001
    ]
    adjustments = [item for item in creative.get("adjustmentLayers", []) if float(item.get("end", 0.0)) > float(item.get("start", 0.0))]
    captions = dict(creative.get("captions") or {})
    sequence = dict(creative.get("renderSequence") or creative.get("sequence") or {})
    sequence_tracks = list(sequence.get("tracks", []) or []) if sequence.get("enabled") else []
    video_tracks = [
        track for track in sequence_tracks
        if track.get("kind") == "video" and not track.get("hidden")
    ]
    audio_tracks = [
        track for track in sequence_tracks
        if track.get("kind") == "audio" and not track.get("muted")
    ]
    if any(track.get("solo") for track in video_tracks):
        video_tracks = [track for track in video_tracks if track.get("solo")]
    if any(track.get("solo") for track in audio_tracks):
        audio_tracks = [track for track in audio_tracks if track.get("solo")]
    selected_video_track_ids = {str(track.get("id")) for track in video_tracks}
    selected_audio_track_ids = {str(track.get("id")) for track in audio_tracks}
    sequence_entries = []
    for track in sorted(sequence_tracks, key=lambda item: float(item.get("order", 0.0))):
        track_id = str(track.get("id"))
        selected = (
            (track.get("kind") == "video" and track_id in selected_video_track_ids)
            or (track.get("kind") == "audio" and track_id in selected_audio_track_ids)
        )
        if not selected:
            continue
        for clip in track.get("clips", []) or []:
            if not clip.get("enabled", True):
                continue
            clip_copy = dict(clip)
            clip_copy["volumeDb"] = clamp(
                float(clip_copy.get("volumeDb", 0.0)) + float(track.get("volumeDb", 0.0)),
                -60.0,
                24.0,
            )
            sequence_entries.append((track, clip_copy))
    sequence_video_entries = [
        (track, clip) for track, clip in sequence_entries
        if track.get("kind") == "video" and (clip.get("path") or clip.get("sourceType") == "generator")
    ]
    sequence_audio_entries = [
        (track, clip) for track, clip in sequence_entries
        if (
            track.get("kind") == "audio"
            or (track.get("kind") == "video" and clip.get("includeAudio"))
        )
        and clip.get("path")
    ]
    multicam = dict(creative.get("multicam") or {})
    angles_by_id = {
        str(item.get("id")): item
        for item in multicam.get("angles", []) or []
        if item.get("path") and os.path.exists(item.get("path"))
    }
    multicam_cuts = [
        (item, angles_by_id.get(str(item.get("angleId"))))
        for item in multicam.get("cuts", []) or []
        if angles_by_id.get(str(item.get("angleId")))
        and float(item.get("end", 0.0)) > float(item.get("start", 0.0))
    ]
    segment_files = list(segment_files or [])
    segment_durations = [float(value) for value in (segment_durations or [])]
    audio_segment_files = list(audio_segment_files or [])
    uses_transition_graph = bool(
        transitions
        and len(segment_files) > 1
        and len(segment_files) == len(segment_durations)
    )
    uses_separate_audio_segments = bool(
        uses_transition_graph
        and len(audio_segment_files) == len(segment_files)
    )
    music_path = creative.get("musicPath")
    audio_mix = dict(creative.get("audio") or {})
    if audio_mix.get("musicMuted") or (music_path and not os.path.exists(music_path)):
        music_path = None
    target_w, target_h = _longform_export_size(
        creative.get("exportPreset"),
        width,
        height,
        creative.get("delivery"),
    )
    color = dict(creative.get("color") or {})
    color_workflow = dict(creative.get("colorWorkflow") or {})
    delivery_is_hdr = bool(
        is_hdr
        or str((color_workflow.get("management") or {}).get("outputSpace") or "rec709") in {"hdr10", "hlg"}
    )
    color_group_by_clip = {}
    for group in color_workflow.get("groups", []) or []:
        for clip_id in group.get("clipIds", []) or []:
            color_group_by_clip[str(clip_id)] = dict(group.get("grade") or {})
    exposure = clamp(float(color.get("exposure", 0.0)), -0.5, 0.5)
    contrast = clamp(float(color.get("contrast", 1.0)), 0.25, 2.0)
    saturation = clamp(float(color.get("saturation", 1.0)), 0.0, 3.0)
    vibrance = clamp(float(color.get("vibrance", 0.0)), -1.0, 1.0)
    gamma = clamp(float(color.get("gamma", 1.0)), 0.35, 3.0)
    highlights = clamp(float(color.get("highlights", 0.0)), -1.0, 1.0)
    shadows = clamp(float(color.get("shadows", 0.0)), -1.0, 1.0)
    temperature = clamp(float(color.get("temperature", 0.0)), -1.0, 1.0)
    tint = clamp(float(color.get("tint", 0.0)), -1.0, 1.0)
    sharpen = clamp(float(color.get("sharpen", 0.0)), 0.0, 1.5)
    lut_path = color.get("lutPath")
    if lut_path and not os.path.exists(lut_path):
        lut_path = None
    color_active = (
        abs(exposure) > 0.0001
        or abs(contrast - 1.0) > 0.0001
        or abs(saturation - 1.0) > 0.0001
        or abs(vibrance) > 0.0001
        or abs(gamma - 1.0) > 0.0001
        or abs(highlights) > 0.0001
        or abs(shadows) > 0.0001
        or abs(temperature) > 0.0001
        or abs(tint) > 0.0001
        or sharpen > 0.0001
        or bool(lut_path)
        or bool(color_workflow.get("management"))
    )
    audio_mix_active = bool(
        abs(float(audio_mix.get("dialogueGainDb", 0.0))) > 0.001
        or abs(float(audio_mix.get("masterGainDb", 0.0))) > 0.001
        or abs(float(audio_mix.get("pan", 0.0))) > 0.001
        or any(abs(float(audio_mix.get(key, 0.0))) > 0.001 for key in ("eqLowDb", "eqMidDb", "eqHighDb"))
        or audio_mix.get("compressor")
        or audio_mix.get("deEsser")
        or audio_mix.get("noiseGate")
        or audio_mix.get("dialogueMuted")
        or audio_mix.get("keyframes")
        or any(item.get("useAudio") for item, _angle in multicam_cuts)
    )
    needs_video_filter = bool(
        uses_transition_graph
        or titles
        or broll
        or sequence_video_entries
        or sequence.get("mode") == "replace"
        or multicam_cuts
        or adjustments
        or (captions.get("enabled") and captions.get("burnIn") and captions.get("cues"))
        or color_active
        or target_w != width
        or target_h != height
    )
    needs_audio_filter = bool(
        normalize_audio
        or denoise
        or music_path
        or audio_mix_active
        or sequence_audio_entries
        or sequence.get("mode") == "replace"
    )

    if not needs_video_filter and not needs_audio_filter:
        shutil.move(joined_path, output_path)
        return RUNTIME_HARDWARE.get("resolved_video_encoder") or "cpu"

    input_args = []
    next_input_index = 0
    audio_segment_input_base = None
    if uses_transition_graph:
        for segment_file in segment_files:
            input_args.extend(["-i", segment_file])
        next_input_index += len(segment_files)
        if uses_separate_audio_segments:
            audio_segment_input_base = next_input_index
            for audio_segment_file in audio_segment_files:
                input_args.extend(["-i", audio_segment_file])
            next_input_index += len(audio_segment_files)
    else:
        input_args.extend(["-i", joined_path])
        next_input_index = 1
    sequence_inputs = []
    still_extensions = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
    for track, clip in sequence_entries:
        clip_path = clip.get("path")
        if clip_path:
            if os.path.splitext(str(clip_path))[1].lower() in still_extensions:
                input_args.extend(["-loop", "1"])
            input_args.extend(["-i", clip_path])
            sequence_inputs.append((next_input_index, track, clip))
            next_input_index += 1
        elif clip.get("sourceType") == "generator":
            sequence_inputs.append((None, track, clip))
    multicam_inputs = []
    for item, angle in multicam_cuts:
        input_args.extend(["-i", angle["path"]])
        multicam_inputs.append((next_input_index, item, angle))
        next_input_index += 1
    broll_inputs = []
    for item in broll:
        input_args.extend(["-stream_loop", "-1", "-i", item["path"]])
        broll_inputs.append((next_input_index, item))
        next_input_index += 1
    music_input_index = None
    if music_path:
        music_input_index = next_input_index
        input_args.extend(["-stream_loop", "-1", "-i", music_path])
        next_input_index += 1

    font_path = os.path.join(_SCRIPT_DIR, "dashboard", "public", "fonts", "DejaVuSans-Bold.ttf")
    title_files = []
    for index, title in enumerate(titles):
        title_file = os.path.join(work_dir, f"title_{index:03d}.txt")
        with open(title_file, "w", encoding="utf-8") as handle:
            handle.write(str(title.get("text", "")))
        subtitle_file = None
        if str(title.get("subtitle") or "").strip():
            subtitle_file = os.path.join(work_dir, f"title_{index:03d}_subtitle.txt")
            with open(subtitle_file, "w", encoding="utf-8") as handle:
                handle.write(str(title.get("subtitle", "")))
        title_files.append((title_file, subtitle_file))
    caption_file = None
    if captions.get("enabled") and captions.get("burnIn"):
        caption_file = _write_longform_ass(
            os.path.join(work_dir, "captions.ass"),
            captions,
            target_w,
            target_h,
        )

    def build_command(backend):
        filters = []
        if uses_transition_graph:
            for index in range(len(segment_files)):
                filters.append(f"[{index}:v]settb=AVTB,setpts=PTS-STARTPTS[vin{index}]")
                audio_input_index = (
                    audio_segment_input_base + index
                    if audio_segment_input_base is not None
                    else index
                )
                filters.append(
                    f"[{audio_input_index}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                    f"asettb=AVTB,asetpts=PTS-STARTPTS[ain{index}]"
                )
            transition_by_join = {
                int(item["joinIndex"]): item
                for item in transitions
                if 0 <= int(item.get("joinIndex", -1)) < len(segment_files) - 1
            }
            video_source = "vin0"
            audio_source = "ain0"
            elapsed = segment_durations[0]
            for index in range(1, len(segment_files)):
                transition = transition_by_join.get(index - 1)
                next_video = f"vjoin{index}"
                next_audio = f"ajoin{index}"
                if transition is None or not transition.get("ffmpegKind"):
                    filters.append(
                        f"[{video_source}][vin{index}]concat=n=2:v=1:a=0[{next_video}]"
                    )
                else:
                    duration = float(transition["duration"])
                    offset = max(0.01, elapsed - duration)
                    filters.append(
                        f"[{video_source}][vin{index}]xfade=transition={transition['ffmpegKind']}:"
                        f"duration={duration:.3f}:offset={offset:.3f}[{next_video}]"
                    )
                if transition is None or not transition.get("ffmpegKind"):
                    filters.append(
                        f"[{audio_source}][ain{index}]concat=n=2:v=0:a=1[{next_audio}]"
                    )
                    elapsed += segment_durations[index]
                else:
                    duration = float(transition["duration"])
                    filters.append(
                        f"[{audio_source}][ain{index}]acrossfade=d={duration:.3f}:"
                        f"c1=tri:c2=tri[{next_audio}]"
                    )
                    elapsed += segment_durations[index] - duration
                video_source = next_video
                audio_source = next_audio
        else:
            video_source = "0:v"
            audio_source = "0:a"

        current_video = "vbase"
        base_filters = ["setpts=PTS-STARTPTS"]
        if target_w != width or target_h != height:
            delivery = dict(creative.get("delivery") or {})
            if delivery.get("reframe") == "smart_crop":
                base_filters.append(
                    f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase:flags=lanczos"
                )
                base_filters.append(f"crop={target_w}:{target_h}")
            elif delivery.get("reframe") == "stretch":
                base_filters.append(f"scale={target_w}:{target_h}:flags=lanczos")
            else:
                base_filters.append(
                    f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease:flags=lanczos"
                )
                base_filters.append(f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black")
        if sequence.get("mode") == "replace":
            base_filters.append("drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill")
        filters.append(f"[{video_source}]{','.join(base_filters)}[{current_video}]")

        sequence_audio_labels = []
        sequence_input_by_clip = {
            (str(track.get("id")), str(clip.get("id"))): input_index
            for input_index, track, clip in sequence_inputs
        }
        video_sequence_rows = [
            (input_index, track, clip)
            for input_index, track, clip in sequence_inputs
            if track.get("kind") == "video"
        ]
        video_sequence_rows.sort(key=lambda row: (
            float(row[1].get("order", 0.0)),
            float(row[2].get("timelineStart", 0.0)),
        ))
        for index, (input_index, track, clip) in enumerate(video_sequence_rows):
            timeline_start = max(0.0, float(clip.get("timelineStart", 0.0)))
            timeline_end = max(timeline_start + 0.02, float(clip.get("timelineEnd", timeline_start + 0.02)))
            prefix = f"sequence{index}"
            if input_index is None:
                clip_label = f"{prefix}generator"
                generator_color = _ffmpeg_color(clip.get("generatorColor"), "#111827")
                filters.append(
                    f"color=c={generator_color}:s={target_w}x{target_h}:r={float(sequence.get('frameRate', 30.0)):.6f}:"
                    f"d={timeline_end - timeline_start:.6f},"
                    f"setpts=PTS-STARTPTS+{timeline_start:.6f}/TB[{clip_label}]"
                )
            else:
                clip_label = _append_longform_sequence_video(
                    filters,
                    input_index,
                    clip,
                    prefix=prefix,
                    target_w=target_w,
                    target_h=target_h,
                    frame_rate=float(sequence.get("frameRate", 30.0)),
                )
            group_grade = color_group_by_clip.get(str(clip.get("id")))
            if group_grade:
                group_filters = []
                group_lut = group_grade.get("lutPath")
                if group_lut and os.path.exists(group_lut):
                    group_filters.append(f"lut3d=file='{_ffmpeg_filter_path(group_lut)}'")
                group_exposure = clamp(float(group_grade.get("exposure", 0.0)), -0.5, 0.5)
                group_contrast = clamp(float(group_grade.get("contrast", 1.0)), 0.25, 2.0)
                group_saturation = clamp(float(group_grade.get("saturation", 1.0)), 0.0, 3.0)
                group_gamma = clamp(float(group_grade.get("gamma", 1.0)), 0.35, 3.0)
                if (
                    abs(group_exposure) > 0.0001
                    or abs(group_contrast - 1.0) > 0.0001
                    or abs(group_saturation - 1.0) > 0.0001
                    or abs(group_gamma - 1.0) > 0.0001
                ):
                    group_filters.append(
                        f"eq=brightness={group_exposure:.5f}:contrast={group_contrast:.5f}:"
                        f"saturation={group_saturation:.5f}:gamma={group_gamma:.5f}"
                    )
                if group_filters:
                    group_label = f"{prefix}groupgrade"
                    filters.append(f"[{clip_label}]{','.join(group_filters)}[{group_label}]")
                    clip_label = group_label
            next_video = f"vsequence{index}"
            x = clamp(float(clip.get("x", 0.0)), -1.0, 1.0)
            y = clamp(float(clip.get("y", 0.0)), -1.0, 1.0)
            filters.append(
                f"[{current_video}][{clip_label}]overlay="
                f"x='(W-w)/2+{x:.6f}*W*0.5':y='(H-h)/2+{y:.6f}*H*0.5':"
                f"eof_action=pass:enable='between(t,{timeline_start:.6f},{timeline_end:.6f})'"
                f"[{next_video}]"
            )
            current_video = _append_longform_privacy_masks(
                filters,
                next_video,
                clip,
                prefix=prefix,
                target_w=target_w,
                target_h=target_h,
            )

        for index, (track, clip) in enumerate(sequence_audio_entries):
            input_index = sequence_input_by_clip.get((str(track.get("id")), str(clip.get("id"))))
            if input_index is None:
                continue
            sequence_audio_labels.append(_append_longform_sequence_audio(
                filters,
                input_index,
                clip,
                prefix=f"sequenceaudio{index}",
            ))

        for index, (input_index, item, angle) in enumerate(multicam_inputs):
            duration = max(0.05, float(item["end"]) - float(item["start"]))
            source_start = max(
                0.0,
                float(item.get("sourceStart", item["start"])) + float(angle.get("offsetSec", 0.0)),
            )
            angle_label = f"multicam{index}"
            next_video = f"vmulticam{index}"
            filters.append(
                f"[{input_index}:v]trim=start={source_start:.3f}:duration={duration:.3f},"
                f"setpts=PTS-STARTPTS+{float(item['start']):.3f}/TB,"
                f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={target_w}:{target_h}[{angle_label}]"
            )
            filters.append(
                f"[{current_video}][{angle_label}]overlay=0:0:eof_action=pass:"
                f"enable='between(t,{float(item['start']):.3f},{float(item['end']):.3f})'[{next_video}]"
            )
            current_video = next_video

        for index, (input_index, item) in enumerate(broll_inputs):
            duration = max(0.05, float(item["end"]) - float(item["start"]))
            overlay_label = f"broll{index}"
            next_video = f"vb{index}"
            source_offset = max(0.0, float(item.get("sourceOffset", 0.0)))
            crop_left = clamp(float(item.get("cropLeft", 0.0)), 0.0, 0.45)
            crop_top = clamp(float(item.get("cropTop", 0.0)), 0.0, 0.45)
            crop_right = clamp(float(item.get("cropRight", 0.0)), 0.0, 0.45)
            crop_bottom = clamp(float(item.get("cropBottom", 0.0)), 0.0, 0.45)
            crop_width = max(0.1, 1.0 - crop_left - crop_right)
            crop_height = max(0.1, 1.0 - crop_top - crop_bottom)
            layout = str(item.get("layout") or "cover")
            if layout == "contain":
                layout_filters = (
                    f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease:flags=lanczos,"
                    f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2:color=black@0"
                )
            elif layout == "pip":
                layout_filters = (
                    f"scale={max(2, int(target_w * 0.38))}:-2:force_original_aspect_ratio=decrease:flags=lanczos"
                )
            else:
                layout_filters = (
                    f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase:flags=lanczos,"
                    f"crop={target_w}:{target_h}"
                )
            keyframes = item.get("keyframes", []) or []
            x_expression = _longform_keyframe_expression(keyframes, "x", item.get("x", 0.0))
            y_expression = _longform_keyframe_expression(keyframes, "y", item.get("y", 0.0))
            scale_expression = _longform_keyframe_expression(keyframes, "scale", item.get("scale", 1.0))
            rotation_expression = _longform_keyframe_expression(keyframes, "rotation", item.get("rotation", 0.0))
            opacity = clamp(float(item.get("opacity", 1.0)), 0.0, 1.0)
            filters.append(
                f"[{input_index}:v]trim=start={source_offset:.3f}:duration={duration:.3f},"
                f"setpts=PTS-STARTPTS+{float(item['start']):.3f}/TB,"
                f"crop=iw*{crop_width:.6f}:ih*{crop_height:.6f}:iw*{crop_left:.6f}:ih*{crop_top:.6f},"
                f"{layout_filters},"
                f"scale=w='iw*({scale_expression})':h='ih*({scale_expression})':eval=frame,"
                f"rotate=angle='({rotation_expression})*PI/180':ow=rotw(iw):oh=roth(ih):c=none,"
                f"format=rgba,colorchannelmixer=aa={opacity:.4f}[{overlay_label}]"
            )
            filters.append(
                f"[{current_video}][{overlay_label}]overlay="
                f"x='(W-w)/2+({x_expression})*W*0.5':"
                f"y='(H-h)/2+({y_expression})*H*0.5':eof_action=pass:"
                f"enable='between(t,{float(item['start']):.3f},{float(item['end']):.3f})'[{next_video}]"
            )
            current_video = next_video

        grade_filters = []
        management = dict(color_workflow.get("management") or {})
        input_space = str(management.get("inputSpace") or "auto")
        output_space = str(management.get("outputSpace") or "rec709")
        tone_map = str(management.get("toneMap") or "mobius")
        peak_nits = clamp(float(management.get("peakNits", 1000.0)), 100.0, 10000.0)
        if input_space in {"hlg", "pq"} and output_space == "rec709":
            transfer_in = "arib-std-b67" if input_space == "hlg" else "smpte2084"
            tonemap_name = tone_map if tone_map in {"hable", "mobius", "reinhard"} else "mobius"
            grade_filters.extend([
                f"zscale=transferin={transfer_in}:primariesin=bt2020:matrixin=bt2020nc:"
                f"transfer=linear:npl={peak_nits:.3f}",
                "format=gbrpf32le",
                f"tonemap=tonemap={tonemap_name}:desat=0",
                "zscale=transfer=bt709:primaries=bt709:matrix=bt709:range=tv",
                "format=yuv420p",
            ])
        if lut_path:
            grade_filters.append(f"lut3d=file='{_ffmpeg_filter_path(lut_path)}'")
        if (
            abs(exposure) > 0.0001
            or abs(contrast - 1.0) > 0.0001
            or abs(saturation - 1.0) > 0.0001
            or abs(gamma - 1.0) > 0.0001
        ):
            grade_filters.append(
                f"eq=brightness={exposure:.4f}:contrast={contrast:.4f}:"
                f"saturation={saturation:.4f}:gamma={gamma:.4f}"
            )
        if abs(vibrance) > 0.0001:
            grade_filters.append(f"vibrance=intensity={vibrance:.4f}")
        if abs(shadows) > 0.0001 or abs(highlights) > 0.0001:
            black = clamp(max(0.0, shadows) * 0.035, 0.0, 0.12)
            quarter = clamp(0.25 + shadows * 0.12, 0.02, 0.48)
            three_quarter = clamp(0.75 + highlights * 0.12, 0.52, 0.98)
            white = clamp(1.0 + min(0.0, highlights) * 0.04, 0.88, 1.0)
            grade_filters.append(
                f"curves=all='0/{black:.5f} 0.25/{quarter:.5f} "
                f"0.75/{three_quarter:.5f} 1/{white:.5f}'"
            )
        if abs(temperature) > 0.0001:
            warmth = temperature * 0.16
            grade_filters.append(
                f"colorbalance=rm={warmth:.4f}:bm={-warmth:.4f}:"
                f"rh={warmth * 0.55:.4f}:bh={-warmth * 0.55:.4f}:pl=1"
            )
        if abs(tint) > 0.0001:
            green_shift = tint * 0.12
            grade_filters.append(
                f"colorbalance=gm={green_shift:.4f}:gh={green_shift * 0.55:.4f}:pl=1"
            )
        if sharpen > 0.0001:
            grade_filters.append(f"unsharp=5:5:{sharpen:.3f}:5:5:0")
        if output_space in {"hdr10", "hlg"} and input_space not in {"hlg", "pq"}:
            transfer_out = "smpte2084" if output_space == "hdr10" else "arib-std-b67"
            grade_filters.extend([
                "zscale=transfer=linear:transferin=bt709:primariesin=bt709:matrixin=bt709",
                "format=gbrpf32le",
                f"zscale=transfer={transfer_out}:primaries=bt2020:matrix=bt2020nc",
                "format=yuv420p10le",
            ])
        if management.get("legalize"):
            grade_filters.append("limiter=min=16:max=235")
        if grade_filters:
            filters.append(f"[{current_video}]{','.join(grade_filters)}[vgraded]")
            current_video = "vgraded"

        for index, layer in enumerate(adjustments):
            start = float(layer["start"])
            end = float(layer["end"])
            enable = f"between(t,{start:.3f},{end:.3f})"
            layer_filters = []
            layer_exposure = clamp(float(layer.get("exposure", 0.0)), -0.3, 0.3)
            layer_contrast = clamp(float(layer.get("contrast", 1.0)), 0.5, 1.5)
            layer_saturation = clamp(float(layer.get("saturation", 1.0)), 0.0, 2.0)
            if (
                abs(layer_exposure) > 0.0001
                or abs(layer_contrast - 1.0) > 0.0001
                or abs(layer_saturation - 1.0) > 0.0001
            ):
                layer_filters.append(
                    f"eq=brightness={layer_exposure:.4f}:contrast={layer_contrast:.4f}:"
                    f"saturation={layer_saturation:.4f}:enable='{enable}'"
                )
            layer_temperature = clamp(float(layer.get("temperature", 0.0)), -1.0, 1.0)
            if abs(layer_temperature) > 0.0001:
                warmth = layer_temperature * 0.16
                layer_filters.append(
                    f"colorbalance=rm={warmth:.4f}:bm={-warmth:.4f}:"
                    f"rh={warmth * 0.55:.4f}:bh={-warmth * 0.55:.4f}:pl=1:"
                    f"enable='{enable}'"
                )
            layer_tint = clamp(float(layer.get("tint", 0.0)), -1.0, 1.0)
            if abs(layer_tint) > 0.0001:
                green_shift = layer_tint * 0.12
                layer_filters.append(
                    f"colorbalance=gm={green_shift:.4f}:gh={green_shift * 0.55:.4f}:pl=1:"
                    f"enable='{enable}'"
                )
            layer_sharpen = clamp(float(layer.get("sharpen", 0.0)), 0.0, 1.5)
            if layer_sharpen > 0.0001:
                layer_filters.append(f"unsharp=5:5:{layer_sharpen:.3f}:5:5:0:enable='{enable}'")
            layer_blur = clamp(float(layer.get("blur", 0.0)), 0.0, 20.0)
            if layer_blur > 0.0001:
                layer_filters.append(f"gblur=sigma={layer_blur:.3f}:enable='{enable}'")
            layer_vignette = clamp(float(layer.get("vignette", 0.0)), 0.0, 1.0)
            if layer_vignette > 0.0001:
                layer_filters.append(f"vignette=angle={layer_vignette * 0.65:.4f}:enable='{enable}'")
            layer_grain = clamp(float(layer.get("grain", 0.0)), 0.0, 50.0)
            if layer_grain > 0.0001:
                layer_filters.append(f"noise=alls={layer_grain:.3f}:allf=t+u:enable='{enable}'")
            if layer_filters:
                output_label = f"vadjustment{index}"
                filters.append(f"[{current_video}]{','.join(layer_filters)}[{output_label}]")
                current_video = output_label

        for index, (title, title_paths) in enumerate(zip(titles, title_files)):
            title_file, subtitle_file = title_paths
            start = float(title["start"])
            end = float(title["end"])
            style = str(title.get("style") or "lower_third")
            template = str(title.get("template") or "broadcast")
            alignment = str(title.get("alignment") or "left")
            animation = str(title.get("animation") or "slide")
            accent = _ffmpeg_color(title.get("accentColor"), "#8B5CF6")
            background = _ffmpeg_color(title.get("backgroundColor"), "#09090B")
            text_color = _ffmpeg_color(title.get("textColor"), "#FFFFFF")
            if style == "center_card":
                transform_defaults = {"x": 0.1, "y": 0.32, "width": 0.8}
            elif template == "glass":
                transform_defaults = {"x": 0.045, "y": 0.70, "width": 0.91}
            elif template == "minimal":
                transform_defaults = {
                    "x": 0.54 if alignment == "right" else 0.28 if alignment == "center" else 0.08,
                    "y": 0.73,
                    "width": 0.38,
                }
            else:
                transform_defaults = {
                    "x": 0.385 if alignment == "right" else 0.22 if alignment == "center" else 0.055,
                    "y": 0.69,
                    "width": 0.56,
                }
            title_x = clamp(float(title.get("x", transform_defaults["x"])), 0.0, 0.95)
            title_y = clamp(float(title.get("y", transform_defaults["y"])), 0.0, 0.95)
            title_width = clamp(float(title.get("width", transform_defaults["width"])), 0.12, 1.0)
            title_scale = clamp(float(title.get("scale", 1.0)), 0.4, 2.5)
            enable = f"between(t,{start:.3f},{end:.3f})"
            alpha = _longform_title_alpha(start, end, animation)
            alpha_option = f":alpha='{alpha}'" if alpha else ""
            x_value = _longform_title_x(
                alignment,
                start=start,
                end=end,
                animation=animation,
                x=title_x,
                width=title_width,
                scale=title_scale,
            )

            if style == "center_card":
                boxed_video = f"vtitlebox{index}"
                filters.append(
                    f"[{current_video}]drawbox=x=iw*{title_x:.6f}:y=ih*{title_y:.6f}:"
                    f"w=iw*{title_width:.6f}:h=ih*{0.34 * title_scale:.6f}:"
                    f"color={background}@0.76:t=fill:"
                    f"enable='{enable}'[{boxed_video}]"
                )
                accented_video = f"vtitleaccent{index}"
                filters.append(
                    f"[{boxed_video}]drawbox=x=iw*{title_x + title_width * 0.39:.6f}:"
                    f"y=ih*{title_y + 0.28 * title_scale:.6f}:"
                    f"w=iw*{title_width * 0.22:.6f}:h=max(4\\,ih*{0.006 * title_scale:.6f}):"
                    f"color={accent}@0.95:t=fill:enable='{enable}'[{accented_video}]"
                )
                current_video = accented_video
                y_value = f"h*{title_y + 0.065 * title_scale:.6f}"
                subtitle_y = f"h*{title_y + 0.195 * title_scale:.6f}"
                font_size = f"h*{(1.0 / 14.0) * title_scale:.6f}"
                subtitle_size = f"h*{(1.0 / 30.0) * title_scale:.6f}"
            else:
                box_x = f"iw*{title_x:.6f}"
                box_y = f"ih*{title_y:.6f}"
                box_width = f"iw*{title_width:.6f}"
                if template == "broadcast":
                    boxed_video = f"vtitlebox{index}"
                    filters.append(
                        f"[{current_video}]drawbox=x={box_x}:y={box_y}:w={box_width}:"
                        f"h=ih*{0.19 * title_scale:.6f}:"
                        f"color={background}@0.88:t=fill:enable='{enable}'[{boxed_video}]"
                    )
                    accented_video = f"vtitleaccent{index}"
                    filters.append(
                        f"[{boxed_video}]drawbox=x={box_x}:y={box_y}:"
                        f"w=max(5\\,iw*{0.008 * title_scale:.6f}):h=ih*{0.19 * title_scale:.6f}:"
                        f"color={accent}@0.98:t=fill:enable='{enable}'[{accented_video}]"
                    )
                    current_video = accented_video
                    y_value = f"h*{title_y + 0.035 * title_scale:.6f}"
                    subtitle_y = f"h*{title_y + 0.12 * title_scale:.6f}"
                elif template == "glass":
                    boxed_video = f"vtitlebox{index}"
                    filters.append(
                        f"[{current_video}]drawbox=x={box_x}:y={box_y}:w={box_width}:"
                        f"h=ih*{0.17 * title_scale:.6f}:"
                        f"color={background}@0.62:t=fill:enable='{enable}'[{boxed_video}]"
                    )
                    accented_video = f"vtitleaccent{index}"
                    filters.append(
                        f"[{boxed_video}]drawbox=x={box_x}:y={box_y}:w={box_width}:"
                        f"h=max(4\\,ih*{0.006 * title_scale:.6f}):"
                        f"color={accent}@0.95:t=fill:enable='{enable}'[{accented_video}]"
                    )
                    current_video = accented_video
                    y_value = f"h*{title_y + 0.03 * title_scale:.6f}"
                    subtitle_y = f"h*{title_y + 0.11 * title_scale:.6f}"
                else:
                    accented_video = f"vtitleaccent{index}"
                    filters.append(
                        f"[{current_video}]drawbox=x={box_x}:"
                        f"y=ih*{title_y + 0.145 * title_scale:.6f}:w={box_width}:"
                        f"h=max(4\\,ih*{0.006 * title_scale:.6f}):"
                        f"color={accent}@0.98:t=fill:enable='{enable}'[{accented_video}]"
                    )
                    current_video = accented_video
                    y_value = f"h*{title_y + 0.02 * title_scale:.6f}"
                    subtitle_y = f"h*{title_y + 0.095 * title_scale:.6f}"
                font_size = f"h*{(1.0 / 22.0) * title_scale:.6f}"
                subtitle_size = f"h*{(1.0 / 34.0) * title_scale:.6f}"

            next_video = f"vtitle{index}"
            filters.append(
                f"[{current_video}]drawtext=fontfile='{_ffmpeg_filter_path(font_path)}':"
                f"textfile='{_ffmpeg_filter_path(title_file)}':fontcolor={text_color}:fontsize={font_size}:"
                f"x='{x_value}':y={y_value}:borderw=1:bordercolor=black@0.55:"
                f"shadowcolor=black@0.80:shadowx=2:shadowy=2:fix_bounds=1{alpha_option}:"
                f"enable='{enable}'[{next_video}]"
            )
            current_video = next_video
            if subtitle_file:
                subtitle_x = _longform_title_x(
                    alignment,
                    start=start,
                    end=end,
                    animation=animation,
                    x=title_x,
                    width=title_width,
                    scale=title_scale,
                )
                subtitle_video = f"vsubtitle{index}"
                filters.append(
                    f"[{current_video}]drawtext=fontfile='{_ffmpeg_filter_path(font_path)}':"
                    f"textfile='{_ffmpeg_filter_path(subtitle_file)}':fontcolor={text_color}@0.84:"
                    f"fontsize={subtitle_size}:x='{subtitle_x}':y={subtitle_y}:"
                    f"shadowcolor=black@0.75:shadowx=2:shadowy=2:fix_bounds=1{alpha_option}:"
                    f"enable='{enable}'[{subtitle_video}]"
                )
                current_video = subtitle_video

        if caption_file:
            filters.append(
                f"[{current_video}]subtitles=filename='{_ffmpeg_filter_path(caption_file)}':"
                f"fontsdir='{_ffmpeg_filter_path(os.path.dirname(font_path))}'[vcaptions]"
            )
            current_video = "vcaptions"

        video_output = current_video
        vaapi_tail = encoder_filter(None, backend, delivery_is_hdr)
        if vaapi_tail:
            filters.append(f"[{current_video}]{vaapi_tail}[vout]")
            video_output = "vout"

        audio_output = None
        working_audio = audio_source
        if sequence.get("mode") == "replace":
            filters.append(f"[{working_audio}]volume=0[programreplaced]")
            working_audio = "programreplaced"
        angle_audio_labels = []
        angle_audio_ranges = []
        for index, (input_index, item, angle) in enumerate(multicam_inputs):
            if not item.get("useAudio"):
                continue
            duration = max(0.05, float(item["end"]) - float(item["start"]))
            source_start = max(
                0.0,
                float(item.get("sourceStart", item["start"])) + float(angle.get("offsetSec", 0.0)),
            )
            label = f"multicamaudio{index}"
            delay_ms = max(0, int(round(float(item["start"]) * 1000)))
            filters.append(
                f"[{input_index}:a]atrim=start={source_start:.3f}:duration={duration:.3f},"
                f"asetpts=PTS-STARTPTS,adelay={delay_ms}|{delay_ms}[{label}]"
            )
            angle_audio_labels.append(label)
            angle_audio_ranges.append((float(item["start"]), float(item["end"])))
        if angle_audio_labels:
            for index, (start, end) in enumerate(angle_audio_ranges):
                muted = f"programmuted{index}"
                filters.append(
                    f"[{working_audio}]volume=0:enable='between(t,{start:.3f},{end:.3f})'[{muted}]"
                )
                working_audio = muted
            angle_inputs = "".join(f"[{label}]" for label in angle_audio_labels)
            filters.append(
                f"[{working_audio}]{angle_inputs}amix=inputs={len(angle_audio_labels) + 1}:"
                f"duration=first:normalize=0[programangles]"
            )
            working_audio = "programangles"

        dialogue_filters = []
        if denoise:
            dialogue_filters.append("afftdn=nf=-25")
        if audio_mix.get("dialogueMuted"):
            dialogue_filters.append("volume=0")
        else:
            dialogue_gain = clamp(float(audio_mix.get("dialogueGainDb", 0.0)), -60.0, 18.0)
            if abs(dialogue_gain) > 0.001:
                dialogue_filters.append(f"volume={dialogue_gain:.3f}dB")
            audio_keyframes = audio_mix.get("keyframes", []) or []
            if audio_keyframes:
                gain_expression = _longform_keyframe_expression(audio_keyframes, "gainDb", 0.0)
                dialogue_filters.append(
                    f"volume='pow(10,({gain_expression})/20)':eval=frame"
                )
        pan = clamp(float(audio_mix.get("pan", 0.0)), -1.0, 1.0)
        if abs(pan) > 0.001:
            left_gain = 1.0 - max(0.0, pan)
            right_gain = 1.0 + min(0.0, pan)
            dialogue_filters.append(
                f"pan=stereo|c0={left_gain:.5f}*c0|c1={right_gain:.5f}*c1"
            )
        for frequency, key in ((120, "eqLowDb"), (1000, "eqMidDb"), (8000, "eqHighDb")):
            gain = clamp(float(audio_mix.get(key, 0.0)), -18.0, 18.0)
            if abs(gain) > 0.001:
                dialogue_filters.append(f"equalizer=f={frequency}:t=q:w=1:g={gain:.3f}")
        if audio_mix.get("noiseGate"):
            dialogue_filters.append("agate=threshold=0.03:ratio=3:attack=8:release=180")
        if audio_mix.get("deEsser"):
            dialogue_filters.append("deesser=i=0.35:m=0.55:f=0.55")
        if audio_mix.get("compressor"):
            dialogue_filters.append("acompressor=threshold=0.125:ratio=3:attack=20:release=250:makeup=1.4")
        if dialogue_filters or music_input_index is not None or angle_audio_labels or sequence_audio_labels:
            filters.append(
                f"[{working_audio}]{','.join(dialogue_filters) if dialogue_filters else 'anull'}[program]"
            )
            working_audio = "program"
            audio_output = working_audio
        elif uses_transition_graph:
            audio_output = working_audio
        if sequence_audio_labels:
            sequence_inputs_graph = "".join(f"[{label}]" for label in sequence_audio_labels)
            filters.append(
                f"[{working_audio}]{sequence_inputs_graph}amix=inputs={len(sequence_audio_labels) + 1}:"
                f"duration=longest:normalize=0[programsequence]"
            )
            working_audio = "programsequence"
            audio_output = working_audio
        if music_input_index is not None:
            volume = clamp(float(creative.get("musicVolume", 0.14)), 0.02, 0.5)
            filters.append(f"[{music_input_index}:a]volume={volume:.3f},asetpts=PTS-STARTPTS[music]")
            if creative.get("musicDucking", True):
                filters.append(f"[{working_audio}]asplit=2[program_mix][voice_key]")
                filters.append("[music][voice_key]sidechaincompress=threshold=0.025:ratio=10:attack=20:release=550[ducked]")
                music_label = "ducked"
                program_label = "program_mix"
            else:
                music_label = "music"
                program_label = working_audio
            filters.append(f"[{program_label}][{music_label}]amix=inputs=2:duration=first:dropout_transition=2[aout]")
            audio_output = "aout"
            working_audio = "aout"

        master_filters = []
        master_gain = clamp(float(audio_mix.get("masterGainDb", 0.0)), -60.0, 18.0)
        if abs(master_gain) > 0.001:
            master_filters.append(f"volume={master_gain:.3f}dB")
        if normalize_audio:
            master_filters.append(f"loudnorm=I={float(target_lufs):.2f}:TP={float(limiter_db):.2f}:LRA=11")
            limiter_linear = max(0.01, min(0.99, 10 ** (float(limiter_db) / 20.0)))
            master_filters.append(f"alimiter=limit={limiter_linear:.5f}:attack=5:release=50")
        if master_filters:
            filters.append(f"[{working_audio}]{','.join(master_filters)}[amaster]")
            audio_output = "amaster"

        command = [
            *build_encoder_command_prefix(backend),
            "-y", "-nostdin", "-v", "error",
            *input_args,
            "-filter_complex", ";".join(filters),
            "-map", f"[{video_output}]",
        ]
        if audio_output:
            command.extend(["-map", f"[{audio_output}]"])
        else:
            command.extend(["-map", "0:a?"])
        command.extend(encoder_args(backend, delivery_is_hdr, "longform"))
        command.extend(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", output_path])
        return command

    backend, _ = run_with_encoder_fallback(
        build_command,
        backends,
        context="Long-form finishing",
    )
    RUNTIME_HARDWARE["resolved_video_encoder"] = backend
    return backend

def render_longform(
    source_path,
    segments,
    output_path,
    is_hdr,
    width,
    height,
    do_upscale,
    audio_fade_sec=0.03,
    video_fade_sec=0.0,
    normalize_audio=False,
    target_lufs=-14.0,
    limiter_db=-1.5,
    denoise=False,
    creative=None,
):
    print(f"🎬 Rendering Long Form Master: {output_path}")

    backends, tgt_w, tgt_h = get_render_settings(is_hdr, width, height, do_upscale)

    valid_segments = [
        (float(start), float(end))
        for start, end in segments
        if float(end) - float(start) > 0.01
    ]
    if not valid_segments:
        raise RuntimeError("No longform segments were extracted after silence trimming")
    transition_plan = _normalize_longform_transitions(creative or {}, valid_segments)
    creative_timeline = _longform_creative_timeline(
        creative or {},
        valid_segments,
        transition_plan,
    )
    transition_joins = {int(item["joinIndex"]) for item in transition_plan}
    audio_boundary_offsets = [0.0] * max(0, len(valid_segments) - 1)
    for transition in transition_plan:
        join_index = int(transition.get("joinIndex", -1))
        if 0 <= join_index < len(audio_boundary_offsets):
            audio_boundary_offsets[join_index] = float(transition.get("audioOffsetSec", 0.0))
    uses_audio_offsets = any(abs(value) >= 0.001 for value in audio_boundary_offsets)
    if not do_upscale:
        tgt_w, tgt_h = _longform_export_size(
            creative_timeline.get("exportPreset"),
            tgt_w,
            tgt_h,
            creative_timeline.get("delivery"),
        )

    # Each extraction is re-encoded with a tiny boundary fade. The first frame of
    # the master and the last frame of the master are left untouched; only edit
    # joins are softened. Matching audio/video fades preserve A/V duration and
    # avoid the rough visual jump and audio click of a raw stream concat.
    work_dir = tempfile.mkdtemp(prefix="longform_", dir=TEMP_DIR)
    segment_files = []
    audio_segment_files = []
    try:
        print("  > Extracting segments (High Quality)...")
        if audio_fade_sec > 0 or video_fade_sec > 0:
            print(
                "  > Softening joins:"
                f" audio={int(audio_fade_sec * 1000)}ms,"
                f" video={int(video_fade_sec * 1000)}ms"
            )
        if transition_plan:
            print(f"  > Professional transitions: {len(transition_plan)} join(s)")
        if uses_audio_offsets:
            print("  > J/L audio edits: shifted audio boundaries enabled")

        for i, (start, end) in enumerate(valid_segments):
            duration = max(end - start, 0.0)
            seg_file = os.path.join(work_dir, f"segment_{i:04d}.mp4")

            vf_chain = []
            if tgt_w != width or tgt_h != height:
                vf_chain.append(f"scale={tgt_w}:{tgt_h}:flags=lanczos")
            if is_hdr and vf_chain:
                vf_chain.append("format=p010le")

            video_fade = min(video_fade_sec, max((duration / 2.0) - 0.005, 0.0))
            if video_fade > 0 and i > 0 and (i - 1) not in transition_joins:
                vf_chain.append(f"fade=t=in:st=0:d={video_fade:.3f}:color=black")
            if video_fade > 0 and i < len(valid_segments) - 1 and i not in transition_joins:
                fade_out_start = max(duration - video_fade, 0.0)
                vf_chain.append(
                    f"fade=t=out:st={fade_out_start:.3f}:d={video_fade:.3f}:color=black"
                )

            af_chain = []
            audio_fade = min(audio_fade_sec, max((duration / 2.0) - 0.005, 0.0))
            if audio_fade > 0 and i > 0 and (i - 1) not in transition_joins:
                af_chain.append(f"afade=t=in:st=0:d={audio_fade:.3f}:curve=qsin")
            if audio_fade > 0 and i < len(valid_segments) - 1 and i not in transition_joins:
                fade_out_start = max(duration - audio_fade, 0.0)
                af_chain.append(
                    f"afade=t=out:st={fade_out_start:.3f}:d={audio_fade:.3f}:curve=qsin"
                )

            base_vf = ",".join(vf_chain) if vf_chain else None
            af_flag = ["-af", ",".join(af_chain)] if af_chain else []

            def build_command(backend):
                vf_value = encoder_filter(base_vf, backend, is_hdr)
                vf_flag = ["-vf", vf_value] if vf_value else []
                return [
                    *build_encoder_command_prefix(backend),
                    "-y", "-v", "error",
                    "-ss", str(start), "-t", str(duration),
                    "-i", source_path,
                    *vf_flag,
                    *af_flag,
                    *encoder_args(backend, is_hdr, "longform"),
                    "-c:a", "aac", "-b:a", "192k",
                    seg_file,
                ]

            backend, _ = run_with_encoder_fallback(
                build_command,
                backends,
                context=f"Long-form segment {i + 1}",
            )
            RUNTIME_HARDWARE["resolved_video_encoder"] = backend
            segment_files.append(seg_file)

            if uses_audio_offsets:
                audio_start = start + (audio_boundary_offsets[i - 1] if i > 0 else 0.0)
                audio_end = end + (audio_boundary_offsets[i] if i < len(audio_boundary_offsets) else 0.0)
                audio_start = max(0.0, audio_start)
                audio_end = max(audio_start + 0.01, audio_end)
                audio_file = os.path.join(work_dir, f"audio_{i:04d}.wav")
                subprocess.run([
                    RUNTIME_HARDWARE["ffmpeg_bin"], "-y", "-nostdin", "-v", "error",
                    "-ss", str(audio_start), "-t", str(audio_end - audio_start),
                    "-i", source_path,
                    "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le",
                    audio_file,
                ], check=True, stdin=subprocess.DEVNULL)
                audio_segment_files.append(audio_file)

        print("  > Stitching Master File...")
        list_path = os.path.join(work_dir, "segments.txt")
        with open(list_path, "w", encoding="utf-8") as handle:
            for segment_file in segment_files:
                escaped = segment_file.replace("'", "'\\''")
                handle.write(f"file '{escaped}'\n")

        joined_path = os.path.join(work_dir, "joined.mp4")
        subprocess.run([
            RUNTIME_HARDWARE["ffmpeg_bin"], "-y", "-nostdin", "-v", "error",
            "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c", "copy",
            joined_path,
        ], check=True, stdin=subprocess.DEVNULL)

        if normalize_audio or denoise or creative_timeline.get("musicPath"):
            print(
                "  > Audio finishing:"
                f" denoise={'on' if denoise else 'off'},"
                f" loudness={f'{float(target_lufs):.1f} LUFS' if normalize_audio else 'unchanged'},"
                f" music={'on' if creative_timeline.get('musicPath') else 'off'}"
            )
        return apply_longform_creative_finish(
            joined_path,
            output_path,
            creative=creative_timeline,
            width=tgt_w,
            height=tgt_h,
            is_hdr=is_hdr,
            backends=backends,
            work_dir=work_dir,
            normalize_audio=normalize_audio,
            target_lufs=target_lufs,
            limiter_db=limiter_db,
            denoise=denoise,
            segment_files=segment_files if transition_plan else None,
            segment_durations=[
                end - start for start, end in valid_segments
            ] if transition_plan else None,
            audio_segment_files=audio_segment_files if uses_audio_offsets else None,
        )
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

def persist_source_video(video_path):
    """Store a stable source reference for future rerenders/bakes."""
    abs_source = os.path.abspath(video_path)

    if abs_source.startswith(os.path.abspath(SOURCES_DIR) + os.sep):
        return abs_source

    stat = os.stat(abs_source)
    base_name = os.path.basename(abs_source)
    stem, ext = os.path.splitext(base_name)
    safe_stem = re.sub(r'[^A-Za-z0-9._-]+', '_', stem)[:80] or "source"
    stable_name = f"{safe_stem}_{stat.st_mtime_ns}_{stat.st_size}{ext or '.mp4'}"
    stable_path = os.path.join(SOURCES_DIR, stable_name)

    if os.path.exists(stable_path):
        return stable_path

    try:
        os.link(abs_source, stable_path)
    except OSError:
        shutil.copy2(abs_source, stable_path)

    return stable_path


def _json_safe(value):
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float) and not np.isfinite(value):
        return None
    return value


def candidate_for_manifest(clip):
    fields = (
        "id", "yield_id", "start", "end", "text", "context_before", "context_after", "words", "score", "candidate_score",
        "reasons", "score_breakdown", "ranking_version", "topics", "intelligence_providers",
        "confidence_tier", "yield_tier", "yield_role", "yield_rank", "yield_plan",
        "cluster_id", "story_cluster_id", "variant_rank", "duplicate_of", "boundary_quality",
    )
    return _json_safe({key: clip.get(key) for key in fields if key in clip})


def write_candidate_manifest(source_path, analysis_result, args):
    selected = list(analysis_result.get("selected", []))
    reserves = list(analysis_result.get("reserves", []))
    candidate_by_id = {}
    for clip in [*selected, *reserves, *analysis_result.get("ranked_candidates", [])]:
        if confidence_tier(clip.get("score")) is None:
            continue
        candidate_id = str(clip.get("yield_id") or clip.get("id") or "").strip()
        if not candidate_id:
            candidate_id = f"candidate-{len(candidate_by_id):04d}"
            clip["yield_id"] = candidate_id
        if candidate_id not in candidate_by_id:
            candidate_by_id[candidate_id] = candidate_for_manifest(clip)

    source_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", os.path.splitext(os.path.basename(source_path))[0])[:80]
    manifest_path = os.path.join(
        CANDIDATE_MANIFESTS_DIR,
        f"{source_stem}_{int(time.time() * 1000)}.json",
    )
    payload = {
        "manifest_version": 2,
        "kind": "shorts_candidate_manifest",
        "status": "awaiting_review" if args.mode == "shorts-analyze" else "rendering",
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": os.path.abspath(source_path),
        "yield": analysis_result.get("yield", {}),
        "settings": {
            "subtitle_style": args.subtitle_style,
            "framing_mode": args.framing_mode,
            "upscale": bool(args.upscale),
            "export_preset": args.export_preset,
            "output_name_template": args.output_name_template,
            "video_encoder": args.video_encoder,
            "compute_device": args.compute_device,
            "vaapi_device": args.vaapi_device,
            "transcription_provider": RUNTIME_HARDWARE.get("resolved_transcription_provider"),
            "transcription_model": RUNTIME_HARDWARE.get("transcription_model") or CONFIG["transcription"]["model_size"],
            "transcription_language": RUNTIME_HARDWARE.get("transcription_language", "auto"),
        },
        "selected_candidate_ids": [str(clip.get("yield_id") or clip.get("id")) for clip in selected],
        "reserve_candidate_ids": [str(clip.get("yield_id") or clip.get("id")) for clip in reserves],
        "exported_candidate_ids": [],
        "failed_candidate_ids": [],
        "feedback": {},
        "candidates": list(candidate_by_id.values()),
    }
    temporary_path = f"{manifest_path}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as handle:
        json.dump(_json_safe(payload), handle, indent=2)
    os.replace(temporary_path, manifest_path)
    for clip in [*selected, *reserves]:
        clip["candidate_manifest"] = manifest_path
    return manifest_path


def update_candidate_manifest(manifest_path, *, exported_id=None, failed_id=None):
    try:
        with open(manifest_path, encoding="utf-8") as handle:
            payload = json.load(handle)
        if exported_id:
            exported = payload.setdefault("exported_candidate_ids", [])
            if exported_id not in exported:
                exported.append(exported_id)
        if failed_id:
            failed = payload.setdefault("failed_candidate_ids", [])
            if failed_id not in failed:
                failed.append(failed_id)
        selected = {str(value) for value in payload.get("selected_candidate_ids", [])}
        exported_set = {str(value) for value in payload.get("exported_candidate_ids", [])}
        failed_set = {str(value) for value in payload.get("failed_candidate_ids", [])}
        if selected and selected.issubset(exported_set | failed_set):
            payload["status"] = "rendered" if selected.issubset(exported_set) else "rendered_with_errors"
        elif exported_set:
            payload["status"] = "rendering"
        temporary_path = f"{manifest_path}.tmp"
        with open(temporary_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
        os.replace(temporary_path, manifest_path)
    except (OSError, ValueError) as error:
        print(f"  ⚠️  Could not update candidate manifest: {error}")


def render_more_from_candidate_manifest(manifest_path, requested_count, args, candidate_ids=None):
    manifest_path = os.path.abspath(manifest_path)
    allowed_root = os.path.abspath(CANDIDATE_MANIFESTS_DIR) + os.sep
    if not manifest_path.startswith(allowed_root):
        raise ValueError("Candidate manifest must be inside the managed manifest directory")
    with open(manifest_path, encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("kind") != "shorts_candidate_manifest":
        raise ValueError("The selected file is not a Shorts candidate manifest")

    source_path = os.path.abspath(str(manifest.get("source") or ""))
    if not source_path or not os.path.exists(source_path):
        raise FileNotFoundError(f"Candidate source video not found: {source_path}")
    requested_count = max(1, min(50, int(requested_count or 5)))
    settings = manifest.get("settings") or {}
    subtitle_style = str(settings.get("subtitle_style") or args.subtitle_style or "classic")
    framing_mode = str(settings.get("framing_mode") or args.framing_mode or "auto")
    if framing_mode not in {"auto", "smart_switch", "dual_stack"}:
        framing_mode = "auto"
    do_upscale = bool(settings.get("upscale", False))
    RUNTIME_HARDWARE["export_preset"] = str(settings.get("export_preset") or args.export_preset)
    RUNTIME_HARDWARE["output_name_template"] = str(
        settings.get("output_name_template") or args.output_name_template
    )
    RUNTIME_HARDWARE["resolved_transcription_provider"] = settings.get("transcription_provider")
    RUNTIME_HARDWARE["transcription_model"] = settings.get("transcription_model")

    candidates = [dict(candidate) for candidate in manifest.get("candidates", []) if isinstance(candidate, dict)]
    by_id = {
        str(candidate.get("yield_id") or candidate.get("id")): candidate
        for candidate in candidates
        if candidate.get("yield_id") or candidate.get("id")
    }
    exported_ids = {str(value) for value in manifest.get("exported_candidate_ids", [])}
    failed_ids = {str(value) for value in manifest.get("failed_candidate_ids", [])}
    requested_ids = [str(value).strip() for value in (candidate_ids or []) if str(value).strip()]
    if requested_ids:
        unknown = [candidate_id for candidate_id in requested_ids if candidate_id not in by_id]
        if unknown:
            raise ValueError(f"Unknown candidate id(s): {', '.join(unknown[:5])}")
        ordered_ids = list(dict.fromkeys(requested_ids))
    else:
        # Prefer a new story cluster before offering alternate lengths from an
        # already-exported story.  Older manifests without cluster metadata
        # retain the existing score order.
        exported_clusters = {
            str(by_id[candidate_id].get("cluster_id") or by_id[candidate_id].get("story_cluster_id"))
            for candidate_id in exported_ids
            if candidate_id in by_id
            and (by_id[candidate_id].get("cluster_id") or by_id[candidate_id].get("story_cluster_id"))
        }
        ranked = sorted(
            candidates,
            key=lambda item: (
                str(item.get("cluster_id") or item.get("story_cluster_id") or "") in exported_clusters,
                int(item.get("variant_rank", 1) or 1),
                -float(item.get("score", 0.0)),
            ),
        )
        ordered_ids = list(dict.fromkeys([
            *[str(value) for value in manifest.get("reserve_candidate_ids", [])],
            *[str(candidate.get("yield_id") or candidate.get("id")) for candidate in ranked],
        ]))
    queue = [
        by_id[candidate_id]
        for candidate_id in ordered_ids
        if candidate_id in by_id and candidate_id not in exported_ids and candidate_id not in failed_ids
    ]
    if not queue:
        print("✅ No unused eligible candidates remain in this analysis manifest.")
        return

    desired = min(len(requested_ids) if requested_ids else requested_count, len(queue))
    if requested_ids:
        manifest["selected_candidate_ids"] = [
            candidate_id for candidate_id in requested_ids
            if candidate_id not in exported_ids and candidate_id not in failed_ids
        ]
        manifest["status"] = "rendering"
        temporary_path = f"{manifest_path}.tmp"
        with open(temporary_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=2)
        os.replace(temporary_path, manifest_path)
    print(
        f"➕ Generate More: rendering {desired} unused candidate(s) from saved analysis"
        " without rerunning transcription"
    )
    is_hdr, src_w, src_h = detect_hdr_and_res(source_path)
    proxy_path = create_proxy(source_path)
    exported = 0
    try:
        for attempt_index, clip in enumerate(queue):
            if exported >= desired:
                break
            candidate_id = str(clip.get("yield_id") or clip.get("id"))
            clip["candidate_manifest"] = manifest_path
            clip["confidence_tier"] = clip.get("confidence_tier") or clip.get("yield_tier")
            clip["yield_role"] = "generate_more"
            print(
                f"\n📎 Additional candidate {attempt_index + 1}/{len(queue)}"
                f" | Score: {float(clip.get('score', 0.0)):.1f}"
                f" | Duration: {float(clip['end']) - float(clip['start']):.1f}s"
            )
            try:
                frame_layout = analyze_speaker_layout(
                    proxy_path,
                    float(clip["start"]),
                    sample_duration=3,
                    framing_mode=framing_mode,
                    clip_end_time=float(clip["end"]),
                    clip_words=clip.get("words", []),
                )
                render_clip(
                    source_path,
                    clip,
                    frame_layout,
                    len(exported_ids) + exported,
                    is_hdr,
                    do_upscale,
                    subtitle_style,
                    bake_subtitles=False,
                    metadata_source_path=source_path,
                )
                exported += 1
                update_candidate_manifest(manifest_path, exported_id=candidate_id)
            except Exception as error:
                update_candidate_manifest(manifest_path, failed_id=candidate_id)
                print(f"  ❌ Candidate {candidate_id} failed: {error} — trying the next candidate")
        print(f"\n✅ Generate More exported {exported}/{desired} additional Shorts")
    finally:
        if proxy_path != source_path and os.path.exists(proxy_path):
            try:
                os.remove(proxy_path)
            except OSError:
                pass


def render_clip(video_path, clip_data, static_center, index, is_hdr, do_upscale, subtitle_style="classic", subtitle_animation="none", subtitle_glow=False, output_path=None, sub_pos_x=None, sub_pos_y=None, sub_font_size=None, bake_subtitles=True, font_override=None, sub_width=None, video_zoom=1.0, video_pan_x=0.0, video_pan_y=0.0, metadata_source_path=None):
    """Render a single 9:16 clip using SOURCE VIDEO with static crop and optional subtitles"""
    subtitle_style = normalize_subtitle_style(subtitle_style)
    subtitle_animation = normalize_subtitle_animation(subtitle_animation)
    start_time = clip_data["start"]
    end_time = clip_data["end"]
    duration = end_time - start_time

    export_preset = get_export_preset(RUNTIME_HARDWARE.get("export_preset", "generic"))
    if output_path is None:
        filename = safe_output_name(
            RUNTIME_HARDWARE.get("output_name_template", "{source}_{platform}_{index}_{score}"),
            metadata_source_path or video_path,
            export_preset["id"],
            index + 1,
            float(clip_data.get("score", 0)),
        )
        output_path = os.path.join(OUTPUT_DIR, filename)
        if os.path.exists(output_path):
            stem, extension = os.path.splitext(filename)
            collision_index = 2
            while os.path.exists(os.path.join(OUTPUT_DIR, f"{stem}_{collision_index}{extension}")):
                collision_index += 1
            filename = f"{stem}_{collision_index}{extension}"
            output_path = os.path.join(OUTPUT_DIR, filename)
    else:
        filename = os.path.basename(output_path)
    animation_label = subtitle_animation if subtitle_animation and subtitle_animation != "none" else "none"
    glow_label = "on" if subtitle_glow else "off"
    print(f"🎬 Rendering Clip #{index+1}: {filename} ({duration:.1f}s) [Style: {subtitle_style}, Animation: {animation_label}, Glow: {glow_label}]")

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080

    target_w, target_h = export_preset["width"], export_preset["height"]
    frame_layout = normalize_frame_layout(static_center, width, height)
    layout_mode = frame_layout.get("mode", "single")
    cap.release()

    # Generate subtitles only when explicitly baking (rerender mode)
    subtitle_file = None
    subtitle_filter = None
    if bake_subtitles and subtitle_style != "none" and 'words' in clip_data and clip_data['words']:
        subtitle_file = generate_subtitle_file(
            clip_data['words'],
            subtitle_style,
            start_time,
            sub_pos_x,
            sub_pos_y,
            sub_font_size,
            font_override,
            sub_width,
            subtitle_animation,
            subtitle_glow,
        )
        if subtitle_file:
            subtitle_filter = get_subtitle_filter(subtitle_style, subtitle_file)

    filters = []
    if layout_mode == "dual_stack":
        split_x = frame_layout.get("split_x", width // 2)
        overlap = int(width * 0.04)
        left_x = 0
        left_w = int(clamp(split_x + overlap, int(width * 0.35), width - 2))
        right_x = int(clamp(split_x - overlap, 0, width - 2))
        right_w = int(clamp(width - right_x, int(width * 0.35), width))
        panel_h = int(target_h / 2)
        print(f"  > Dual speaker stack: left 0:{left_w} | right {right_x}:{right_x + right_w}")
        if video_zoom and video_zoom > 1.01:
            print("  > Ignoring manual zoom/pan for dual-speaker stack layout")
        vf_chain = (
            f"split=2[leftsrc][rightsrc];"
            f"[leftsrc]crop={left_w}:{height}:{left_x}:0,scale={target_w}:{panel_h}:force_original_aspect_ratio=increase,crop={target_w}:{panel_h}[left];"
            f"[rightsrc]crop={right_w}:{height}:{right_x}:0,scale={target_w}:{panel_h}:force_original_aspect_ratio=increase,crop={target_w}:{panel_h}[right];"
            f"[left][right]vstack=inputs=2"
        )
        if subtitle_filter:
            vf_chain += f",{subtitle_filter}"
    else:
        crop_h = height
        if layout_mode == "smart_switch":
            crop_h = int(clamp(frame_layout.get("crop_height", height), 2, height))
        crop_h = max(2, (crop_h // 2) * 2)
        crop_w = int(crop_h * (9 / 16))
        if crop_w > width:
            crop_w = width
        crop_w = max(2, (crop_w // 2) * 2)

        static_center_px = frame_layout.get("static_center", width // 2)
        x1 = static_center_px - (crop_w // 2)
        x2 = x1 + crop_w

        if x1 < 0:
            x1 = 0
            x2 = crop_w
        elif x2 > width:
            x2 = width
            x1 = width - crop_w

        crop_x = str(int(x1))
        static_center_y = int(frame_layout.get("center_y", height // 2))
        vertical_position = clamp(
            float(CONFIG.get("tracking", {}).get("smart_switch", {}).get("crop_face_vertical_position", 0.44)),
            0.2,
            0.8,
        )
        static_y = _smart_crop_top(
            static_center_y,
            crop_h,
            height,
            vertical_position,
            detected_top=frame_layout.get("crop_top"),
        )
        crop_y = str(static_y)
        if layout_mode == "smart_switch" and frame_layout.get("switch_segments"):
            default_x = int(x1)
            x_expr = str(default_x)
            y_expr = str(static_y)
            for segment in reversed(frame_layout.get("switch_segments", [])):
                center = int(segment.get("center_x", segment.get("center", static_center_px)))
                center_y = int(segment.get("center_y", static_center_y))
                sx = int(clamp(center - (crop_w // 2), 0, max(0, width - crop_w)))
                sy = _smart_crop_top(
                    center_y,
                    crop_h,
                    height,
                    vertical_position,
                    detected_top=segment.get("crop_top"),
                )
                start_rel = max(0.0, float(segment.get("start", 0.0)))
                end_rel = max(start_rel + 0.05, float(segment.get("end", start_rel + 0.05)))
                x_expr = f"if(between(t\\,{start_rel:.3f}\\,{end_rel:.3f})\\,{sx}\\,{x_expr})"
                y_expr = f"if(between(t\\,{start_rel:.3f}\\,{end_rel:.3f})\\,{sy}\\,{y_expr})"
            crop_x = x_expr
            crop_y = y_expr
            print(
                f"  > Smart talking-head crop: {crop_w}x{crop_h} with"
                f" {len(frame_layout.get('switch_segments', []))} verified switch segment(s)"
            )
        else:
            print(f"  > Static crop: {crop_w}x{crop_h} at X={x1}, Y={static_y}")

        filters = [
            f"crop={crop_w}:{crop_h}:{crop_x}:{crop_y}",
            f"scale={target_w}:{target_h}:flags=lanczos",
        ]

        if video_zoom and video_zoom > 1.01:
            crop_w = (int(target_w / video_zoom) // 2) * 2
            crop_h = (int(target_h / video_zoom) // 2) * 2
            crop_w = max(2, crop_w)
            crop_h = max(2, crop_h)
            cx = int(target_w / 2 - video_pan_x * target_w) - crop_w // 2
            cy = int(target_h / 2 - video_pan_y * target_h) - crop_h // 2
            cx = max(0, min(target_w - crop_w, cx))
            cy = max(0, min(target_h - crop_h, cy))
            filters.append(f"crop={crop_w}:{crop_h}:{cx}:{cy}")
            filters.append(f"scale={target_w}:{target_h}:flags=lanczos")
            print(f"  🔍 Zoom {video_zoom:.1f}x pan=({video_pan_x:.3f},{video_pan_y:.3f})")

        if subtitle_filter:
            filters.append(subtitle_filter)
        vf_chain = ",".join(filters)

    def build_render_cmd(vf_value, backend):
        resolved_vf = encoder_filter(vf_value, backend, False)
        return [
            *build_encoder_command_prefix(backend),
            "-y", "-v", "quiet", "-nostats", "-progress", "pipe:2",
            "-ss", str(start_time), "-t", str(duration),
            "-i", video_path,
            "-vf", resolved_vf,
            *encoder_args(backend, False, "clip"),
            "-c:a", "aac", "-b:a", "192k",
            output_path
        ]

    try:
        resolved_backend, _ = run_with_encoder_fallback(
            lambda backend: build_render_cmd(vf_chain, backend),
            configured_video_backends(False),
            context=f"Clip {index + 1}",
        )
        RUNTIME_HARDWARE["resolved_video_encoder"] = resolved_backend
    except RuntimeError:
        no_sub_filters = [f for f in filters if not f.startswith("ass=")]
        vf_no_sub = ",".join(no_sub_filters) if no_sub_filters else "null"
        if bake_subtitles and subtitle_filter:
            raise
        if layout_mode == "dual_stack" or len(no_sub_filters) == len(filters):
            raise
        print("  ⚠️  Retrying without subtitles after all encoders rejected the subtitle filter...")
        resolved_backend, _ = run_with_encoder_fallback(
            lambda backend: build_render_cmd(vf_no_sub, backend),
            configured_video_backends(False),
            context=f"Clip {index + 1} without subtitles",
        )
        RUNTIME_HARDWARE["resolved_video_encoder"] = resolved_backend

    # Save clip metadata JSON for subtitle editing
    json_path = output_path.replace('.mp4', '.json')
    clip_meta = {
        "source": os.path.abspath(metadata_source_path or video_path),
        "start": start_time,
        "end": end_time,
        "duration": duration,
        "score": clip_data.get("score", 0),
        "candidate_score": clip_data.get("candidate_score", clip_data.get("score", 0)),
        "reasons": clip_data.get("reasons", []),
        "score_breakdown": clip_data.get("score_breakdown", {}),
        "ranking_version": clip_data.get("ranking_version", "hybrid_v3"),
        "candidate_id": clip_data.get("yield_id") or clip_data.get("id"),
        "confidence_tier": clip_data.get("confidence_tier") or clip_data.get("yield_tier"),
        "yield_role": clip_data.get("yield_role"),
        "yield_rank": clip_data.get("yield_rank"),
        "yield_plan": clip_data.get("yield_plan", {}),
        "cluster_id": clip_data.get("cluster_id") or clip_data.get("story_cluster_id"),
        "variant_rank": clip_data.get("variant_rank", 1),
        "duplicate_of": clip_data.get("duplicate_of"),
        "candidate_manifest": clip_data.get("candidate_manifest"),
        "topics": clip_data.get("topics", []),
        "intelligence_providers": clip_data.get("intelligence_providers", {}),
        "transcription_provider": RUNTIME_HARDWARE.get("resolved_transcription_provider"),
        "transcription_model": RUNTIME_HARDWARE.get("transcription_model") or CONFIG["transcription"]["model_size"],
        "compute_backend": RUNTIME_HARDWARE.get("resolved_compute", "cpu"),
        "video_encoder": RUNTIME_HARDWARE.get("resolved_video_encoder") or "cpu",
        "manifest_version": 1,
        "export_preset": export_preset["id"],
        "output_resolution": [target_w, target_h],
        "safe_area": export_preset["safe_area"],
        "output_name_template": RUNTIME_HARDWARE.get("output_name_template"),
        "style": subtitle_style,
        "animation": subtitle_animation or "none",
        "subtitle_glow": bool(subtitle_glow),
        "font": font_override,
        "subtitle_x": sub_pos_x,
        "subtitle_y": sub_pos_y,
        "subtitle_width": sub_width,
        "subtitle_fontsize": sub_font_size,
        "baked": bake_subtitles,
        "static_center": frame_layout.get("static_center", width // 2),
        "frame_layout": frame_layout,
        "framing_mode": frame_layout.get("mode", "single"),
        "words": clip_data.get("words", []),
        "video_zoom": float(video_zoom) if video_zoom and video_zoom > 1.01 else 1.0,
        "video_pan_x": float(video_pan_x) if video_zoom and video_zoom > 1.01 else 0.0,
        "video_pan_y": float(video_pan_y) if video_zoom and video_zoom > 1.01 else 0.0,
    }
    with open(json_path, 'w') as f:
        json.dump(clip_meta, f, indent=2)

    # Clean up subtitle file
    if subtitle_file and os.path.exists(subtitle_file):
        os.remove(subtitle_file)

KNOWN_SUBTITLE_STYLES = {
    "classic", "bold", "explosive", "bounce", "pulse", "clean",
    "gold", "electric", "neon", "cinematic", "shadow", "outline",
    "gradient", "fire", "wave", "karaoke", "stark", "glitch",
    "spotlight", "duo", "subtitle", "whip", "marker", "signal",
    "prism", "halo", "ticker", "poster", "none",
}

KNOWN_SUBTITLE_ANIMATIONS = {
    "none",
    "popIn",
    "fadeIn",
    "slideUp",
    "slideDown",
    "flip",
    "typewriter",
    "wave",
    "zoom",
    "bounce",
    "shake",
    "glow",
}


def escape_ass_text(text):
    return str(text or "").replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}").replace("\n", " ").strip()


def normalize_subtitle_style(style):
    style = str(style or "classic")
    return style if style in KNOWN_SUBTITLE_STYLES else "classic"


def normalize_subtitle_animation(animation):
    return animation if animation in KNOWN_SUBTITLE_ANIMATIONS else "none"


def build_ass_animation_tags(animation, word_start_ms, word_end_ms):
    animation = normalize_subtitle_animation(animation)
    if animation == "none":
        return ""

    active_end_ms = max(word_end_ms + 120, word_start_ms + 220)
    duration_ms = max(120, active_end_ms - word_start_ms)
    phase1 = min(active_end_ms, word_start_ms + max(60, duration_ms // 3))
    phase2 = min(active_end_ms, max(phase1 + 40, word_start_ms + max(120, (2 * duration_ms) // 3)))
    phase3 = min(active_end_ms, max(phase2 + 40, word_start_ms + duration_ms))

    if animation == "popIn":
        return (
            r"\alpha&HFF&\fscx42\fscy42"
            f"\\t({word_start_ms},{phase1},\\alpha&H00&\\fscx138\\fscy138)"
            f"\\t({phase1},{phase2},\\fscx100\\fscy100)"
        )

    if animation == "fadeIn":
        return r"\alpha&HFF&" + f"\\t({word_start_ms},{phase1},\\alpha&H00&)"

    if animation == "slideUp":
        return (
            r"\alpha&HFF&\fscx92\fscy148"
            f"\\t({word_start_ms},{phase1},\\alpha&H00&\\fscx100\\fscy100)"
        )

    if animation == "slideDown":
        return (
            r"\alpha&HFF&\fscx112\fscy62"
            f"\\t({word_start_ms},{phase1},\\alpha&H00&\\fscx100\\fscy100)"
        )

    if animation == "flip":
        return r"\alpha&HFF&\fry90" + f"\\t({word_start_ms},{phase1},\\alpha&H00&\\fry0)"

    if animation == "typewriter":
        reveal_end = min(active_end_ms, word_start_ms + 90)
        return r"\alpha&HFF&" + f"\\t({word_start_ms},{reveal_end},\\alpha&H00&)"

    if animation == "wave":
        return (
            r"\fscx100\fscy100\frz0"
            f"\\t({word_start_ms},{phase1},\\fscx108\\fscy118\\frz-6)"
            f"\\t({phase1},{phase2},\\fscx114\\fscy92\\frz6)"
            f"\\t({phase2},{phase3},\\fscx100\\fscy100\\frz0)"
        )

    if animation == "zoom":
        return (
            r"\fscx100\fscy100"
            f"\\t({word_start_ms},{phase1},\\fscx142\\fscy142)"
            f"\\t({phase1},{phase3},\\fscx100\\fscy100)"
        )

    if animation == "bounce":
        return (
            r"\fscx100\fscy100\frz0"
            f"\\t({word_start_ms},{phase1},\\fscx94\\fscy136\\frz-5)"
            f"\\t({phase1},{phase2},\\fscx118\\fscy86\\frz4)"
            f"\\t({phase2},{phase3},\\fscx100\\fscy100\\frz0)"
        )

    if animation == "shake":
        return (
            r"\frz0\fax0"
            f"\\t({word_start_ms},{phase1},\\frz-7\\fax-0.08)"
            f"\\t({phase1},{phase2},\\frz7\\fax0.08)"
            f"\\t({phase2},{phase3},\\frz0\\fax0)"
        )

    if animation == "glow":
        return (
            r"\blur0.8\bord2\shad1"
            f"\\t({word_start_ms},{phase1},\\blur4\\bord5\\shad0)"
            f"\\t({phase1},{phase3},\\blur1\\bord2\\shad1)"
        )

    return ""


def generate_subtitle_file(words, style, offset_time=0, pos_x=None, pos_y=None, font_size=None, font_override=None, sub_width=None, animation="none", glow=False):
    """Generate ASS subtitle file for all styles (word-by-word animation)"""
    style = normalize_subtitle_style(style)
    if not words or style == "none":
        return None
    return generate_ass_subtitles(words, style, offset_time, pos_x, pos_y, font_size, font_override, sub_width, animation, glow)


def generate_ass_subtitles(words, style, offset_time=0, pos_x=None, pos_y=None, font_size=None, font_override=None, sub_width=None, animation="none", glow=False):
    """Generate ASS subtitle file with professional animated captions"""
    style = normalize_subtitle_style(style)
    animation = normalize_subtitle_animation(animation)
    fd, ass_file = tempfile.mkstemp(prefix=f"subtitles_{int(offset_time * 1000)}_", suffix=".ass", dir=TEMP_DIR)
    os.close(fd)

    ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
{style_line}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    # Professional caption styles (font names use spaces as registered in fontconfig)
    styles = {
        # Classic: word-by-word rainbow highlight, top position
        "classic": {
            "style_line": "Style: Default,Montserrat Black,90,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,8,40,40,120,1",
            "chunk_size": 4,
        },
        # Bold: large cyan text, solid black background, center
        "bold": {
            "style_line": "Style: Default,Montserrat Black,95,&H0000FFFF,&H000000FF,&H00000000,&HFF000000,-1,0,0,0,105,105,0,0,1,6,0,5,40,40,80,1",
            "chunk_size": 3,
        },
        # Explosive: massive Anton font, white on black, center
        "explosive": {
            "style_line": "Style: Default,Anton,130,&H00FFFFFF,&H000000FF,&H00000000,&HFF000000,-1,0,0,0,110,110,0,0,1,7,0,5,30,30,80,1",
            "chunk_size": 2,
        },
        # Bounce: energetic bottom captions, semi-transparent bg
        "bounce": {
            "style_line": "Style: Default,Poppins Bold,85,&H00FFFFFF,&H000000FF,&H00000000,&HC0000000,-1,0,0,0,100,100,0,0,1,5,3,2,40,40,180,1",
            "chunk_size": 3,
        },
        # Pulse: colorful center pop with pink outline
        "pulse": {
            "style_line": "Style: Default,Poppins Black,88,&H00FFFFFF,&H000000FF,&H00FF1493,&H96000000,-1,0,0,0,100,100,0,0,1,5,2,5,40,40,100,1",
            "chunk_size": 3,
        },
        # Clean: minimal light-gray top caption, subtle outline
        "clean": {
            "style_line": "Style: Default,Montserrat Bold,82,&H00F5F5F5,&H000000FF,&H00333333,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,8,50,50,140,1",
            "chunk_size": 4,
        },
        # Gold: luxury gold accent text, dark bg
        "gold": {
            "style_line": "Style: Default,Montserrat Black,86,&H00FFFACD,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,4,2,5,45,45,100,1",
            "chunk_size": 3,
        },
        # Electric: aggressive cyan Anton, high contrast, center
        "electric": {
            "style_line": "Style: Default,Anton,105,&H0000FFFF,&H000000FF,&H00000000,&HFF000000,-1,0,0,0,105,105,0,0,1,6,1,5,35,35,90,1",
            "chunk_size": 2,
        },
        # Neon: neon-glow multi-color cycling, vibrant center
        "neon": {
            "style_line": "Style: Default,Montserrat Black,88,&H00FFFF00,&H000000FF,&H0000FFFF,&HA0000000,-1,0,0,0,100,100,0,0,1,4,3,5,40,40,100,1",
            "chunk_size": 3,
        },
        # Cinematic: clean white on opaque black bar, bottom
        "cinematic": {
            "style_line": "Style: Default,Montserrat Bold,78,&H00FFFFFF,&H000000FF,&H00000000,&HE6000000,-1,0,0,0,100,100,1,0,3,0,0,2,80,80,60,1",
            "chunk_size": 5,
        },
        # Shadow: white text with heavy drop shadow, word pop highlight
        "shadow": {
            "style_line": "Style: Default,Montserrat Black,90,&H00FFFFFF,&H000000FF,&H00000000,&HCC000000,-1,0,0,0,100,100,0,0,1,3,10,5,40,40,100,1",
            "chunk_size": 3,
        },
        # Outline: thick outlined white text, high readability pop
        "outline": {
            "style_line": "Style: Default,Barlow Condensed Black,98,&H00FFFFFF,&H000000FF,&H00000000,&HFF000000,-1,0,0,0,105,105,0,0,1,8,0,5,40,40,80,1",
            "chunk_size": 3,
        },
        # Gradient: warm amber-to-yellow word color shift
        "gradient": {
            "style_line": "Style: Default,Montserrat Black,88,&H00FFFFFF,&H000000FF,&H000045FF,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,5,40,40,100,1",
            "chunk_size": 3,
        },
        # Fire: high-energy orange/red word flash, uppercase
        "fire": {
            "style_line": "Style: Default,Oswald Bold,105,&H00FFFFFF,&H000000FF,&H000045FF,&HFF000000,-1,0,0,0,108,108,0,0,1,6,1,5,35,35,90,1",
            "chunk_size": 2,
        },
        # Wave: playful alternating color flow
        "wave": {
            "style_line": "Style: Default,Poppins Bold,84,&H00FFFFFF,&H000000FF,&H00FF69B4,&H90000000,-1,0,0,0,100,100,0,0,1,4,2,5,40,40,100,1",
            "chunk_size": 4,
        },
        # Karaoke: yellow progression highlight, clean center read
        "karaoke": {
            "style_line": "Style: Default,Montserrat Black,88,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,2,5,40,40,100,1",
            "chunk_size": 4,
        },
        # Stark: solid black box behind text, bold pop
        "stark": {
            "style_line": "Style: Default,Montserrat Black,86,&H00FFFFFF,&H000000FF,&H00000000,&HFF000000,-1,0,0,0,100,100,0,0,3,0,0,5,60,60,80,1",
            "chunk_size": 3,
        },
        # Glitch: chromatic aberration alternating red/cyan, all-caps
        "glitch": {
            "style_line": "Style: Default,Oswald Bold,95,&H00FFFFFF,&H000000FF,&H000000FF,&HFF000000,-1,0,0,0,100,100,0,0,1,5,0,5,40,40,90,1",
            "chunk_size": 3,
        },
        # Spotlight: single large word, centered, Bebas Neue
        "spotlight": {
            "style_line": "Style: Default,Bebas Neue,150,&H00FFFFFF,&H000000FF,&H00000000,&HE0000000,-1,0,0,0,100,100,8,0,1,6,0,5,30,30,80,1",
            "chunk_size": 1,
        },
        # Duo: two words, Archivo Black, background box per line
        "duo": {
            "style_line": "Style: Default,Archivo Black,100,&H00FFFFFF,&H000000FF,&H00000000,&HE0000000,-1,0,0,0,100,100,4,0,3,0,0,5,50,50,80,1",
            "chunk_size": 2,
        },
        # Subtitle: classic bottom strip, Oswald, opaque bar
        "subtitle": {
            "style_line": "Style: Default,Oswald Bold,76,&H00FFFFFF,&H000000FF,&H00000000,&HD9000000,-1,0,0,0,100,100,1,0,3,1,2,2,80,80,50,1",
            "chunk_size": 6,
        },
        # Whip: Rajdhani condensed, hot-pink active, fast snap
        "whip": {
            "style_line": "Style: Default,Rajdhani Bold,92,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,5,2,5,40,40,100,1",
            "chunk_size": 3,
        },
        # Marker: editorial yellow highlighter with a heavy ink edge
        "marker": {
            "style_line": "Style: Default,Montserrat Black,96,&H0000F2FF,&H000000FF,&H00171717,&HB0120C0A,-1,0,0,0,100,100,1,0,1,6,2,5,40,40,110,1",
            "chunk_size": 3,
        },
        # Signal: cool newsroom blue with a compact, clean motion cue
        "signal": {
            "style_line": "Style: Default,Archivo Black,94,&H00FCFAF8,&H000000FF,&H00E9A50E,&HE01C0C03,-1,0,0,0,100,100,1,0,1,4,2,5,40,40,90,1",
            "chunk_size": 3,
        },
        # Prism: three-color social treatment with a deep indigo edge
        "prism": {
            "style_line": "Style: Default,Poppins Black,92,&H00FFFFFF,&H000000FF,&H00812E31,&HB0230A0F,-1,0,0,0,100,100,0,0,1,6,2,5,40,40,100,1",
            "chunk_size": 3,
        },
        # Halo: airy white type with a lilac halo for clips with busy footage
        "halo": {
            "style_line": "Style: Default,Poppins Black,94,&H00FFFFFF,&H000000FF,&H00FC84C0,&H40000000,-1,0,0,0,100,100,0,0,1,7,3,5,40,40,110,1",
            "chunk_size": 2,
        },
        # Ticker: a concise lower-third, designed for dense information clips
        "ticker": {
            "style_line": "Style: Default,Rajdhani Bold,80,&H00FEF2E0,&H000000FF,&H00170602,&HE0170602,-1,0,0,0,100,100,2,0,3,1,1,2,55,55,55,1",
            "chunk_size": 4,
        },
        # Poster: bold title-card energy, orange panel and two-word cadence
        "poster": {
            "style_line": "Style: Default,Anton,112,&H00FFFFFF,&H000000FF,&H00271811,&H201C92FB,-1,0,0,0,105,105,2,0,3,2,2,5,40,40,105,1",
            "chunk_size": 2,
        },
    }
    # Glow is deliberately opt-in. When enabled, use a style-appropriate
    # outline color instead of turning every default caption into a halo.
    glow_outline_colors = {
        "classic": "&H0000FFFF", "bold": "&H00FFFF00", "explosive": "&H00FFFFFF",
        "bounce": "&H00FFFFFF", "pulse": "&H0000FFFF", "clean": "&H00E8E8E8",
        "gold": "&H0000D7FF", "electric": "&H00FFFF00", "neon": "&H0000FFFF",
        "cinematic": "&H00FFFFFF", "shadow": "&H0000FFFF", "outline": "&H0000CFFF",
        "gradient": "&H0000CFFF", "fire": "&H000080FF", "wave": "&H00FFFF00",
        "karaoke": "&H0000FFFF", "stark": "&H00FF69B4", "glitch": "&H00FFFF00",
        "spotlight": "&H00FFFFFF", "duo": "&H00FF69B4", "subtitle": "&H00E8F4FF",
        "whip": "&H00FF1493", "marker": "&H0000F2FF", "signal": "&H00F8BD38",
        "prism": "&H00EED322", "halo": "&H00FCAAF0", "ticker": "&H00F8E867",
        "poster": "&H201C92FB",
    }

    # Allowed font names — limited to the bundled open-source font set for the public repo
    ALLOWED_FONTS = {
        # Social / creator fonts
        "Montserrat Black", "Montserrat Bold", "Anton", "Bebas Neue", "Oswald Bold",
        "Poppins Black", "Poppins Bold", "Barlow Condensed Black", "Archivo Black",
        "Rajdhani Bold",
        # Compatible open-source fonts
        "Liberation Sans", "Liberation Serif", "Liberation Mono",
        "Comic Neue",
        # Open-source alternatives
        "DejaVu Sans", "DejaVu Serif",
    }

    style_config = styles.get(style)
    if style_config is None:
        raise ValueError(f"Caption style {style!r} has no ASS definition")
    style_line = style_config["style_line"]
    # Apply font override: replace the font name (2nd CSV field) if specified
    if font_override:
        if font_override not in ALLOWED_FONTS:
            print(f"  ⚠️  Unknown font '{font_override}', using style default")
        else:
            parts = style_line.split(',')
            parts[1] = font_override
            style_line = ','.join(parts)
    # Apply subtitle width: adjust MarginL (index 19) and MarginR (index 20)
    if sub_width is not None:
        margin_px = max(0, min(480, int((1.0 - sub_width) * 540)))
        parts = style_line.split(',')
        parts[19] = str(margin_px)
        parts[20] = str(margin_px)
        style_line = ','.join(parts)
    header = ASS_HEADER.format(style_line=style_line)
    lines = [header]
    chunk_size = style_config["chunk_size"]

    # Color palette for word-by-word highlighting
    rainbow_colors = [
        "&H0000FFFF",  # Yellow
        "&H00FFA500",  # Orange
        "&H00FF1493",  # Deep Pink
        "&H0000FF00",  # Green
        "&H00FF00FF",  # Magenta
        "&H0000BFFF",  # Deep Sky Blue
    ]
    neon_colors = [
        "&H0000FFFF",  # Yellow
        "&H00FF00FF",  # Magenta
        "&H0000FF00",  # Lime Green
        "&H00FF4500",  # Orange-Red
        "&H00FF69B4",  # Hot Pink
    ]
    fire_colors = [
        "&H000000FF",  # Red (R=FF)
        "&H000045FF",  # Deep orange (R=FF, G=45)
        "&H000080FF",  # Orange (R=FF, G=80)
        "&H0000CFFF",  # Amber (R=FF, G=CF)
        "&H0000FFFF",  # Yellow
    ]
    gradient_colors = [
        "&H0000CFFF",  # Warm amber
        "&H000080FF",  # Orange
        "&H0000FFFF",  # Yellow
        "&H0080FF80",  # Yellow-green
        "&H0000FF80",  # Spring green
    ]
    wave_colors = [
        "&H00FFFF00",  # Cyan
        "&H00FF80FF",  # Lavender
        "&H0000FF00",  # Lime
        "&H00FF00FF",  # Magenta
        "&H0000FFFF",  # Yellow
    ]
    prism_colors = [
        "&H00EED322",  # Cyan
        "&H00F88C81",  # Indigo
        "&H00B669F4",  # Pink
    ]

    for i in range(0, len(words), chunk_size):
        chunk = words[i:i+chunk_size]
        if not chunk:
            continue

        start_t = max(0, chunk[0]['start'] - offset_time)
        end_t = max(start_t + 0.1, chunk[-1]['end'] - offset_time)
        # ASS transform times are relative to the start of each Dialogue line,
        # not to the clip.  Using clip-relative values leaves animated words
        # transparent after the line has already ended.
        dialogue_start_ms = max(0, int(start_t * 1000))

        word_parts = []
        word_gap = r"\h" if animation == "none" else r"\h\h"

        for j, w in enumerate(chunk):
            word_start_abs = max(0, int((w['start'] - offset_time) * 1000))
            word_end_abs = max(word_start_abs + 1, int((w['end'] - offset_time) * 1000))
            word_start = max(0, word_start_abs - dialogue_start_ms)
            word_end = max(word_start + 1, word_end_abs - dialogue_start_ms)
            word_text = w['word'].strip()
            style_tags = ""
            animation_tags = build_ass_animation_tags(animation, word_start, word_end)
            word_display = escape_ass_text(word_text)

            if style in ("classic", "pulse"):
                # Word-by-word rainbow color highlight + scale pop
                color = rainbow_colors[j % len(rainbow_colors)]
                style_tags = (
                    f"\\t({word_start},{word_end},\\c{color}\\fscx115\\fscy115)"
                    f"\\t({word_end},{word_end+200},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "bold":
                # Cyan highlight on active word, white otherwise
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H0000FFFF\\fscx110\\fscy110)"
                    f"\\t({word_end},{word_end+150},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "explosive":
                # Uppercase with hard pop-in
                word_display = escape_ass_text(word_text.upper())
                style_tags = (
                    f"\\t({word_start},{word_start+80},\\fscx135\\fscy135)"
                    f"\\t({word_start+80},{word_end},\\fscx110\\fscy110)"
                )

            elif style == "bounce":
                # Springy bounce on each word
                style_tags = (
                    f"\\t({word_start},{word_start+120},\\fscx115\\fscy115)"
                    f"\\t({word_start+120},{word_start+240},\\fscx95\\fscy95)"
                    f"\\t({word_start+240},{word_end},\\fscx100\\fscy100)"
                )

            elif style == "clean":
                # Subtle warm highlight, minimal motion
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H00E8E8E8)"
                    f"\\t({word_end},{word_end+250},\\c&H00F5F5F5)"
                )

            elif style == "gold":
                # Transitions gold → cream on active word
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H0000D7FF)"
                    f"\\t({word_end},{word_end+100},\\c&H00FFFACD)"
                )

            elif style == "electric":
                # Aggressive scale + cyan flash, all caps
                word_display = escape_ass_text(word_text.upper())
                style_tags = (
                    f"\\t({word_start},{word_start+60},\\fscx125\\fscy125\\c&H0000FFFF)"
                    f"\\t({word_start+60},{word_end},\\fscx105\\fscy105)"
                    f"\\t({word_end},{word_end+100},\\fscx100\\fscy100)"
                )

            elif style == "neon":
                # Neon color cycling with glow pulse
                color = neon_colors[j % len(neon_colors)]
                style_tags = (
                    f"\\t({word_start},{word_end},\\c{color}\\fscx108\\fscy108)"
                    f"\\t({word_end},{word_end+150},\\fscx100\\fscy100)"
                )

            elif style == "cinematic":
                # Minimal: slow white highlight, no scale
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H00FFFFFF)"
                    f"\\t({word_end},{word_end+300},\\c&H00D0D0D0)"
                )

            elif style == "shadow":
                # Yellow highlight pop then back to white (heavy shadow from style line)
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H0000FFFF\\fscx112\\fscy112)"
                    f"\\t({word_end},{word_end+250},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "outline":
                # Orange scale-in snap, then white (thick outline from style line)
                style_tags = (
                    f"\\t({word_start},{word_start+100},\\fscx120\\fscy120\\c&H0000CFFF)"
                    f"\\t({word_start+100},{word_end},\\fscx108\\fscy108)"
                    f"\\t({word_end},{word_end+150},\\fscx100\\fscy100\\c&H00FFFFFF)"
                )

            elif style == "gradient":
                # Warm gradient color per word, scale pop
                color = gradient_colors[j % len(gradient_colors)]
                style_tags = (
                    f"\\t({word_start},{word_end},\\c{color}\\fscx110\\fscy110)"
                    f"\\t({word_end},{word_end+200},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "fire":
                # Intense orange-red blast per word, uppercase
                color = fire_colors[j % len(fire_colors)]
                word_display = escape_ass_text(word_text.upper())
                style_tags = (
                    f"\\t({word_start},{word_start+80},\\fscx130\\fscy130\\c{color})"
                    f"\\t({word_start+80},{word_end},\\fscx110\\fscy110)"
                    f"\\t({word_end},{word_end+120},\\fscx100\\fscy100\\c&H00FFFFFF)"
                )

            elif style == "wave":
                # Alternating wave colors, gentle scale
                color = wave_colors[j % len(wave_colors)]
                style_tags = (
                    f"\\t({word_start},{word_end},\\c{color}\\fscx106\\fscy106)"
                    f"\\t({word_end},{word_end+200},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "karaoke":
                # Yellow progress highlight on active word, white otherwise
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H0000FFFF\\fscx110\\fscy110)"
                    f"\\t({word_end},{word_end+150},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "stark":
                # Bold pop-in with hot-pink active word highlight
                style_tags = (
                    f"\\t({word_start},{word_start+80},\\fscx118\\fscy118\\c&H00FF69B4)"
                    f"\\t({word_start+80},{word_end},\\fscx105\\fscy105)"
                    f"\\t({word_end},{word_end+120},\\fscx100\\fscy100\\c&H00FFFFFF)"
                )

            elif style == "glitch":
                # Chromatic aberration: alternates red/cyan on each word, all-caps
                glitch_colors = ["&H000000FF", "&H00FFFF00"]  # Red, Cyan (BGR)
                color = glitch_colors[j % 2]
                word_display = escape_ass_text(word_text.upper())
                style_tags = (
                    f"\\t({word_start},{word_start+50},\\c{color}\\fscx118\\fscy118)"
                    f"\\t({word_start+50},{word_end},\\fscx105\\fscy105)"
                    f"\\t({word_end},{word_end+100},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "spotlight":
                # Single huge word, slam down with a snap, all-caps
                word_display = escape_ass_text(word_text.upper())
                style_tags = (
                    f"\\t({word_start},{word_start+100},\\fscx140\\fscy140)"
                    f"\\t({word_start+100},{word_end},\\fscx110\\fscy110)"
                    f"\\t({word_end},{word_end+100},\\fscx100\\fscy100)"
                )

            elif style == "duo":
                # Pink active word, white others, subtle pop
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H00FF69B4\\fscx112\\fscy112)"
                    f"\\t({word_end},{word_end+150},\\c&H00FFFFFF\\fscx100\\fscy100)"
                )

            elif style == "subtitle":
                # Minimal highlight — barely moves, warm white glow on active
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H00E8F4FF)"
                    f"\\t({word_end},{word_end+300},\\c&H00FFFFFF)"
                )

            elif style == "whip":
                # Hot-pink snap then spring back, fast pace
                style_tags = (
                    f"\\t({word_start},{word_start+50},\\fscx125\\fscy125\\c&H00FF1493)"
                    f"\\t({word_start+50},{word_end},\\fscx105\\fscy105)"
                    f"\\t({word_end},{word_end+100},\\fscx100\\fscy100\\c&H00FFFFFF)"
                )

            elif style == "marker":
                # Highlighter stamp: yellow base with a quick white emphasis.
                word_display = escape_ass_text(word_text.upper())
                active_color = "&H00FFFFFF" if j % 2 == 0 else "&H0000F2FF"
                style_tags = (
                    f"\\t({word_start},{word_start+65},\\fscx122\\fscy122\\c{active_color})"
                    f"\\t({word_start+65},{word_end},\\fscx106\\fscy106)"
                    f"\\t({word_end},{word_end+130},\\fscx100\\fscy100\\c&H0000F2FF)"
                )

            elif style == "signal":
                # Crisp blue pulse that reads cleanly over fast-moving footage.
                word_display = escape_ass_text(word_text.upper())
                active_color = "&H00F8BD38" if j % 2 == 0 else "&H00FA8B67"
                style_tags = (
                    f"\\t({word_start},{word_start+85},\\fscx116\\fscy116\\c{active_color})"
                    f"\\t({word_start+85},{word_end},\\fscx104\\fscy104)"
                    f"\\t({word_end},{word_end+140},\\fscx100\\fscy100\\c&H00FCFAF8)"
                )

            elif style == "prism":
                # Rotating cool-to-pink palette with a gentle kinetic pop.
                color = prism_colors[j % len(prism_colors)]
                style_tags = (
                    f"\\t({word_start},{word_start+80},\\fscx116\\fscy116\\c{color})"
                    f"\\t({word_start+80},{word_end},\\fscx105\\fscy105)"
                    f"\\t({word_end},{word_end+160},\\fscx100\\fscy100\\c&H00FFFFFF)"
                )

            elif style == "halo":
                # Lilac bloom, restrained enough for interview and podcast shorts.
                active_color = "&H00FCAAF0" if j % 2 == 0 else "&H00FC84C0"
                style_tags = (
                    f"\\t({word_start},{word_start+100},\\fscx118\\fscy118\\c{active_color})"
                    f"\\t({word_start+100},{word_end},\\fscx105\\fscy105)"
                    f"\\t({word_end},{word_end+180},\\fscx100\\fscy100\\c&H00FFFFFF)"
                )

            elif style == "ticker":
                # A lower-third scan: all caps, cyan active word, nearly no scale.
                word_display = escape_ass_text(word_text.upper())
                style_tags = (
                    f"\\t({word_start},{word_end},\\c&H00F8E867\\fscx104\\fscy104)"
                    f"\\t({word_end},{word_end+120},\\c&H00FEF2E0\\fscx100\\fscy100)"
                )

            elif style == "poster":
                # Compact title-card slam with a dark active word.
                word_display = escape_ass_text(word_text.upper())
                active_color = "&H00271811" if j % 2 == 0 else "&H00FFFFFF"
                style_tags = (
                    f"\\t({word_start},{word_start+70},\\fscx128\\fscy128\\c{active_color})"
                    f"\\t({word_start+70},{word_end},\\fscx108\\fscy108)"
                    f"\\t({word_end},{word_end+140},\\fscx100\\fscy100\\c&H00FFFFFF)"
                )

            else:
                style_tags = ""

            glow_tags = f"\\3c{glow_outline_colors.get(style, '&H00FFFFFF')}\\blur2\\bord4\\shad0" if glow else ""
            word_parts.append(f"{{{glow_tags}{style_tags}{animation_tags}}}{word_display}")

        animated_text = word_gap.join(word_parts)

        # Build a single override block so all tags are in one {…} and guaranteed to apply
        pos_tags = ""
        if pos_x is not None and pos_y is not None:
            px = int(pos_x * 1080)
            py = int(pos_y * 1920)
            pos_tags += f"\\an5\\pos({px},{py})"
        if font_size is not None:
            pos_tags += f"\\fs{int(font_size)}"
        override = "{" + pos_tags + "}" if pos_tags else ""
        lines.append(f"Dialogue: 0,{format_ass_time(start_t)},{format_ass_time(end_t)},Default,,0,0,0,,{override}{animated_text}\n")

    with open(ass_file, 'w', encoding='utf-8') as f:
        f.writelines(lines)

    return ass_file


def generate_srt_subtitles(words, offset_time=0):
    """Generate SRT subtitle file for phrase-based subtitles (TikTok/Reels style)"""
    srt_file = os.path.join(TEMP_DIR, f"subtitles_{int(offset_time*1000)}.srt")

    lines = []
    # Group words into 2-3 word phrases
    chunk_size = 2
    counter = 1

    for i in range(0, len(words), chunk_size):
        chunk = words[i:i+chunk_size]
        if not chunk:
            continue

        start_t = chunk[0]['start'] - offset_time
        end_t = chunk[-1]['end'] - offset_time

        text = " ".join([w['word'] for w in chunk])

        lines.append(f"{counter}\n")
        lines.append(f"{format_srt_time(start_t)} --> {format_srt_time(end_t)}\n")
        lines.append(f"{text}\n\n")
        counter += 1

    with open(srt_file, 'w', encoding='utf-8') as f:
        f.writelines(lines)

    return srt_file


def format_ass_time(seconds):
    """Convert seconds to ASS timestamp format (H:MM:SS.CS)"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int((seconds % 1) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def format_srt_time(seconds):
    """Convert seconds to SRT timestamp format (HH:MM:SS,mmm)"""
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def get_subtitle_filter(style, subtitle_file):
    """Return FFmpeg ASS subtitle filter — all styles now use ASS format"""
    if not subtitle_file or not os.path.exists(subtitle_file):
        return None
    escaped_path = subtitle_file.replace("\\", "\\\\").replace(":", "\\:")
    return f"ass={escaped_path}"


def detect_hdr_and_res(video_path):
    """Check if video is HDR and get resolution"""
    cmd = [
        RUNTIME_HARDWARE["ffprobe_bin"], "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=color_transfer,color_space,color_primaries,width,height", 
        "-of", "json", 
        video_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    try:
        info = json.loads(result.stdout)["streams"][0]
        is_hdr = False
        if info.get("color_transfer") in ["smpte2084", "arib-std-b67"]:
            is_hdr = True
        return is_hdr, int(info["width"]), int(info["height"])
    except (KeyError, IndexError, json.JSONDecodeError):
        # Fallback if ffprobe fails (e.g. image or weird file)
        return False, 1920, 1080

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("url", help="Video URL or File Path")
    parser.add_argument("--mode", choices=["shorts", "shorts-analyze", "shorts-more", "longform", "rerender", "longform-edit"], default="shorts")
    parser.add_argument("--upscale", action="store_true", help="Upscale to 8K")
    parser.add_argument("--subtitle-style",
                       choices=sorted(KNOWN_SUBTITLE_STYLES),
                       default="classic",
                       help="Caption style")
    parser.add_argument("--font", default=None,
                       help="Font override for subtitles (e.g. 'Anton', 'Bebas Neue', 'Oswald', 'Poppins Black')")
    parser.add_argument("--max-duration", type=int, choices=[30, 60, 90, 120, 180], default=180,
                       help="Max clip duration: 60 (<1min), 120 (up to 2min), 180 (up to 3min)")
    parser.add_argument("--start-time", type=float, default=0.0,
                       help="Optional start time (seconds) to limit analysis/render window")
    parser.add_argument("--end-time", type=float, default=-1.0,
                       help="Optional end time (seconds) to limit analysis/render window; -1 means end of video")
    parser.add_argument("--max-clips", type=int, choices=[5,10,15,20,25,30,35,40,45,50], default=None,
                       help="Max number of clips to export (5-50 in steps of 5)")
    parser.add_argument("--clip-volume", choices=["curated", "balanced", "more", "exact"], default="balanced",
                       help="Shorts yield strategy; balanced targets roughly one clip per 3 active-speech minutes")
    parser.add_argument("--target-clips", type=int, default=None,
                       help="Exact Shorts count when --clip-volume=exact (still limited by --max-clips)")
    parser.add_argument("--framing-mode", choices=["auto", "smart_switch", "dual_stack"], default="auto",
                       help="Shorts framing: auto, smart_switch, or dual_stack")
    parser.add_argument("--rerender-json", help="Path to clip metadata JSON for subtitle re-render")
    parser.add_argument("--rerender-output", help="Output path for re-rendered clip")
    parser.add_argument("--longform-json", help="Path to a saved long-form edit project")
    parser.add_argument("--longform-output", help="Output path for an edited long-form render")
    parser.add_argument("--candidate-manifest", help="Saved Shorts candidate analysis for Generate More")
    parser.add_argument("--generate-more-count", type=int, default=5,
                       help="Number of additional candidates to render from a saved analysis (1-50)")
    parser.add_argument("--candidate-ids", default="",
                       help="Comma-separated reviewed candidate IDs to render in shorts-more mode")
    parser.add_argument("--compute-device", choices=["auto", "cpu", "cuda", "rocm"],
                       default=CONFIG.get("processing", {}).get("compute_device", "auto"),
                       help="Whisper compute backend; auto prefers ROCm/CUDA over CPU")
    parser.add_argument("--video-encoder", choices=["auto", "cpu", "nvenc", "vaapi", "amf"],
                       default=CONFIG.get("processing", {}).get("video_encoder", "auto"),
                       help="FFmpeg video encoder; auto probes hardware before falling back to CPU")
    parser.add_argument("--transcription-provider", choices=["auto", "openai_whisper", "whisper_cpp", "deepgram"], default="auto",
                       help="Speech-to-text backend; auto stays local and prefers accelerated PyTorch")
    parser.add_argument("--transcription-model", choices=["tiny", "base", "small", "medium", "large-v3", "turbo"], default=None,
                       help="Override the configured local Whisper model")
    parser.add_argument("--transcription-language", default=os.environ.get("VCF_WHISPER_CPP_LANGUAGE", "auto"),
                       help="Spoken language code, or auto for language detection")
    parser.add_argument("--local-semantic", action="store_true",
                       help="Rerank shorts with a configured local OpenAI-compatible model endpoint")
    parser.add_argument("--gemini-analysis", action="store_true",
                       help="Opt in to Gemini cloud video/audio analysis for shorts")
    parser.add_argument("--vaapi-device", default=os.environ.get(
                           "VCF_VAAPI_DEVICE", CONFIG.get("processing", {}).get("vaapi_device", "/dev/dri/renderD128")
                       ),
                       help="Linux VAAPI render device")
    parser.add_argument("--export-preset", choices=["generic", "youtube_shorts", "instagram_reels", "tiktok"], default="generic",
                       help="Creator export compatibility preset")
    parser.add_argument("--output-name-template", default="{source}_{platform}_{index}_{score}",
                       help="Output filename template")
    args = parser.parse_args()
    if args.clip_volume == "exact" and not args.target_clips:
        parser.error("--target-clips is required when --clip-volume=exact")

    RUNTIME_HARDWARE.update({
        "compute_device": args.compute_device,
        "video_encoder": args.video_encoder,
        "vaapi_device": args.vaapi_device,
        "transcription_provider": args.transcription_provider,
        "transcription_model": args.transcription_model,
        "transcription_language": str(args.transcription_language or "auto").strip().lower(),
        "local_semantic": bool(args.local_semantic),
        "gemini_analysis": bool(args.gemini_analysis),
        "export_preset": args.export_preset,
        "output_name_template": args.output_name_template,
        "clip_volume": args.clip_volume,
        "target_clips": args.target_clips,
    })

    # Apply max-duration override
    if args.max_duration != 180:
        CONFIG['selection']['max_clip_duration'] = args.max_duration
        print(f"⏱️  Max clip duration set to {args.max_duration}s")

    # Apply max-clips override
    if args.max_clips is not None:
        CONFIG['selection']['max_clips_to_export'] = args.max_clips
        print(f"🎬 Max clips to export set to {args.max_clips}")
    if args.mode == "shorts":
        print(f"🎥 Framing mode: {args.framing_mode.replace('_', ' ')}")
        print(
            f"📦 Clip volume: {args.clip_volume}"
            + (f" ({args.target_clips} requested)" if args.clip_volume == "exact" else "")
        )

    # Rerender mode: re-render a clip with edited subtitles from a saved JSON
    if args.mode == "rerender" or args.rerender_json:
        if not args.rerender_json:
            print("❌ --rerender-json required for rerender mode")
            return
        with open(args.rerender_json) as f:
            meta = json.load(f)

        clip_data = {
            "start": meta["start"],
            "end": meta["end"],
            "score": meta.get("score", 0),
            "candidate_score": meta.get("candidate_score", meta.get("score", 0)),
            "reasons": meta.get("reasons", []),
            "score_breakdown": meta.get("score_breakdown", {}),
            "ranking_version": meta.get("ranking_version", "hybrid_v2"),
            "words": meta.get("words", []),
            "text": " ".join(w["word"] for w in meta.get("words", []))
        }
        subtitle_style = normalize_subtitle_style(meta.get("style", "classic"))
        subtitle_animation = normalize_subtitle_animation(meta.get("animation", "none"))
        subtitle_glow = meta.get("subtitle_glow", False) is True
        static_center = meta.get("frame_layout", meta.get("static_center", 960))
        source = meta["source"]
        sub_pos_x = meta.get("subtitle_x", None)
        sub_pos_y = meta.get("subtitle_y", None)
        sub_font_size = meta.get("subtitle_fontsize", None)
        sub_width = meta.get("subtitle_width", None)
        font_override = meta.get("font", None) or getattr(args, 'font', None)
        video_zoom = float(meta.get("video_zoom", 1.0))
        video_pan_x = float(meta.get("video_pan_x", 0.0))
        video_pan_y = float(meta.get("video_pan_y", 0.0))

        if not os.path.exists(source):
            print(f"❌ Source video not found: {source}")
            return

        output_path = args.rerender_output or os.path.join(OUTPUT_DIR, "rerendered.mp4")
        is_hdr, src_w, src_h = detect_hdr_and_res(source)

        print(f"🔄 Re-rendering with subtitles [{subtitle_style}] animation=[{subtitle_animation}] glow=[{'on' if subtitle_glow else 'off'}] font=[{font_override or 'default'}]...")
        render_clip(source, clip_data, static_center, 0, is_hdr, False, subtitle_style, subtitle_animation, subtitle_glow, output_path=output_path,
                    sub_pos_x=sub_pos_x, sub_pos_y=sub_pos_y, sub_font_size=sub_font_size,
                    bake_subtitles=True, font_override=font_override, sub_width=sub_width,
                    video_zoom=video_zoom, video_pan_x=video_pan_x, video_pan_y=video_pan_y)
        print(f"✅ Re-render complete: {output_path}")
        return

    # Long-form edit mode is deliberately lightweight: it consumes an
    # already-analyzed silence project without loading Whisper/Torch.
    if args.mode == "longform-edit":
        if not args.longform_json or not args.longform_output:
            raise ValueError("--longform-json and --longform-output are required for longform-edit mode")
        with open(args.longform_json, encoding="utf-8") as handle:
            project = json.load(handle)

        source = os.path.abspath(project.get("source") or args.url)
        if not os.path.exists(source):
            raise FileNotFoundError(f"Long-form source not found: {source}")
        source_duration = float(project.get("source_duration_sec") or probe_duration(
            source,
            ffprobe_bin=RUNTIME_HARDWARE["ffprobe_bin"],
        ))
        selected_range = project.get("selected_range") or {}
        selected_start = max(0.0, float(selected_range.get("start", 0.0)))
        selected_end = min(source_duration, float(selected_range.get("end", source_duration)))
        if selected_end <= selected_start:
            raise ValueError("The long-form selected range is empty")

        silence = project.get("silence") or {}
        silence_enabled = silence.get("enabled", True) is not False
        cuts = [dict(cut) for cut in (project.get("cuts") or [])]
        render_cuts = [dict(cut) for cut in cuts]
        if not silence_enabled:
            for cut in render_cuts:
                cut["enabled"] = False
        keep_segments = cuts_to_keep_segments(
            render_cuts,
            selected_start=selected_start,
            selected_end=selected_end,
        )
        requested_render_segments = project.get("render_segments") or []
        segments = []
        for raw_segment in requested_render_segments:
            try:
                start = float(raw_segment.get("start") if isinstance(raw_segment, dict) else raw_segment[0])
                end = float(raw_segment.get("end") if isinstance(raw_segment, dict) else raw_segment[1])
            except (TypeError, ValueError, IndexError, KeyError):
                continue
            if (
                end - start > 0.01
                and start >= selected_start - 0.001
                and end <= selected_end + 0.001
            ):
                segments.append((start, end))
        if not segments:
            segments = [(segment["start"], segment["end"]) for segment in keep_segments]
        if not segments:
            raise RuntimeError("The selected silence cuts would remove the entire long-form video")
        creative_payload = project.get("creative") or {}
        transition_plan = _normalize_longform_transitions(creative_payload, segments)
        transition_durations = _longform_transition_durations(transition_plan, len(segments))

        is_hdr, src_w, src_h = detect_hdr_and_res(source)
        output_path = os.path.abspath(args.longform_output)
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        render_longform(
            source,
            segments,
            output_path,
            is_hdr,
            src_w,
            src_h,
            bool(project.get("upscale", False)),
            audio_fade_sec=max(0.0, float(silence.get("audio_fade_sec", 0.03))),
            video_fade_sec=max(0.0, float(silence.get("video_fade_sec", 0.0))),
            normalize_audio=bool(silence.get("normalize_audio", False)),
            target_lufs=float(silence.get("target_lufs", -14.0)),
            limiter_db=float(silence.get("limiter_db", -1.5)),
            denoise=bool(silence.get("denoise", False)),
            creative=creative_payload,
        )
        summary = summarize_analysis(
            source,
            original_duration_sec=source_duration,
            selected_start=selected_start,
            selected_end=selected_end,
            cuts=render_cuts,
            threshold_db=float(silence.get("threshold_db", -35.0)),
            min_silence_sec=float(silence.get("min_silence_sec", 0.5)),
            edge_padding_sec=float(silence.get("edge_padding_sec", 0.08)),
        )
        transition_overlap = round(sum(transition_durations), 3)
        summary["transition_overlap_sec"] = transition_overlap
        finished_duration = round(
            max(0.0, float(summary["estimated_duration_sec"]) - transition_overlap),
            3,
        )
        summary["finished_duration_sec"] = finished_duration
        output_meta = {
            **project,
            **summary,
            "manifest_version": max(6, int(project.get("manifest_version") or 0)),
            "kind": "longform",
            "source": source,
            "source_duration_sec": source_duration,
            "selected_range": {"start": selected_start, "end": selected_end},
            "silence": {
                **silence,
                "enabled": silence_enabled,
                "audio_fade_sec": max(0.0, float(silence.get("audio_fade_sec", 0.03))),
                "video_fade_sec": max(0.0, float(silence.get("video_fade_sec", 0.0))),
                "normalize_audio": bool(silence.get("normalize_audio", False)),
                "target_lufs": float(silence.get("target_lufs", -14.0)),
                "limiter_db": float(silence.get("limiter_db", -1.5)),
                "denoise": bool(silence.get("denoise", False)),
            },
            "cuts": cuts,
            "creative": {
                **{
                    key: value
                    for key, value in creative_payload.items()
                    if key not in {
                        "musicPath",
                        "broll",
                        "transitions",
                        "color",
                        "multicam",
                        "colorWorkflow",
                        "renderSequence",
                    }
                },
                "broll": [
                    {key: value for key, value in item.items() if key != "path"}
                    for item in creative_payload.get("broll", [])
                    if isinstance(item, dict)
                ],
                "transitions": [
                    {
                        key: value
                        for key, value in item.items()
                        if key not in {"joinIndex", "ffmpegKind"}
                    }
                    for item in creative_payload.get("transitions", [])
                    if isinstance(item, dict)
                ],
                "color": {
                    key: value
                    for key, value in (creative_payload.get("color") or {}).items()
                    if key != "lutPath"
                },
                "colorWorkflow": {
                    **{
                        key: value
                        for key, value in (creative_payload.get("colorWorkflow") or {}).items()
                        if key != "groups"
                    },
                    "groups": [
                        {
                            **{
                                key: value
                                for key, value in group.items()
                                if key != "grade"
                            },
                            "grade": {
                                key: value
                                for key, value in (group.get("grade") or {}).items()
                                if key != "lutPath"
                            },
                        }
                        for group in (creative_payload.get("colorWorkflow") or {}).get("groups", [])
                        if isinstance(group, dict)
                    ],
                },
                "multicam": {
                    **{
                        key: value
                        for key, value in (creative_payload.get("multicam") or {}).items()
                        if key != "angles"
                    },
                    "angles": [
                        {key: value for key, value in item.items() if key != "path"}
                        for item in (creative_payload.get("multicam") or {}).get("angles", [])
                        if isinstance(item, dict)
                    ],
                },
            },
            "asset_project": project.get("asset_project"),
            "duration": finished_duration,
            "output_duration": finished_duration,
            "video_encoder": RUNTIME_HARDWARE.get("resolved_video_encoder") or "cpu",
            "compute_backend": RUNTIME_HARDWARE.get("resolved_compute", "cpu"),
        }
        sidecars = write_longform_sidecars(
            output_path,
            words=output_meta.get("words", []),
            chapters=output_meta.get("chapters", []),
            keep_segments=[
                {"start": start, "end": end, "duration": end - start}
                for start, end in segments
            ],
            transition_durations=transition_durations,
            caption_cues=(creative_payload.get("captions") or {}).get("cues"),
        )
        output_meta["sidecars"] = {
            kind: os.path.basename(sidecar_path) for kind, sidecar_path in sidecars.items()
        }
        with open(output_path.replace(".mp4", ".json"), "w", encoding="utf-8") as handle:
            json.dump(output_meta, handle, indent=2)
        print(f"✅ Long-form edit complete: {output_path}")
        return

    if args.mode == "shorts-more":
        if not args.candidate_manifest:
            raise ValueError("--candidate-manifest is required for shorts-more mode")
        render_more_from_candidate_manifest(
            args.candidate_manifest,
            args.generate_more_count,
            args,
            candidate_ids=[value.strip() for value in args.candidate_ids.split(",") if value.strip()],
        )
        return

    # 1. Download
    video_path = args.url
    if video_path.startswith("http"):
        import shutil, re as _re

        raw_url = video_path
        out_path = os.path.join(TEMP_DIR, "yt_download.mp4")
        if os.path.exists(out_path):
            os.remove(out_path)

        # --- Primary: yt-dlp (most reliable, handles age-gate, cipher changes, etc.) ---
        yt_dlp_bin = shutil.which("yt-dlp") or os.path.join(os.path.dirname(sys.executable), "yt-dlp")
        download_ok = False

        if yt_dlp_bin and os.path.exists(yt_dlp_bin):
            try:
                print(f"⬇️  Downloading via yt-dlp: {raw_url}")
                cmd = [
                    yt_dlp_bin,
                    "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/best",
                    "--merge-output-format", "mp4",
                    "--no-playlist",
                    "--no-warnings",
                    "-o", out_path,
                    raw_url
                ]
                result = subprocess.run(cmd, capture_output=False)
                if result.returncode == 0 and os.path.exists(out_path):
                    video_path = out_path
                    print(f"✅ Downloaded: {video_path}")
                    download_ok = True
                else:
                    print(f"⚠️  yt-dlp returned code {result.returncode}, trying pytubefix...")
            except Exception as e:
                print(f"⚠️  yt-dlp error: {e}, trying pytubefix...")

        # --- Fallback: pytubefix ---
        if not download_ok:
            try:
                from pytubefix import YouTube
                print(f"⬇️  Downloading via pytubefix: {raw_url}")
                yt = YouTube(raw_url)

                clean_title = "".join([c for c in yt.title if c.isalnum() or c in (' ', '-', '_')]).strip().replace(" ", "_")
                merged_filename = os.path.join(TEMP_DIR, f"{clean_title[:50]}.mp4")

                progressive_1080 = yt.streams.filter(progressive=True, file_extension='mp4', res='1080p').first()
                if progressive_1080:
                    print("  > Found progressive 1080p stream")
                    video_path = progressive_1080.download(output_path=TEMP_DIR, filename=os.path.basename(merged_filename))
                else:
                    def _res_to_int(stream):
                        try: return int((stream.resolution or '0p').replace('p', ''))
                        except Exception: return 0

                    video_candidates = sorted(list(yt.streams.filter(only_video=True, file_extension='mp4')), key=_res_to_int, reverse=True)
                    video_stream = next((s for s in video_candidates if _res_to_int(s) <= 1080), None) or (video_candidates[0] if video_candidates else None)
                    audio_stream = yt.streams.filter(only_audio=True).order_by('abr').desc().first()

                    if not video_stream or not audio_stream:
                        raise RuntimeError("Could not find compatible YouTube streams")

                    v_path = video_stream.download(output_path=TEMP_DIR, filename="yt_v_tmp.mp4")
                    a_path = audio_stream.download(output_path=TEMP_DIR, filename="yt_a_tmp.m4a")

                    print("  > Merging video + audio with re-encode for compatibility...")
                    subprocess.run([
                        RUNTIME_HARDWARE["ffmpeg_bin"], "-y", "-v", "error",
                        "-i", v_path, "-i", a_path,
                        "-c:v", "libx264", "-preset", "fast", "-crf", "18",
                        "-c:a", "aac", "-b:a", "192k",
                        merged_filename
                    ], check=True)
                    for f in [v_path, a_path]:
                        if os.path.exists(f): os.remove(f)
                    video_path = merged_filename

                print(f"✅ Downloaded: {video_path}")
                download_ok = True
            except Exception as e:
                print(f"❌ Download Failed: {e}")
                return

        if not download_ok:
            print("❌ Download Failed: all methods exhausted")
            return

    if not video_path: return
    
    # 2. Sanitize input to avoid decode errors on problematic YouTube files
    video_path = sanitize_video_for_processing(video_path)

    # 3. Analyze Source (HDR/Res)
    is_hdr, src_w, src_h = detect_hdr_and_res(video_path)

    # Resolve optional time window
    cap_tmp = cv2.VideoCapture(video_path)
    fps_tmp = cap_tmp.get(cv2.CAP_PROP_FPS) or 30
    frames_tmp = cap_tmp.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    cap_tmp.release()
    video_duration = frames_tmp / fps_tmp if fps_tmp > 0 else 0

    start_time = max(0.0, float(args.start_time or 0.0))
    end_time = float(args.end_time if args.end_time is not None else -1.0)

    # Preset helper: sentinel values >= 999997 mean "last N seconds"
    # endTime encodes the window size when > 0 (e.g. last60: start=999998, end=60)
    if start_time >= 999997 and video_duration > 0:
        window = end_time if (0 < end_time < 10000) else 180.0
        start_time = max(0.0, video_duration - window)
        end_time = video_duration

    if end_time <= 0:
        end_time = video_duration if video_duration > 0 else 1e9
    if video_duration > 0:
        end_time = min(end_time, video_duration)
    if end_time <= start_time:
        print("❌ Invalid time segment: end-time must be greater than start-time")
        return

    print(f"📊 Source: {src_w}x{src_h} | HDR: {is_hdr} | Mode: {args.mode.upper()}")
    if start_time > 0 or (video_duration > 0 and end_time < video_duration):
        print(f"🧭 Segment Window: {start_time:.1f}s → {end_time:.1f}s")

    # 4. Create Proxy
    proxy_path = create_proxy(video_path)
    
    # 4. Transcription & Segmentation
    if args.mode == "longform":
        # Longform needs ALL active speech segments (no viral scoring)
        print("🎙️ Transcribing for longform...")
        result = transcribe_source(proxy_path)

        transcript_words = collect_word_timestamps(result["segments"])
        longform_cfg = get_longform_config()
        print("🔊 Analyzing acoustic silence for the editable long-form timeline...")
        acoustic_analysis = analyze_source(
            video_path,
            threshold_db=longform_cfg["silence_threshold_db"],
            min_silence_sec=longform_cfg["min_silence_to_cut_sec"],
            edge_padding_sec=longform_cfg["edge_pad_sec"],
            selected_start=start_time,
            selected_end=end_time,
            ffmpeg_bin=RUNTIME_HARDWARE["ffmpeg_bin"],
            ffprobe_bin=RUNTIME_HARDWARE["ffprobe_bin"],
        )
        silence_cuts = [dict(cut) for cut in acoustic_analysis.get("cuts", [])]
        active_segments = [
            (float(segment["start"]), float(segment["end"]))
            for segment in acoustic_analysis.get("keep_segments", [])
        ]
        print(
            "  > Long-form removal: acoustic silencedetect,"
            f" min_silence_to_cut={longform_cfg['min_silence_to_cut_sec']:.2f}s,"
            f" edge_pad={longform_cfg['edge_pad_sec']:.2f}s,"
            f" audio_fade={longform_cfg['audio_fade_sec']:.2f}s,"
            f" video_fade={longform_cfg['video_fade_sec']:.2f}s"
        )
        if not active_segments:
            raise RuntimeError("Silence removal would remove the entire selected long-form range")
        
        # Render Master Timeline
        output_name = f"longform_master_{'8k' if args.upscale else 'native'}_{int(time.time())}.mp4"
        output_path = os.path.join(OUTPUT_DIR, output_name)
        persistent_source_path = persist_source_video(video_path)
        render_longform(
            video_path,
            active_segments,
            output_path,
            is_hdr,
            src_w,
            src_h,
            args.upscale,
            audio_fade_sec=longform_cfg["audio_fade_sec"],
            video_fade_sec=longform_cfg["video_fade_sec"],
        )
        source_duration = video_duration if video_duration > 0 else end_time
        longform_summary = summarize_analysis(
            persistent_source_path,
            original_duration_sec=source_duration,
            selected_start=start_time,
            selected_end=end_time,
            cuts=silence_cuts,
            threshold_db=longform_cfg["silence_threshold_db"],
            min_silence_sec=longform_cfg["min_silence_to_cut_sec"],
            edge_padding_sec=longform_cfg["edge_pad_sec"],
        )
        longform_meta = {
            **longform_summary,
            "manifest_version": 4,
            "kind": "longform",
            "source": persistent_source_path,
            "source_duration_sec": source_duration,
            "selected_range": {"start": start_time, "end": end_time},
            "silence": {
                "enabled": True,
                "threshold_db": longform_cfg["silence_threshold_db"],
                "min_silence_sec": longform_cfg["min_silence_to_cut_sec"],
                "edge_padding_sec": longform_cfg["edge_pad_sec"],
                "audio_fade_sec": longform_cfg["audio_fade_sec"],
                "video_fade_sec": longform_cfg["video_fade_sec"],
            },
            "cuts": silence_cuts,
            "keep_segments": [
                {"start": start, "end": end, "duration": end - start}
                for start, end in active_segments
            ],
            "duration": sum(end - start for start, end in active_segments),
            "output_duration": sum(end - start for start, end in active_segments),
            "video_encoder": RUNTIME_HARDWARE.get("resolved_video_encoder") or "cpu",
            "compute_backend": RUNTIME_HARDWARE.get("resolved_compute", "cpu"),
            "transcription_provider": RUNTIME_HARDWARE.get("resolved_transcription_provider"),
            "transcription_model": RUNTIME_HARDWARE.get("transcription_model") or CONFIG["transcription"]["model_size"],
            "topics": RUNTIME_HARDWARE.get("transcription_topics", []),
            "words": transcript_words,
            "upscale": bool(args.upscale),
        }
        sidecars = write_longform_sidecars(
            output_path,
            words=transcript_words,
            chapters=longform_meta.get("chapters", []),
            keep_segments=[{"start": start, "end": end} for start, end in active_segments],
        )
        longform_meta["sidecars"] = {
            kind: os.path.basename(sidecar_path) for kind, sidecar_path in sidecars.items()
        }
        with open(output_path.replace(".mp4", ".json"), "w", encoding="utf-8") as handle:
            json.dump(longform_meta, handle, indent=2)
        print(f"✅ Longform Export: {output_path}")
        
    else:
        # Shorts Mode — analyze_transcript handles its own Whisper call
        # (with word_timestamps=True for subtitle rendering)
        analysis_result = analyze_transcript(
            proxy_path,
            analysis_start=start_time,
            analysis_end=end_time,
        )
        clips = list(analysis_result.get("selected", []))
        reserves = list(analysis_result.get("reserves", []))

        if clips:
            persistent_source_path = persist_source_video(video_path)
            manifest_path = write_candidate_manifest(persistent_source_path, analysis_result, args)
            if args.mode == "shorts-analyze":
                print(
                    f"Review ready: {len(clips)} primary and {len(reserves)} alternate candidate(s)"
                )
                print(f"  > Candidate manifest: {manifest_path}")
                return
            print(
                f"🎯 Selected {len(clips)} Shorts with {len(reserves)} render reserve(s)."
                " Rendering the primary batch..."
            )
            subtitle_style = args.subtitle_style if hasattr(args, 'subtitle_style') else 'classic'
            exported = 0
            render_queue = [*clips, *reserves]
            desired_exports = len(clips)
            for attempt_index, clip in enumerate(render_queue):
                if exported >= desired_exports:
                    break
                candidate_id = str(clip.get("yield_id") or clip.get("id") or f"candidate-{attempt_index}")
                tier = str(clip.get("confidence_tier") or clip.get("yield_tier") or "review").replace("_", " ")
                role = "reserve backfill" if attempt_index >= len(clips) else "primary"
                print(
                    f"\n📎 Clip attempt {attempt_index + 1}/{len(render_queue)}"
                    f" | {tier.title()} | {role} | Score: {clip['score']:.1f}"
                    f" | Duration: {clip['end']-clip['start']:.1f}s"
                )
                print(f"   Reasons: {', '.join(clip.get('reasons', []))}")
                try:
                    frame_layout = analyze_speaker_layout(
                        proxy_path,
                        clip['start'],
                        sample_duration=3,
                        framing_mode=args.framing_mode,
                        clip_end_time=clip['end'],
                        clip_words=clip.get('words', []),
                    )
                    render_clip(
                        video_path,
                        clip,
                        frame_layout,
                        exported,
                        is_hdr,
                        args.upscale,
                        subtitle_style,
                        bake_subtitles=False,
                        metadata_source_path=persistent_source_path,
                    )
                    exported += 1
                    update_candidate_manifest(manifest_path, exported_id=candidate_id)
                except Exception as clip_err:
                    update_candidate_manifest(manifest_path, failed_id=candidate_id)
                    print(f"  ❌ Candidate {candidate_id} failed: {clip_err} — trying the next reserve")
            unfilled = max(0, desired_exports - exported)
            print(f"\n✅ Done! {exported}/{desired_exports} selected clips exported to {OUTPUT_DIR}/")
            if unfilled:
                print(f"  ⚠️  {unfilled} export slot(s) remain unfilled after exhausting render reserves")
            print(f"  > Candidate manifest saved for Generate More: {manifest_path}")
        else:
            print("❌ No viral clips found.")
            print(f"   Source: {src_w}x{src_h} | Window: {start_time:.1f}s-{end_time:.1f}s")
            print(
                f"   Config: min_dur={CONFIG['selection']['min_clip_duration']}s,"
                f" max_dur={CONFIG['selection']['max_clip_duration']}s,"
                f" volume={RUNTIME_HARDWARE.get('clip_volume', 'balanced')}"
            )
            print("   Tip: Check for clear speech, widen the selected time range, or use More volume.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise
    except Exception:
        print("❌ Fatal pipeline error")
        traceback.print_exc()
        sys.exit(1)
