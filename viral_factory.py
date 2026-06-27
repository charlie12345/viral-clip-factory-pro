#!/usr/bin/env python3
import os
import sys
import signal

# Fast-path: rerender only needs cv2, yaml, subprocess, json — skip ML imports
_IS_RERENDER = ('--mode' in sys.argv and
                sys.argv.index('--mode') + 1 < len(sys.argv) and
                sys.argv[sys.argv.index('--mode') + 1] == 'rerender') or \
               '--rerender-json' in sys.argv

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

# Constants
TEMP_DIR = os.path.join(_SCRIPT_DIR, "temp_processing")
OUTPUT_DIR = os.path.join(_SCRIPT_DIR, "viral_clips")
SOURCES_DIR = os.path.join(OUTPUT_DIR, "_sources")

# Ensure Dirs
if not os.path.exists(TEMP_DIR): os.makedirs(TEMP_DIR)
if not os.path.exists(OUTPUT_DIR): os.makedirs(OUTPUT_DIR)
if not os.path.exists(SOURCES_DIR): os.makedirs(SOURCES_DIR)

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
        "edge_pad_sec": max(float(cfg.get("edge_pad_sec", 0.08)), 0.0),
        "word_snap_window_sec": max(float(cfg.get("word_snap_window_sec", 0.35)), 0.0),
        "audio_fade_sec": max(float(cfg.get("audio_fade_sec", 0.03)), 0.0),
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
            words.append({
                "word": (word.get("word") or "").strip(),
                "start": start,
                "end": end,
            })
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
        _YOLO_MODEL = YOLO("yolov8n.pt")
    return _YOLO_MODEL


