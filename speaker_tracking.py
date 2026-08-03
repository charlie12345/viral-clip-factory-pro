"""Temporal talking-head tracking for smart portrait crops.

The image pipeline is intentionally kept outside this module.  Callers detect
faces and measure lower-face motion, then feed those small dictionaries to
``SmartSpeakerTracker.update``.  Keeping the state machine independent from
OpenCV makes its camera-off and speaker-switch behaviour deterministic and
easy to regression test.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from math import hypot, isfinite
from statistics import median
from typing import Deque, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


Number = float | int
Subject = Mapping[str, object]
SpeakerSample = Dict[str, object]


@dataclass(frozen=True)
class TrackingConfig:
    """Tuning values expressed in sampled frames unless noted otherwise."""

    mouth_motion_threshold: float = 0.8
    live_window_samples: int = 6
    live_min_face_samples: int = 3
    live_min_motion_hits: int = 2
    center_history_samples: int = 5
    switch_confirm_samples: int = 2
    switch_motion_margin: float = 0.25
    diarization_confirm_samples: int = 2
    diarization_remap_samples: int = 3
    diarization_min_confidence: float = 0.55
    min_switch_interval_sec: float = 0.75
    hold_missing_sec: float = 2.5
    prune_after_sec: float = 6.0
    horizontal_match_ratio: float = 0.08
    vertical_match_ratio: float = 0.10
    max_horizontal_match_ratio: float = 0.14
    max_vertical_match_ratio: float = 0.18
    minimum_match_px: float = 42.0
    crop_face_height_multiplier: float = 4.2
    minimum_crop_height_ratio: float = 0.45
    maximum_crop_height_ratio: float = 1.0

    def __post_init__(self) -> None:
        positive_ints = {
            "live_window_samples": self.live_window_samples,
            "live_min_face_samples": self.live_min_face_samples,
            "live_min_motion_hits": self.live_min_motion_hits,
            "center_history_samples": self.center_history_samples,
            "switch_confirm_samples": self.switch_confirm_samples,
            "diarization_confirm_samples": self.diarization_confirm_samples,
            "diarization_remap_samples": self.diarization_remap_samples,
        }
        for name, value in positive_ints.items():
            if value < 1:
                raise ValueError(f"{name} must be at least 1")
        if self.live_min_motion_hits > self.live_window_samples:
            raise ValueError("live_min_motion_hits cannot exceed live_window_samples")
        if self.live_min_face_samples > self.live_window_samples:
            raise ValueError("live_min_face_samples cannot exceed live_window_samples")
        if self.mouth_motion_threshold < 0:
            raise ValueError("mouth_motion_threshold cannot be negative")
        if not 0.0 <= self.diarization_min_confidence <= 1.0:
            raise ValueError("diarization_min_confidence must be between 0 and 1")
        if self.hold_missing_sec < 0 or self.prune_after_sec <= 0:
            raise ValueError("track retention times must be non-negative")
        if not 0 < self.minimum_crop_height_ratio <= self.maximum_crop_height_ratio <= 1.0:
            raise ValueError("crop height ratios must satisfy 0 < minimum <= maximum <= 1")


@dataclass
class _Observation:
    cx: float
    cy: float
    left: float
    right: float
    top: float
    bottom: float
    area: float
    kind: str
    motion: float

    @property
    def width(self) -> float:
        return max(1.0, self.right - self.left)

    @property
    def height(self) -> float:
        return max(1.0, self.bottom - self.top)


@dataclass
class _Track:
    track_id: int
    created_at: float
    last_seen_at: float
    centers: Deque[Tuple[float, float]]
    crop_heights: Deque[float]
    mouth_motion: Deque[float]
    width: float
    height: float
    last_motion: float = 0.0
    motion_ema: float = 0.0
    face_samples: int = 0
    verified_live: bool = False
    seen_this_sample: bool = True
    last_kind: str = "face"

    @property
    def center(self) -> Tuple[float, float]:
        return (
            float(median(point[0] for point in self.centers)),
            float(median(point[1] for point in self.centers)),
        )

    @property
    def suggested_crop_height(self) -> float:
        return float(median(self.crop_heights))

    @property
    def motion_hits(self) -> int:
        return sum(1 for value in self.mouth_motion if value > 0.0)


def _as_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _normalise_subject(subject: Subject) -> Optional[_Observation]:
    left = _as_float(subject.get("left"))
    right = _as_float(subject.get("right"))
    top = _as_float(subject.get("top"))
    bottom = _as_float(subject.get("bottom"))
    if right <= left or bottom <= top:
        return None

    cx = _as_float(subject.get("cx"), (left + right) / 2.0)
    cy = _as_float(subject.get("cy"), (top + bottom) / 2.0)
    kind = str(subject.get("kind", "")).strip().lower()
    motion = max(0.0, _as_float(subject.get("motion")))
    area = max(1.0, _as_float(subject.get("area"), (right - left) * (bottom - top)))
    return _Observation(cx, cy, left, right, top, bottom, area, kind, motion)


class SmartSpeakerTracker:
    """Track verified talking heads and debounce the active-speaker crop.

    A track can only be created by a face observation.  It becomes eligible
    after multiple lower-face motion hits in a rolling window, preventing a
    static camera-off avatar from becoming a crop target merely because it is
    large.  Once verified, it remains available through ordinary speech pauses.
    """

    def __init__(
        self,
        frame_width: Number,
        frame_height: Number,
        config: Optional[TrackingConfig] = None,
    ) -> None:
        self.frame_width = max(1.0, float(frame_width))
        self.frame_height = max(1.0, float(frame_height))
        self.config = config or TrackingConfig()
        self._tracks: Dict[int, _Track] = {}
        self._next_track_id = 1
        self._current_track_id: Optional[int] = None
        self._switch_candidate_id: Optional[int] = None
        self._switch_candidate_count = 0
        self._last_switch_at = float("-inf")
        self._last_update_at = float("-inf")
        self._speaker_to_track: Dict[str, int] = {}
        self._speaker_mapping_evidence: Dict[str, Tuple[int, int, float]] = {}

    @property
    def current_track_id(self) -> Optional[int]:
        return self._current_track_id

    @property
    def speaker_track_map(self) -> Dict[str, int]:
        """Return the learned diarization-label to visual-track mapping."""

        return dict(self._speaker_to_track)

    def reset(self) -> None:
        self._tracks.clear()
        self._next_track_id = 1
        self._current_track_id = None
        self._switch_candidate_id = None
        self._switch_candidate_count = 0
        self._last_switch_at = float("-inf")
        self._last_update_at = float("-inf")
        self._speaker_to_track.clear()
        self._speaker_mapping_evidence.clear()

    @staticmethod
    def _speaker_key(speaker_label: object) -> Optional[str]:
        if speaker_label is None:
            return None
        key = str(speaker_label).strip().casefold()
        return key or None

    def preferred_track_for_speaker(self, speaker_label: object) -> Optional[int]:
        """Resolve a diarization label only while its visual track is valid."""

        key = self._speaker_key(speaker_label)
        if key is None:
            return None
        track_id = self._speaker_to_track.get(key)
        if track_id is None:
            return None
        track = self._tracks.get(track_id) if track_id is not None else None
        if track is None or not track.verified_live:
            self._speaker_to_track.pop(key, None)
            self._speaker_mapping_evidence.pop(key, None)
            return None
        return track_id

    def update(
        self,
        time_sec: Number,
        subjects: Iterable[Subject],
        preferred_track_id: Optional[int] = None,
        speaker_label: object = None,
        speaker_confidence: object = None,
    ) -> Optional[SpeakerSample]:
        """Consume one sampled frame and return its stable active-speaker sample.

        Input subjects must contain ``cx``, ``cy``, ``left``, ``right``,
        ``top``, ``bottom``, ``area``, ``kind`` and a lower-face ``motion``
        score.  Invalid boxes are ignored.  A diarization ``speaker_label`` is
        learned from unambiguous mouth-motion evidence and then resolved to a
        visual ``preferred_track_id``; explicit track preferences still win.
        ``None`` means no live camera has yet accumulated enough motion evidence.
        """

        now = float(time_sec)
        if now < self._last_update_at:
            raise ValueError("speaker samples must be supplied in time order")
        self._last_update_at = now

        observations = [item for item in (_normalise_subject(s) for s in subjects) if item]
        for track in self._tracks.values():
            track.seen_this_sample = False
            track.last_motion = 0.0

        matches, unmatched = self._associate(observations)
        for track_id, observation in matches:
            self._update_track(self._tracks[track_id], observation, now)

        # Person boxes can maintain an existing face-origin track, but can
        # never create or qualify one on their own.
        for observation in unmatched:
            if observation.kind == "face":
                self._create_track(observation, now)

        self._prune(now)
        diarization_trusted = True
        if speaker_confidence is not None:
            try:
                parsed_speaker_confidence = float(speaker_confidence)
                diarization_trusted = (
                    isfinite(parsed_speaker_confidence)
                    and parsed_speaker_confidence >= self.config.diarization_min_confidence
                )
            except (TypeError, ValueError):
                diarization_trusted = False
        resolved_preference = preferred_track_id
        if resolved_preference is None and diarization_trusted:
            resolved_preference = self.preferred_track_for_speaker(speaker_label)
        self._select_active_track(now, preferred_track_id=resolved_preference)
        learned_track_id = self._observe_diarized_speaker(
            speaker_label if diarization_trusted else None,
            now,
        )
        if preferred_track_id is None and learned_track_id is not None:
            self._select_active_track(now, preferred_track_id=learned_track_id)
        track = self._tracks.get(self._current_track_id) if self._current_track_id else None
        if track is None or not track.verified_live:
            return None

        missing_for = max(0.0, now - track.last_seen_at)
        if missing_for > self.config.hold_missing_sec:
            self._current_track_id = None
            self._reset_switch_candidate()
            return None
        sample = self._sample_from_track(track, now, held=not track.seen_this_sample)
        if speaker_label is not None:
            sample["speaker"] = speaker_label
        if speaker_confidence is not None:
            try:
                confidence = float(speaker_confidence)
            except (TypeError, ValueError):
                confidence = None
            if confidence is not None and isfinite(confidence):
                sample["speaker_confidence"] = max(0.0, min(1.0, confidence))
        return sample

    def _observe_diarized_speaker(self, speaker_label: object, now: float) -> Optional[int]:
        """Learn or carefully repair a label mapping from visible mouth motion."""

        key = self._speaker_key(speaker_label)
        if key is None:
            return None
        visible_live = [
            track
            for track in self._tracks.values()
            if track.verified_live
            and track.seen_this_sample
            and track.last_kind == "face"
            and track.last_motion >= self.config.mouth_motion_threshold
        ]
        if not visible_live:
            return self.preferred_track_for_speaker(speaker_label)

        ranked = sorted(visible_live, key=self._speaker_score, reverse=True)
        best = ranked[0]
        if (
            len(ranked) > 1
            and self._speaker_score(best) - self._speaker_score(ranked[1])
            < self.config.switch_motion_margin
        ):
            self._speaker_mapping_evidence.pop(key, None)
            return self.preferred_track_for_speaker(speaker_label)

        existing = self.preferred_track_for_speaker(speaker_label)
        if existing == best.track_id:
            self._speaker_mapping_evidence.pop(key, None)
            return existing

        previous = self._speaker_mapping_evidence.get(key)
        if (
            previous is not None
            and previous[0] == best.track_id
            and now - previous[2] <= max(1.5, self.config.min_switch_interval_sec * 2.0)
        ):
            evidence_count = previous[1] + 1
        else:
            evidence_count = 1
        self._speaker_mapping_evidence[key] = (best.track_id, evidence_count, now)

        occupied_by_other_label = any(
            label != key and track_id == best.track_id
            for label, track_id in self._speaker_to_track.items()
        )
        needed = (
            self.config.diarization_remap_samples
            if existing is not None or occupied_by_other_label
            else self.config.diarization_confirm_samples
        )
        if evidence_count < needed:
            return existing

        for label, track_id in list(self._speaker_to_track.items()):
            if label != key and track_id == best.track_id:
                del self._speaker_to_track[label]
        self._speaker_to_track[key] = best.track_id
        self._speaker_mapping_evidence.pop(key, None)
        return best.track_id

    def track_snapshots(self) -> List[Dict[str, object]]:
        """Return read-only diagnostics useful to callers and tests."""

        snapshots = []
        for track in sorted(self._tracks.values(), key=lambda value: value.track_id):
            cx, cy = track.center
            snapshots.append(
                {
                    "track_id": track.track_id,
                    "center_x": int(round(cx)),
                    "center_y": int(round(cy)),
                    "verified_live": track.verified_live,
                    "face_samples": track.face_samples,
                    "motion_hits": track.motion_hits,
                    "last_motion": round(track.last_motion, 4),
                    "seen": track.seen_this_sample,
                    "suggested_crop_height": int(round(track.suggested_crop_height)),
                }
            )
        return snapshots

    def _associate(
        self, observations: Sequence[_Observation]
    ) -> Tuple[List[Tuple[int, _Observation]], List[_Observation]]:
        candidates: List[Tuple[float, int, int]] = []
        for track_id, track in self._tracks.items():
            tx, ty = track.center
            for observation_index, observation in enumerate(observations):
                x_limit = max(
                    self.config.minimum_match_px,
                    self.frame_width * self.config.horizontal_match_ratio,
                    min(
                        max(track.width, observation.width) * 1.1,
                        self.frame_width * self.config.max_horizontal_match_ratio,
                    ),
                )
                y_limit = max(
                    self.config.minimum_match_px,
                    self.frame_height * self.config.vertical_match_ratio,
                    min(
                        max(track.height, observation.height) * 1.1,
                        self.frame_height * self.config.max_vertical_match_ratio,
                    ),
                )
                dx = abs(observation.cx - tx)
                dy = abs(observation.cy - ty)
                if dx > x_limit or dy > y_limit:
                    continue
                distance = hypot(dx / x_limit, dy / y_limit)
                if distance <= 1.0:
                    candidates.append((distance, track_id, observation_index))

        matches: List[Tuple[int, _Observation]] = []
        used_tracks = set()
        used_observations = set()
        for _, track_id, observation_index in sorted(candidates):
            if track_id in used_tracks or observation_index in used_observations:
                continue
            matches.append((track_id, observations[observation_index]))
            used_tracks.add(track_id)
            used_observations.add(observation_index)
        unmatched = [item for index, item in enumerate(observations) if index not in used_observations]
        return matches, unmatched

    def _suggest_crop_height(self, observation: _Observation) -> float:
        target = observation.height * self.config.crop_face_height_multiplier
        minimum = self.frame_height * self.config.minimum_crop_height_ratio
        maximum = self.frame_height * self.config.maximum_crop_height_ratio
        return min(maximum, max(minimum, target))

    def _create_track(self, observation: _Observation, now: float) -> None:
        track_id = self._next_track_id
        self._next_track_id += 1
        centers: Deque[Tuple[float, float]] = deque(maxlen=self.config.center_history_samples)
        centers.append((observation.cx, observation.cy))
        crop_heights: Deque[float] = deque(maxlen=self.config.center_history_samples)
        crop_heights.append(self._suggest_crop_height(observation))
        motion_history: Deque[float] = deque(maxlen=self.config.live_window_samples)
        motion_history.append(
            observation.motion if observation.motion >= self.config.mouth_motion_threshold else 0.0
        )
        self._tracks[track_id] = _Track(
            track_id=track_id,
            created_at=now,
            last_seen_at=now,
            centers=centers,
            crop_heights=crop_heights,
            mouth_motion=motion_history,
            width=observation.width,
            height=observation.height,
            last_motion=observation.motion,
            motion_ema=observation.motion,
            face_samples=1,
            seen_this_sample=True,
            last_kind="face",
        )
        self._refresh_live_status(self._tracks[track_id])

    def _update_track(self, track: _Track, observation: _Observation, now: float) -> None:
        track.centers.append((observation.cx, observation.cy))
        track.last_seen_at = now
        track.width = observation.width
        track.height = observation.height
        track.last_motion = observation.motion
        track.motion_ema = (track.motion_ema * 0.55) + (observation.motion * 0.45)
        track.seen_this_sample = True
        track.last_kind = observation.kind
        if observation.kind == "face":
            track.face_samples += 1
            track.mouth_motion.append(
                observation.motion if observation.motion >= self.config.mouth_motion_threshold else 0.0
            )
            track.crop_heights.append(self._suggest_crop_height(observation))
            self._refresh_live_status(track)

    def _refresh_live_status(self, track: _Track) -> None:
        if track.verified_live:
            return
        enough_faces = track.face_samples >= self.config.live_min_face_samples
        enough_motion = track.motion_hits >= self.config.live_min_motion_hits
        track.verified_live = enough_faces and enough_motion

    def _prune(self, now: float) -> None:
        stale = [
            track_id
            for track_id, track in self._tracks.items()
            if now - track.last_seen_at > self.config.prune_after_sec
            and track_id != self._current_track_id
        ]
        for track_id in stale:
            del self._tracks[track_id]
            for label, mapped_track_id in list(self._speaker_to_track.items()):
                if mapped_track_id == track_id:
                    del self._speaker_to_track[label]
                    self._speaker_mapping_evidence.pop(label, None)

    def _select_active_track(self, now: float, preferred_track_id: Optional[int] = None) -> None:
        current = self._tracks.get(self._current_track_id) if self._current_track_id else None
        visible_live = [
            track
            for track in self._tracks.values()
            if track.verified_live and track.seen_this_sample
        ]

        preferred = next(
            (track for track in visible_live if track.track_id == preferred_track_id),
            None,
        )
        if (
            preferred is not None
            and preferred.track_id != self._current_track_id
            and now - self._last_switch_at >= self.config.min_switch_interval_sec
        ):
            self._current_track_id = preferred.track_id
            self._last_switch_at = now
            self._reset_switch_candidate()
            return

        if current is None or now - current.last_seen_at > self.config.hold_missing_sec:
            self._current_track_id = None
            self._reset_switch_candidate()
            if visible_live:
                selected = max(visible_live, key=self._speaker_score)
                self._current_track_id = selected.track_id
                self._last_switch_at = now
            return

        challengers = [
            track
            for track in visible_live
            if track.track_id != current.track_id
            and track.last_kind == "face"
            and track.last_motion >= self.config.mouth_motion_threshold
        ]
        if not challengers or now - self._last_switch_at < self.config.min_switch_interval_sec:
            self._reset_switch_candidate()
            return

        challenger = max(challengers, key=self._speaker_score)
        current_motion = current.last_motion if current.seen_this_sample else 0.0
        if self._speaker_score(challenger) < current_motion + self.config.switch_motion_margin:
            self._reset_switch_candidate()
            return

        if self._switch_candidate_id == challenger.track_id:
            self._switch_candidate_count += 1
        else:
            self._switch_candidate_id = challenger.track_id
            self._switch_candidate_count = 1

        if self._switch_candidate_count >= self.config.switch_confirm_samples:
            self._current_track_id = challenger.track_id
            self._last_switch_at = now
            self._reset_switch_candidate()

    @staticmethod
    def _speaker_score(track: _Track) -> float:
        return track.last_motion + (track.motion_ema * 0.2)

    def _reset_switch_candidate(self) -> None:
        self._switch_candidate_id = None
        self._switch_candidate_count = 0

    @staticmethod
    def _sample_from_track(track: _Track, now: float, held: bool) -> SpeakerSample:
        center_x, center_y = track.center
        crop_height = track.suggested_crop_height
        return {
            "time": round(now, 6),
            "track_id": track.track_id,
            # Compatibility aliases make this a drop-in replacement for the
            # previous smart-switch sample/segment shape.
            "side": track.track_id,
            "center": int(round(center_x)),
            "center_x": int(round(center_x)),
            "center_y": int(round(center_y)),
            "suggested_crop_height": int(round(crop_height)),
            "crop_height": int(round(crop_height)),
            "motion": round(track.last_motion, 4),
            "verified_live": True,
            "visible": track.seen_this_sample,
            "held": held,
        }


def build_diarization_timeline(
    words: Iterable[Mapping[str, object]],
    clip_start: Number = 0.0,
    clip_end: Optional[Number] = None,
) -> List[Dict[str, object]]:
    """Normalize labeled word times to the source timeline for one clip.

    Most pipeline words already use source-absolute timestamps.  Relative word
    lists from external callers are detected when they overlap the clip's
    zero-based duration more strongly than its source range.
    """

    start_bound = max(0.0, float(clip_start))
    end_bound = float(clip_end) if clip_end is not None else float("inf")
    if end_bound <= start_bound:
        return []

    parsed: List[Dict[str, object]] = []
    for word in words or []:
        if not isinstance(word, Mapping) or word.get("speaker") is None:
            continue
        try:
            start = float(word.get("start", 0.0))
            end = float(word.get("end", start))
        except (TypeError, ValueError):
            continue
        if not isfinite(start) or not isfinite(end) or end <= start:
            continue
        cue: Dict[str, object] = {
            "start": start,
            "end": end,
            "speaker": word["speaker"],
        }
        if word.get("speaker_confidence") is not None:
            try:
                confidence = float(word["speaker_confidence"])
                if isfinite(confidence):
                    cue["speaker_confidence"] = max(0.0, min(1.0, confidence))
            except (TypeError, ValueError):
                pass
        parsed.append(cue)
    if not parsed:
        return []

    offset = 0.0
    finite_end = end_bound != float("inf")
    if finite_end:
        duration = end_bound - start_bound
        absolute_hits = sum(
            1 for cue in parsed if float(cue["end"]) > start_bound and float(cue["start"]) < end_bound
        )
        relative_hits = sum(
            1 for cue in parsed if float(cue["end"]) > 0.0 and float(cue["start"]) < duration
        )
        if start_bound > 0.0 and relative_hits > absolute_hits:
            offset = start_bound

    timeline: List[Dict[str, object]] = []
    for cue in parsed:
        start = float(cue["start"]) + offset
        end = float(cue["end"]) + offset
        if end <= start_bound or (finite_end and start >= end_bound):
            continue
        normalized = dict(cue)
        normalized["start"] = max(start_bound, start)
        normalized["end"] = min(end_bound, end) if finite_end else end
        if float(normalized["end"]) > float(normalized["start"]):
            timeline.append(normalized)
    timeline.sort(key=lambda cue: (float(cue["start"]), float(cue["end"])))
    return timeline


def diarization_cue_at_time(
    timeline: Sequence[Mapping[str, object]],
    time_sec: Number,
    tolerance_sec: Number = 0.65,
) -> Optional[Dict[str, object]]:
    """Return the active or nearest diarized word around a sampled frame."""

    now = float(time_sec)
    tolerance = max(0.0, float(tolerance_sec))
    if not isfinite(now) or not isfinite(tolerance):
        return None
    candidates: List[Tuple[float, float, int, Mapping[str, object]]] = []
    for index, cue in enumerate(timeline or []):
        try:
            start = float(cue["start"])
            end = float(cue["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if start <= now <= end:
            distance = 0.0
        elif now < start:
            distance = start - now
        else:
            distance = now - end
        if distance > tolerance:
            continue
        confidence = _as_float(cue.get("speaker_confidence"), -1.0)
        if not isfinite(confidence):
            confidence = -1.0
        candidates.append((distance, -confidence, index, cue))
    if not candidates:
        return None
    return dict(min(candidates, key=lambda item: item[:3])[3])


def merge_speaker_samples(
    samples: Iterable[SpeakerSample],
    clip_duration: Number,
    min_segment_sec: float = 1.2,
    timeline_start: float = 0.0,
) -> List[Dict[str, object]]:
    """Turn selected-speaker samples into contiguous crop segments.

    Short runs are suppressed without adding their coordinates to a different
    track.  This invariant prevents a one-frame switch between subjects at
    x=550 and x=1320 from producing a bogus crop around their midpoint.
    """

    end_time = max(float(timeline_start), float(clip_duration))
    ordered = sorted(
        (sample for sample in samples if sample.get("track_id") is not None),
        key=lambda sample: _as_float(sample.get("time")),
    )
    if not ordered or end_time <= timeline_start:
        return []

    groups: List[Dict[str, object]] = []
    for sample in ordered:
        track_id = int(sample["track_id"])
        sample_time = min(end_time, max(float(timeline_start), _as_float(sample.get("time"))))
        if not groups:
            groups.append(
                {"start": float(timeline_start), "end": sample_time, "track_id": track_id, "samples": [sample]}
            )
        elif groups[-1]["track_id"] == track_id:
            groups[-1]["end"] = sample_time
            groups[-1]["samples"].append(sample)
        else:
            groups[-1]["end"] = sample_time
            groups.append(
                {"start": sample_time, "end": sample_time, "track_id": track_id, "samples": [sample]}
            )
    groups[-1]["end"] = end_time

    min_duration = max(0.0, float(min_segment_sec))
    changed = True
    while changed and len(groups) > 1:
        changed = False
        for index, group in enumerate(groups):
            if float(group["end"]) - float(group["start"]) >= min_duration:
                continue

            if 0 < index < len(groups) - 1 and groups[index - 1]["track_id"] == groups[index + 1]["track_id"]:
                left = groups[index - 1]
                right = groups[index + 1]
                # Coordinates from the discarded identity are deliberately
                # excluded; only same-track observations are combined.
                left["end"] = right["end"]
                left["samples"].extend(right["samples"])
                del groups[index : index + 2]
            elif index == 0:
                groups[1]["start"] = group["start"]
                del groups[0]
            else:
                groups[index - 1]["end"] = group["end"]
                del groups[index]
            changed = True
            break

        # Suppression can make equal identities adjacent.
        merged: List[Dict[str, object]] = []
        for group in groups:
            if merged and merged[-1]["track_id"] == group["track_id"]:
                merged[-1]["end"] = group["end"]
                merged[-1]["samples"].extend(group["samples"])
            else:
                merged.append(group)
        groups = merged

    segments = []
    for group in groups:
        start = float(group["start"])
        end = float(group["end"])
        if end <= start:
            continue
        identity_samples = group["samples"]
        center_x = int(round(median(_as_float(item.get("center_x"), _as_float(item.get("center"))) for item in identity_samples)))
        center_y = int(round(median(_as_float(item.get("center_y")) for item in identity_samples)))
        crop_height = int(
            round(
                median(
                    _as_float(item.get("suggested_crop_height"), _as_float(item.get("crop_height")))
                    for item in identity_samples
                )
            )
        )
        track_id = int(group["track_id"])
        speaker_samples = [item for item in identity_samples if item.get("speaker") is not None]
        speaker_fields: Dict[str, object] = {}
        if speaker_samples:
            labels: Dict[str, Dict[str, object]] = {}
            for sample in speaker_samples:
                key = str(sample["speaker"]).strip().casefold()
                if not key:
                    continue
                entry = labels.setdefault(
                    key,
                    {"speaker": sample["speaker"], "count": 0, "confidences": []},
                )
                entry["count"] = int(entry["count"]) + 1
                if sample.get("speaker_confidence") is not None:
                    try:
                        entry["confidences"].append(float(sample["speaker_confidence"]))
                    except (TypeError, ValueError):
                        pass
            if labels:
                dominant = max(labels.values(), key=lambda entry: int(entry["count"]))
                speaker_fields["speaker"] = dominant["speaker"]
                if len(labels) > 1:
                    speaker_fields["speakers"] = [entry["speaker"] for entry in labels.values()]
                confidences = dominant["confidences"]
                if confidences:
                    speaker_fields["speaker_confidence"] = round(
                        float(median(confidences)),
                        4,
                    )
        segments.append(
            {
                "start": round(start, 3),
                "end": round(end, 3),
                "track_id": track_id,
                "side": track_id,
                "center": center_x,
                "center_x": center_x,
                "center_y": center_y,
                "suggested_crop_height": crop_height,
                "crop_height": crop_height,
                **speaker_fields,
                **(
                    {
                        "crop_top": int(
                            round(
                                median(
                                    _as_float(item.get("crop_top"))
                                    for item in identity_samples
                                    if item.get("crop_top") is not None
                                )
                            )
                        )
                    }
                    if any(item.get("crop_top") is not None for item in identity_samples)
                    else {}
                ),
            }
        )
    return segments


# A concise alias for integrations that do not need the "smart" qualifier.
SpeakerTracker = SmartSpeakerTracker
build_switch_timeline = merge_speaker_samples


__all__ = [
    "SpeakerTracker",
    "SmartSpeakerTracker",
    "TrackingConfig",
    "build_diarization_timeline",
    "build_switch_timeline",
    "diarization_cue_at_time",
    "merge_speaker_samples",
]