def detect_frame_subjects(frame, model=None):
    detections = []
    rgb_small_frame = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
    face_locations = face_recognition.face_locations(rgb_small_frame)

    for top, right, bottom, left in face_locations:
        top *= 4
        right *= 4
        bottom *= 4
        left *= 4
        detections.append({
            "cx": int((left + right) / 2),
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


def normalize_frame_layout(frame_layout, width):
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
                center = int(segment.get("center", layout.get("static_center", width // 2)))
            except Exception:
                continue
            if end <= start:
                continue
            normalized_segments.append({
                "start": round_float(max(0.0, start), 3),
                "end": round_float(max(0.0, end), 3),
                "center": int(clamp(center, 0, width)),
            })
        layout["switch_segments"] = normalized_segments
        if "static_center_ratio" in layout:
            layout["static_center"] = int(round(layout["static_center_ratio"] * width))
        elif "static_center" not in layout:
            layout["static_center"] = normalized_segments[0]["center"] if normalized_segments else width // 2
        layout["static_center"] = int(clamp(layout["static_center"], 0, width))
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

    return layout


def _dedupe_subjects(detections, width, max_subjects=8):
    subjects = []
    min_sep = max(28, width * 0.035)
    for detection in sorted(detections, key=lambda d: d.get("area", 0), reverse=True):
        cx = detection.get("cx", 0)
        if any(abs(cx - subject.get("cx", 0)) < min_sep for subject in subjects):
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
        roi_top = top + int((bottom - top) * 0.45)
        roi_bottom = bottom
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


def _merge_switch_segments(samples, clip_duration, min_segment=1.2):
    if not samples:
        return []

    segments = []
    current = {
        "start": 0.0,
        "end": samples[0]["time"],
        "side": samples[0]["side"],
        "centers": [samples[0]["center"]],
    }

    for sample in samples[1:]:
        if sample["side"] == current["side"]:
            current["end"] = sample["time"]
            current["centers"].append(sample["center"])
            continue
        current["end"] = sample["time"]
        segments.append(current)
        current = {
            "start": sample["time"],
            "end": sample["time"],
            "side": sample["side"],
            "centers": [sample["center"]],
        }
    current["end"] = clip_duration
    segments.append(current)

    merged = []
    for segment in segments:
        duration = segment["end"] - segment["start"]
        if merged and duration < min_segment:
            merged[-1]["end"] = segment["end"]
            merged[-1]["centers"].extend(segment["centers"])
        else:
            merged.append(segment)

    return [
        {
            "start": round_float(segment["start"], 3),
            "end": round_float(max(segment["end"], segment["start"] + 0.05), 3),
            "center": int(np.median(segment["centers"])),
            "side": segment["side"],
        }
        for segment in merged
        if segment["end"] > segment["start"]
    ]


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
    specificity = clamp01((len(strong_keywords) * 0.22) + (len(unique_topics) * 0.18) + (number_matches * 0.12))
    filler_penalty = clamp01((filler_ratio - 0.12) / 0.18)
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

        # Sample frames (analyze every 10th frame)
        sample_interval = max(1, int((end_frame - start_frame) / 10))

        face_sizes = []
        brightness_values = []
        motion_scores = []
        prev_frame = None
        sampled_frames = 0

        cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)

        for i in range(start_frame, end_frame, sample_interval):
            ret, frame = cap.read()
            if not ret:
                break
            sampled_frames += 1

            # Resize for faster processing
            small_frame = cv2.resize(frame, (0, 0), fx=0.25, fy=0.25)
            rgb_small = cv2.cvtColor(small_frame, cv2.COLOR_BGR2RGB)

            # 1. Face Detection
            face_locations = face_recognition.face_locations(rgb_small)
            if face_locations:
                # Get largest face size
                largest_face = max(face_locations, key=lambda f: (f[2]-f[0]) * (f[1]-f[3]))
                face_area = (largest_face[2]-largest_face[0]) * (largest_face[1]-largest_face[3])
                face_sizes.append(face_area)

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


def analyze_speaker_layout(video_path, start_time=0, sample_duration=3, framing_mode="auto", clip_end_time=None):
    """
    Detect speaker framing for shorts.
    auto: keep old behavior, stacking only when a side-by-side pair is reliable.
    smart_switch: build a time-varying crop from lower-face/body motion.
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
            print(f"  ⚠️  Speaker layout model unavailable: {e}")
            return fallback_layout

        positions = []
        face_tops = []
        left_centers = []
        right_centers = []
        sampled_frames = 0
        dual_frames = 0
        clip_duration = max(0.1, float((clip_end_time - start_time) if clip_end_time else sample_duration))
        analysis_duration = clip_duration if framing_mode == "smart_switch" else sample_duration
        sample_step_sec = 0.45 if framing_mode == "smart_switch" else max(5 / fps, 0.15)
        sample_count = max(1, int(analysis_duration / sample_step_sec))
        prev_gray = None
        switch_samples = []
        last_center = None
        last_subject_id = None

        for i in range(sample_count):
            rel_time = min(i * sample_step_sec, max(0.0, analysis_duration - 0.05))
            frame_time = start_time + rel_time
            cap.set(cv2.CAP_PROP_POS_MSEC, frame_time * 1000.0)
            ret, frame = cap.read()
            if not ret:
                break
            sampled_frames += 1

            detections = detect_frame_subjects(frame, model=model)
            if not detections:
                continue

            best_subject = detections[0]
            positions.append(best_subject["cx"])
            face_tops.append(best_subject["top"])

            subjects = _dedupe_subjects(detections, width)
            pair = _group_subjects_by_side(subjects, width)
            if pair:
                dual_frames += 1
                left_centers.append(pair[0]["cx"])
                right_centers.append(pair[-1]["cx"])

            if framing_mode == "smart_switch":
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                active_subject, motion = _choose_active_subject(subjects or [best_subject], prev_gray, gray, last_center)
                if active_subject is None:
                    active_subject = best_subject
                if motion < 0.8 and last_center is not None:
                    center = last_center
                    subject_id = last_subject_id if last_subject_id is not None else 0
                else:
                    center = active_subject["cx"]
                    subject_id = int(round(safe_div(center, max(width, 1)) * 1000))
                last_center = center
                last_subject_id = subject_id
                switch_samples.append({
                    "time": rel_time,
                    "side": subject_id,
                    "center": center,
                })
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
            switch_segments = _merge_switch_segments(switch_samples, clip_duration)
            if switch_segments:
                print(f"  > Smart speaker switch timeline: {len(switch_segments)} segment(s)")
                return {
                    "mode": "smart_switch",
                    "switch_segments": switch_segments,
                    "static_center": switch_segments[0]["center"],
                    "static_center_ratio": round_float(safe_div(switch_segments[0]["center"], width), 4),
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
        switch_segments = _merge_switch_segments(switch_samples, clip_duration)
        if switch_segments:
            print(f"  > Smart speaker switch timeline: {len(switch_segments)} segment(s)")
            return {
                "mode": "smart_switch",
                "switch_segments": switch_segments,
                "static_center": switch_segments[0]["center"],
                "static_center_ratio": round_float(safe_div(switch_segments[0]["center"], width), 4),
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


def get_static_speaker_position(video_path, start_time=0, sample_duration=3):
    return analyze_speaker_layout(video_path, start_time, sample_duration).get("static_center", 960)

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
        "ffmpeg", "-y", "-v", "error",
        "-i", video_path,
        "-vn", "-ac", "1", "-ar", "22050",
        "-f", "wav", audio_path
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0 and os.path.exists(audio_path):
        return audio_path
    print(f"  ⚠️  Audio extraction failed: {result.stderr.strip()}")
    return None


def analyze_transcript(video_path):
    """Run Whisper, generate segment candidates, then rerank merged clips."""
    print(f"🎙️ Transcribing with Whisper ({CONFIG['transcription']['model_size']})...")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _model_name = CONFIG['transcription']['model_size']
    _model_cache = os.path.expanduser(f"~/.cache/whisper/{_model_name}.pt")
    model = whisper.load_model(_model_cache if os.path.isfile(_model_cache) else _model_name, device=device)
    result = model.transcribe(video_path, verbose=False, word_timestamps=True)
    del model
    if device == "cuda":
        torch.cuda.empty_cache()

    viral_candidates = []
    audio_path_for_analysis = None
    if LIBROSA_AVAILABLE:
        print("🎵 Extracting audio for emotion analysis...")
        audio_path_for_analysis = extract_audio_for_analysis(video_path)

    print("📊 Analyzing Viral Potential (HYBRID RERANK MODE)...")
    keywords = CONFIG['keywords']
    candidate_min_score = float(CONFIG['selection'].get('candidate_min_score', 1.8))

    for seg in result["segments"]:
        duration = seg["end"] - seg["start"]
        if duration < 1.5:
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
        if candidate_score < candidate_min_score:
            continue

        words = []
        for w in seg.get("words", []):
            words.append({
                "word": w["word"].strip(),
                "start": w["start"],
                "end": w["end"],
            })

        segment_record = {
            "start": seg["start"],
            "end": seg["end"],
            "text": text,
            "words": words,
            "candidate_score": candidate_score,
            "reasons": reasons,
            "signals": signals,
        }
        viral_candidates.append({
            "start": seg["start"],
            "end": seg["end"],
            "text": text,
            "score": candidate_score,
            "candidate_score": candidate_score,
            "reasons": reasons,
            "words": words,
            "segments": [segment_record],
        })

    if audio_path_for_analysis and os.path.exists(audio_path_for_analysis):
        os.remove(audio_path_for_analysis)

    print(f"  > Found {len(viral_candidates)} candidate segments. Processing...")
    if not viral_candidates:
        return []

    final_clips = []
    min_dur = float(CONFIG['selection']['min_clip_duration'])
    max_dur = float(CONFIG['selection']['max_clip_duration'])

    def add_clip_or_split(clip):
        all_words = clip.get("words", [])
        clip["end"] = snap_to_sentence_end(all_words, clip["end"], window=3.0)
        dur = clip["end"] - clip["start"]
        if dur < min_dur:
            return
        if dur <= max_dur:
            final_clips.append(clip)
            return

        chunk_target = min(max_dur, 45)
        chunk_start = clip["start"]
        words = clip.get("words", [])
        segments = clip.get("segments", [])

        while chunk_start < clip["end"]:
            chunk_end = min(chunk_start + chunk_target, clip["end"])
            if words and chunk_end < clip["end"]:
                best_break = chunk_end
                for w in words:
                    if chunk_end - 5 <= w["end"] <= chunk_end + 5:
                        if w["word"].rstrip().endswith((".", "!", "?")):
                            best_break = w["end"]
                            break
                        best_break = w["end"]
                chunk_end = best_break

            chunk_dur = chunk_end - chunk_start
            if chunk_dur >= min_dur:
                chunk_words = [w for w in words if chunk_start <= w["start"] < chunk_end]
                chunk_segments = [seg for seg in segments if seg["end"] > chunk_start and seg["start"] < chunk_end]
                final_clips.append({
                    "start": chunk_start,
                    "end": chunk_end,
                    "text": words_to_text(chunk_words) or clip["text"][:240],
                    "score": max((seg.get("candidate_score", 0.0) for seg in chunk_segments), default=clip.get("candidate_score", 0.0)),
                    "candidate_score": max((seg.get("candidate_score", 0.0) for seg in chunk_segments), default=clip.get("candidate_score", 0.0)),
                    "reasons": clip.get("reasons", []),
                    "words": chunk_words,
                    "segments": chunk_segments or segments,
                })

            chunk_start = chunk_end

    current_clip = viral_candidates[0]
    for i in range(1, len(viral_candidates)):
        next_seg = viral_candidates[i]
        gap = next_seg["start"] - current_clip["end"]

        if gap < 1.0:
            current_clip["end"] = next_seg["end"]
            current_clip["text"] += " " + next_seg["text"]
            current_clip["candidate_score"] = max(current_clip["candidate_score"], next_seg["candidate_score"])
            current_clip["score"] = current_clip["candidate_score"]
            current_clip["reasons"] = make_reason_list({
                reason: 1.0 for reason in current_clip.get("reasons", []) + next_seg.get("reasons", [])
            })
            if current_clip.get("words") is not None and next_seg.get("words") is not None:
                current_clip["words"].extend(next_seg["words"])
            current_clip.setdefault("segments", []).extend(next_seg.get("segments", []))
        else:
            add_clip_or_split(current_clip)
            current_clip = next_seg

    add_clip_or_split(current_clip)

    reranked_clips = []
    for clip in final_clips:
        final_score, reasons, breakdown = score_clip_candidate(clip)
        clip["score"] = final_score
        clip["reasons"] = reasons
        clip["score_breakdown"] = breakdown
        clip["ranking_version"] = "hybrid_v2"
        reranked_clips.append(clip)

    reranked_clips.sort(key=lambda x: x["score"], reverse=True)

    configured_min_score = float(CONFIG['selection'].get('viral_min_score', 6.0))
    relative_floor = float(CONFIG['selection'].get('relative_score_floor', 0.6))
    min_top_keep = int(CONFIG['selection'].get('min_top_clips_to_keep', 3))
    effective_min_score = configured_min_score
    if len(reranked_clips) >= min_top_keep:
        effective_min_score = max(configured_min_score, reranked_clips[0]["score"] * relative_floor)

    filtered_clips = [clip for clip in reranked_clips if clip["score"] >= effective_min_score]
    used_threshold_fallback = False
    if not filtered_clips and reranked_clips:
        filtered_clips = reranked_clips[:min(min_top_keep, len(reranked_clips))]
        used_threshold_fallback = True

    max_clips = int(CONFIG['selection']['max_clips_to_export'])
    filtered_clips = filtered_clips[:max_clips]

    print(f"  > Exporting {len(filtered_clips)} clips from {len(viral_candidates)} candidates")
    print(f"  > Candidate threshold: {candidate_min_score:.1f} | Final threshold: {effective_min_score:.1f}")
    if used_threshold_fallback:
        print(f"  > No clips cleared the final threshold; keeping top {len(filtered_clips)} fallback clip(s)")
    if filtered_clips:
        print(f"  > Score range: {filtered_clips[0]['score']:.1f} (top) to {filtered_clips[-1]['score']:.1f} (lowest)")

    return filtered_clips

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
            "ffprobe", "-v", "error",
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
        "ffmpeg", "-y", "-v", "error",
        "-probesize", "100M", "-analyzeduration", "100M",
        "-fflags", "+discardcorrupt+genpts",
        "-err_detect", "ignore_err",
        "-i", video_path,
        "-vf", sanitize_filter,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-movflags", "+faststart",
    ]

    # Try GPU first, fall back to CPU
    for encoder, label in [("h264_nvenc", "GPU"), ("libx264", "CPU")]:
        preset = "p3" if encoder == "h264_nvenc" else "fast"
        cmd = common_flags + ["-c:v", encoder, "-preset", preset, safe_path]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                print(f"✅ Sanitized input ready ({label})")
                return safe_path
            summary = summarize_process_error(result.stderr)
            if summary:
                print(f"⚠️  {label} sanitize failed: {summary}")
            else:
                print(f"⚠️  {label} sanitize failed, trying next...")
        except Exception as e:
            print(f"⚠️  {label} sanitize error: {e}")

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
        "ffmpeg", "-y", "-v", "error",
        "-i", video_path,
        "-vf", proxy_filter,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
    ]
    attempts = [
        ("GPU", ["-c:v", "h264_nvenc", "-preset", "p1"]),
        ("CPU", ["-c:v", "libx264", "-preset", "fast", "-crf", "18"]),
    ]

    for label, encoder_args in attempts:
        cmd = common_args + encoder_args + [proxy_path]
        try:
            subprocess.run(cmd, check=True)
            if label != "GPU":
                print(f"  ⚠️  Proxy fallback in use: {label}")
            return proxy_path
        except subprocess.CalledProcessError as e:
            print(f"  ⚠️  {label} proxy encode failed (exit {e.returncode}), trying next...")

    print("  ⚠️  Proxy creation failed, using source directly")
    return video_path

def get_render_settings(is_hdr, src_w, src_h, target_upscale=False):
    """Return ffmpeg flags for HDR/SDR and Resolution"""
    flags = []
    
    # 1. Resolution (Upscale or Keep)
    target_w, target_h = src_w, src_h
    if target_upscale:
        # If active upscale requested and source is less than 8K
        if src_w < 7680:
            target_w = 7680
            target_h = int(target_w * (src_h / src_w))
            print(f"  > Upscaling to 8K ({target_w}x{target_h})...")
            
    # 2. HDR/SDR Encoding
    if is_hdr:
        print("  > Detected HDR Source. Preserving 10-bit Color.")
        # HEVC Main10 for HDR
        flags.extend([
            "-c:v", "hevc_nvenc", 
            "-pix_fmt", "p010le", 
            "-profile:v", "main10",
            "-preset", "p6", # High quality
            "-b:v", "50M"    # High bitrate for 8K/4K
        ])
        # Pass through color metadata (assuming PQ/BT2020 for now as common standard)
        flags.extend([
            "-color_primaries", "bt2020",
            "-color_trc", "smpte2084",
            "-colorspace", "bt2020nc"
        ])
    else:
        print("  > Detected SDR Source. Standard Export.")
        flags.extend([
            "-c:v", "h264_nvenc", 
            "-preset", "p6",
            "-b:v", "20M"
        ])
        
    return flags, target_w, target_h

def render_longform(source_path, segments, output_path, is_hdr, width, height, do_upscale, audio_fade_sec=0.03):
    print(f"🎬 Rendering Long Form Master: {output_path}")
    
    # Generate Encoder Flags
    enc_flags, tgt_w, tgt_h = get_render_settings(is_hdr, width, height, do_upscale)
    
    # Extract segments to temp files then concat
    segment_files = []
    print("  > Extracting segments (High Quality)...")
    if audio_fade_sec > 0:
        print(f"  > Applying {int(audio_fade_sec * 1000)}ms audio fades at segment joins")
    
    for i, (start, end) in enumerate(segments):
        duration = max(end - start, 0.0)
        if duration <= 0.01:
            continue
        seg_file = os.path.join(TEMP_DIR, f"lf_seg_{i:04d}.mp4")
        
        # Scaling filter
        vf_chain = []
        if tgt_w != width:
             vf_chain.append(f"scale={tgt_w}:{tgt_h}:flags=lanczos")
        
        # If HDR, ensure pixel format is respected if scaling
        if is_hdr and vf_chain:
             vf_chain.append("format=p010le")

        vf_flag = ["-vf", ",".join(vf_chain)] if vf_chain else []
        af_flag = []
        fade_duration = min(audio_fade_sec, max((duration / 2.0) - 0.005, 0.0))
        if fade_duration > 0:
            fade_out_start = max(duration - fade_duration, 0.0)
            af_flag = [
                "-af",
                ",".join([
                    f"afade=t=in:st=0:d={fade_duration:.3f}",
                    f"afade=t=out:st={fade_out_start:.3f}:d={fade_duration:.3f}",
                ]),
            ]

        cmd = [
            "ffmpeg", "-y", "-v", "error",
            "-ss", str(start), "-t", str(duration),
            "-i", source_path,
            *vf_flag,
            *af_flag,
            *enc_flags,
            "-c:a", "aac", "-b:a", "192k",
            seg_file
        ]
        subprocess.run(cmd, check=True)
        segment_files.append(seg_file)

    if not segment_files:
        raise RuntimeError("No longform segments were extracted after silence trimming")

    # Concat
    print("  > Stitching Master File...")
    list_path = os.path.join(TEMP_DIR, "longform_list.txt")
    with open(list_path, "w") as f:
        for sf in segment_files:
            f.write(f"file '{sf}'\n")
            
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "concat", "-safe", "0",
        "-i", list_path,
        "-c", "copy",
        output_path
    ], check=True)
    
    # Clean
    os.remove(list_path)
    for sf in segment_files:
        os.remove(sf)

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


def render_clip(video_path, clip_data, static_center, index, is_hdr, do_upscale, subtitle_style="classic", subtitle_animation="none", output_path=None, sub_pos_x=None, sub_pos_y=None, sub_font_size=None, bake_subtitles=True, font_override=None, sub_width=None, video_zoom=1.0, video_pan_x=0.0, video_pan_y=0.0, metadata_source_path=None):
    """Render a single 9:16 clip using SOURCE VIDEO with static crop and optional subtitles"""
    start_time = clip_data["start"]
    end_time = clip_data["end"]
    duration = end_time - start_time

    if output_path is None:
        filename = f"clip_{index+1}_score_{clip_data['score']:.1f}.mp4"
        output_path = os.path.join(OUTPUT_DIR, filename)
    else:
        filename = os.path.basename(output_path)
    animation_label = subtitle_animation if subtitle_animation and subtitle_animation != "none" else "none"
    print(f"🎬 Rendering Clip #{index+1}: {filename} ({duration:.1f}s) [Style: {subtitle_style}, Animation: {animation_label}]")

    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1920
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1080

    target_w, target_h = CONFIG['processing']['output_resolution']
    frame_layout = normalize_frame_layout(static_center, width)
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
        crop_w = int(height * (9 / 16))
        if crop_w > width:
            crop_w = width

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
        if layout_mode == "smart_switch" and frame_layout.get("switch_segments"):
            default_x = int(x1)
            expr = str(default_x)
            for segment in reversed(frame_layout.get("switch_segments", [])):
                center = int(segment.get("center", static_center_px))
                sx = int(clamp(center - (crop_w // 2), 0, max(0, width - crop_w)))
                start_rel = max(0.0, float(segment.get("start", 0.0)))
                end_rel = max(start_rel + 0.05, float(segment.get("end", start_rel + 0.05)))
                expr = f"if(between(t\\,{start_rel:.3f}\\,{end_rel:.3f})\\,{sx}\\,{expr})"
            crop_x = expr
            print(f"  > Smart speaker crop: {crop_w}x{height} with {len(frame_layout.get('switch_segments', []))} switch segment(s)")
        else:
            print(f"  > Static crop: {crop_w}x{height} at X={x1}")

        filters = [
            f"crop={crop_w}:{height}:{crop_x}:0",
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

    # Render with NVENC
    temp_output = os.path.join(TEMP_DIR, f"temp_clip_{index}.mp4")
    def build_render_cmd(vf_value, encoder):
        if encoder == "h264_nvenc":
            video_args = [
                "-c:v", "h264_nvenc",
                "-preset", "p7",
                "-tune", "hq",
                "-rc", "vbr",
                "-cq", "19",
                "-b:v", "15M",
                "-maxrate", "25M",
                "-bufsize", "30M",
            ]
        else:
            video_args = [
                "-c:v", "libx264",
                "-preset", "fast",
                "-crf", "18",
                "-maxrate", "25M",
                "-bufsize", "30M",
            ]

        return [
            "ffmpeg", "-y", "-v", "quiet", "-nostats", "-progress", "pipe:2",
            "-ss", str(start_time), "-t", str(duration),
            "-i", video_path,
            "-vf", vf_value,
            *video_args,
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k",
            output_path
        ]

    cmd = build_render_cmd(vf_chain, "h264_nvenc")

    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        no_sub_filters = [f for f in filters if not f.startswith("ass=")]
        vf_no_sub = ",".join(no_sub_filters) if no_sub_filters else "null"
        print(f"  ⚠️  NVENC clip render failed (exit {e.returncode})")

        cpu_vf = vf_chain
        print("  ⚠️  Retrying clip on CPU encoder with subtitles/layout intact...")
        try:
            subprocess.run(build_render_cmd(cpu_vf, "libx264"), check=True)
            print("  ✅ Clip render succeeded on CPU fallback")
        except subprocess.CalledProcessError as cpu_err:
            if bake_subtitles and subtitle_filter:
                raise
            if layout_mode != "dual_stack" and len(no_sub_filters) < len(filters):
                print(f"  ⚠️  CPU subtitle retry failed (exit {cpu_err.returncode}); retrying without subtitles...")
                subprocess.run(build_render_cmd(vf_no_sub, "libx264"), check=True)
                print("  ✅ Clip render succeeded without subtitles")
            else:
                raise

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
        "ranking_version": clip_data.get("ranking_version", "hybrid_v2"),
        "style": subtitle_style,
        "animation": subtitle_animation or "none",
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


def generate_subtitle_file(words, style, offset_time=0, pos_x=None, pos_y=None, font_size=None, font_override=None, sub_width=None, animation="none"):
    """Generate ASS subtitle file for all styles (word-by-word animation)"""
    if not words or style == "none":
        return None
    return generate_ass_subtitles(words, style, offset_time, pos_x, pos_y, font_size, font_override, sub_width, animation)


def generate_ass_subtitles(words, style, offset_time=0, pos_x=None, pos_y=None, font_size=None, font_override=None, sub_width=None, animation="none"):
    """Generate ASS subtitle file with professional animated captions"""
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
    }

    # Allowed font names — limited to the bundled open-source font set for the public repo
    ALLOWED_FONTS = {
        # Social / creator fonts
        "Montserrat Black", "Montserrat Bold", "Anton", "Bebas Neue", "Oswald Bold",
        "Poppins Black", "Poppins Bold", "Barlow Condensed Black", "Archivo Black",
        "Rajdhani Bold",
        # Compatible open-source fonts
        "Liberation Sans", "Liberation Serif", "Liberation Mono", "Liberation Sans Narrow",
        "Comic Neue",
        # Open-source alternatives
        "DejaVu Sans", "DejaVu Serif",
    }

    style_config = styles.get(style, styles["classic"])
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

    for i in range(0, len(words), chunk_size):
        chunk = words[i:i+chunk_size]
        if not chunk:
            continue

        start_t = max(0, chunk[0]['start'] - offset_time)
        end_t = max(start_t + 0.1, chunk[-1]['end'] - offset_time)

        word_parts = []
        word_gap = r"\h" if animation == "none" else r"\h\h"

        for j, w in enumerate(chunk):
            word_start = max(0, int((w['start'] - offset_time) * 1000))
            word_end = max(word_start + 1, int((w['end'] - offset_time) * 1000))
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

            else:
                style_tags = ""

            word_parts.append(f"{{{style_tags}{animation_tags}}}{word_display}")

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
        "ffprobe", "-v", "error", 
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
    parser.add_argument("--mode", choices=["shorts", "longform", "rerender"], default="shorts")
    parser.add_argument("--upscale", action="store_true", help="Upscale to 8K")
    parser.add_argument("--subtitle-style",
                       choices=["classic", "bold", "explosive", "bounce", "pulse", "clean",
                                "gold", "electric", "neon", "cinematic",
                                "shadow", "outline", "gradient", "fire", "wave",
                                "karaoke", "stark", "glitch",
                                "spotlight", "duo", "subtitle", "whip", "none"],
                       default="classic",
                       help="Caption style")
    parser.add_argument("--font", default=None,
                       help="Font override for subtitles (e.g. 'Anton', 'Bebas Neue', 'Oswald', 'Poppins Black')")
    parser.add_argument("--max-duration", type=int, choices=[30, 60, 120, 180], default=180,
                       help="Max clip duration: 60 (<1min), 120 (up to 2min), 180 (up to 3min)")
    parser.add_argument("--start-time", type=float, default=0.0,
                       help="Optional start time (seconds) to limit analysis/render window")
    parser.add_argument("--end-time", type=float, default=-1.0,
                       help="Optional end time (seconds) to limit analysis/render window; -1 means end of video")
    parser.add_argument("--max-clips", type=int, choices=[5,10,15,20,25,30,35,40,45,50], default=None,
                       help="Max number of clips to export (5-50 in steps of 5)")
    parser.add_argument("--framing-mode", choices=["auto", "smart_switch", "dual_stack"], default="auto",
                       help="Shorts framing: auto, smart_switch, or dual_stack")
    parser.add_argument("--rerender-json", help="Path to clip metadata JSON for subtitle re-render")
    parser.add_argument("--rerender-output", help="Output path for re-rendered clip")
    args = parser.parse_args()

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
        subtitle_style = meta.get("style", "classic")
        subtitle_animation = normalize_subtitle_animation(meta.get("animation", "none"))
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

        print(f"🔄 Re-rendering with subtitles [{subtitle_style}] animation=[{subtitle_animation}] font=[{font_override or 'default'}]...")
        render_clip(source, clip_data, static_center, 0, is_hdr, False, subtitle_style, subtitle_animation, output_path=output_path,
                    sub_pos_x=sub_pos_x, sub_pos_y=sub_pos_y, sub_font_size=sub_font_size,
                    bake_subtitles=True, font_override=font_override, sub_width=sub_width,
                    video_zoom=video_zoom, video_pan_x=video_pan_x, video_pan_y=video_pan_y)
        print(f"✅ Re-render complete: {output_path}")
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
                        "ffmpeg", "-y", "-v", "error",
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
        print(f"🎙️ Transcribing for longform...")
        device = "cuda" if torch.cuda.is_available() else "cpu"
        print(f"  > Using Device: {device.upper()}")
        _model_name = CONFIG['transcription']['model_size']
        _model_cache = os.path.expanduser(f"~/.cache/whisper/{_model_name}.pt")
        model = whisper.load_model(_model_cache if os.path.isfile(_model_cache) else _model_name, device=device)
        result = model.transcribe(proxy_path, verbose=False, word_timestamps=True)
        del model
        if device == "cuda":
            torch.cuda.empty_cache()

        transcript_words = collect_word_timestamps(result["segments"])
        active_segments, longform_cfg = build_longform_segments(
            result["segments"],
            start_time,
            end_time,
            words=transcript_words,
        )
        print(
            "  > Longform smoothing:"
            f" min_silence_to_cut={longform_cfg['min_silence_to_cut_sec']:.2f}s,"
            f" edge_pad={longform_cfg['edge_pad_sec']:.2f}s,"
            f" word_snap={longform_cfg['word_snap_window_sec']:.2f}s,"
            f" audio_fade={longform_cfg['audio_fade_sec']:.2f}s"
        )
        if not active_segments:
            raise RuntimeError("No active speech segments found in the selected time range")
        
        # Render Master Timeline
        output_name = f"longform_master_{'8k' if args.upscale else 'native'}.mp4"
        output_path = os.path.join(OUTPUT_DIR, output_name)
        render_longform(
            video_path,
            active_segments,
            output_path,
            is_hdr,
            src_w,
            src_h,
            args.upscale,
            audio_fade_sec=longform_cfg["audio_fade_sec"],
        )
        print(f"✅ Longform Export: {output_path}")
        
    else:
        # Shorts Mode — analyze_transcript handles its own Whisper call
        # (with word_timestamps=True for subtitle rendering)
        clips = analyze_transcript(proxy_path)

        # Apply optional segment window filter in shorts mode
        clips = [
            c for c in clips
            if c['end'] > start_time and c['start'] < end_time
        ]
        for c in clips:
            c['start'] = max(c['start'], start_time)
            c['end'] = min(c['end'], end_time)

        if clips:
            print(f"🎯 Found {len(clips)} viral clips! Rendering...")
            subtitle_style = args.subtitle_style if hasattr(args, 'subtitle_style') else 'classic'
            exported = 0
            persistent_source_path = persist_source_video(video_path)
            for i, clip in enumerate(clips):
                print(f"\n📎 Clip {i+1}/{len(clips)} | Score: {clip['score']:.1f} | Duration: {clip['end']-clip['start']:.1f}s")
                print(f"   Reasons: {', '.join(clip.get('reasons', []))}")
                frame_layout = analyze_speaker_layout(
                    proxy_path,
                    clip['start'],
                    sample_duration=3,
                    framing_mode=args.framing_mode,
                    clip_end_time=clip['end'],
                )
                try:
                    render_clip(
                        video_path,
                        clip,
                        frame_layout,
                        i,
                        is_hdr,
                        args.upscale,
                        subtitle_style,
                        bake_subtitles=False,
                        metadata_source_path=persistent_source_path,
                    )
                    exported += 1
                except Exception as clip_err:
                    print(f"  ❌ Clip {i+1} failed: {clip_err} — skipping")
            print(f"\n✅ Done! {exported}/{len(clips)} clips exported to {OUTPUT_DIR}/")
        else:
            print("❌ No viral clips found.")
            print(f"   Source: {src_w}x{src_h} | Window: {start_time:.1f}s-{end_time:.1f}s")
            print(f"   Config: min_dur={CONFIG['selection']['min_clip_duration']}s, max_dur={CONFIG['selection']['max_clip_duration']}s, min_score={CONFIG['selection']['viral_min_score']}")
            print("   Tip: Check if the video has clear speech or widen the selected time segment.")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise
    except Exception:
        print("❌ Fatal pipeline error")
        traceback.print_exc()
        sys.exit(1)
