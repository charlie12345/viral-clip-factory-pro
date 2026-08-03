"""Pure selection helpers for producing a useful batch of Shorts.

This module deliberately has no media, ML, or application dependencies.  It
turns already-scored clip dictionaries into a duration-aware primary batch and
a reserve queue that can backfill failed renders.
"""

from __future__ import annotations

import copy
import math
import re
from collections.abc import Mapping, Sequence
from typing import Any


VOLUME_MINUTES_PER_CLIP = {
    "curated": 5.0,
    "balanced": 3.0,
    "more": 2.0,
}

CONFIDENCE_THRESHOLDS = {
    "best": 6.5,
    "strong": 5.2,
    "review": 4.3,
}

DEFAULT_MAX_CLIPS = 30
HARD_MAX_CLIPS = 50
DEFAULT_SOFT_MIN_RATIO = 0.65
STORY_IOU_THRESHOLD = 0.2
STORY_OVERLAP_THRESHOLD = 0.35
STORY_ADJACENT_GAP_SECONDS = 12.0

_STORY_STOP_WORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for",
    "from", "had", "has", "have", "he", "her", "his", "i", "if", "in",
    "is", "it", "its", "me", "my", "of", "on", "or", "our", "she",
    "so", "that", "the", "their", "them", "they", "this", "to", "was",
    "we", "were", "what", "when", "where", "which", "who", "will", "with",
    "you", "your",
}


def transcript_for_analysis_range(
    transcript: Mapping[str, Any] | None,
    analysis_start: Any = 0.0,
    analysis_end: Any = None,
) -> dict[str, Any]:
    """Clip transcript segments and word timings before candidate scoring."""
    output = dict(transcript or {})
    start_bound = max(0.0, float(analysis_start or 0.0))
    end_bound = float("inf") if analysis_end is None else float(analysis_end)
    segments: list[dict[str, Any]] = []
    for source_segment in output.get("segments", []) or []:
        segment_start = float(source_segment.get("start", 0.0))
        segment_end = float(source_segment.get("end", segment_start))
        if segment_end <= start_bound or segment_start >= end_bound:
            continue
        segment = dict(source_segment)
        segment["start"] = max(segment_start, start_bound)
        segment["end"] = min(segment_end, end_bound)
        words: list[dict[str, Any]] = []
        for source_word in source_segment.get("words", []) or []:
            word_start = float(source_word.get("start", 0.0))
            word_end = float(source_word.get("end", word_start))
            if word_end <= start_bound or word_start >= end_bound:
                continue
            word = dict(source_word)
            word["start"] = max(word_start, start_bound)
            word["end"] = min(word_end, end_bound)
            if word["end"] > word["start"]:
                words.append(word)
        if words:
            segment["words"] = words
            segment["start"] = max(segment["start"], float(words[0].get("start", segment["start"])))
            segment["end"] = min(segment["end"], float(words[-1].get("end", segment["end"])))
        if segment["end"] > segment["start"]:
            segments.append(segment)
    output["segments"] = segments
    return output


def active_speech_duration(segments: Sequence[Mapping[str, Any]] | None) -> float:
    """Return unique active-speech seconds after merging overlapping ranges."""
    ranges = sorted(
        (
            max(0.0, float(segment.get("start", 0.0))),
            max(0.0, float(segment.get("end", segment.get("start", 0.0)))),
        )
        for segment in segments or []
        if float(segment.get("end", 0.0)) > float(segment.get("start", 0.0))
    )
    merged: list[list[float]] = []
    for start, end in ranges:
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return sum(end - start for start, end in merged)


def _finite_float(value: Any, default: float | None = None) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if math.isfinite(number) else default


def _positive_int(value: Any, default: int) -> int:
    number = _finite_float(value)
    if number is None or number <= 0:
        return default
    return max(1, int(number))


def confidence_tier(score: Any) -> str | None:
    """Return ``best``, ``strong``, ``review``, or ``None`` for a score.

    Thresholds use the existing application's 0-to-15 output score scale.
    Numeric strings are accepted; non-finite and malformed values are rejected.
    """

    value = _finite_float(score)
    if value is None:
        return None
    if value >= CONFIDENCE_THRESHOLDS["best"]:
        return "best"
    if value >= CONFIDENCE_THRESHOLDS["strong"]:
        return "strong"
    if value >= CONFIDENCE_THRESHOLDS["review"]:
        return "review"
    return None


def calculate_yield_plan(
    active_speech_seconds: Any,
    *,
    volume: str = "balanced",
    max_clips: Any = DEFAULT_MAX_CLIPS,
    exact_count: Any = None,
    minimum_clips: Any = 3,
    soft_min_ratio: Any = DEFAULT_SOFT_MIN_RATIO,
) -> dict[str, Any]:
    """Calculate target and soft-minimum batch sizes from active speech time.

    Curated, balanced, and more target roughly one clip per five, three, and two
    active-speech minutes respectively.  A positive source gets a small minimum
    batch, while zero active speech produces a zero target.  ``exact`` obeys the
    requested count (subject to the export cap) and makes the soft minimum equal
    to the target.
    """

    normalized_volume = str(volume or "balanced").strip().lower()
    if normalized_volume not in {*VOLUME_MINUTES_PER_CLIP, "exact"}:
        raise ValueError("volume must be curated, balanced, more, or exact")

    cap = min(_positive_int(max_clips, DEFAULT_MAX_CLIPS), HARD_MAX_CLIPS)
    minimum = min(_positive_int(minimum_clips, 3), cap)
    seconds = max(0.0, _finite_float(active_speech_seconds, 0.0) or 0.0)
    active_minutes = seconds / 60.0

    if normalized_volume == "exact":
        requested = _finite_float(exact_count)
        if requested is None or requested <= 0:
            raise ValueError("exact_count must be a positive number in exact mode")
        target = min(max(1, int(math.ceil(requested))), cap)
        soft_min = target
        minutes_per_clip = None
    elif active_minutes <= 0:
        target = 0
        soft_min = 0
        minutes_per_clip = VOLUME_MINUTES_PER_CLIP[normalized_volume]
    else:
        minutes_per_clip = VOLUME_MINUTES_PER_CLIP[normalized_volume]
        target = min(cap, max(minimum, int(math.ceil(active_minutes / minutes_per_clip))))
        ratio = _finite_float(soft_min_ratio, DEFAULT_SOFT_MIN_RATIO)
        ratio = min(1.0, max(0.1, ratio or DEFAULT_SOFT_MIN_RATIO))
        soft_min = min(target, max(1, int(math.ceil(target * ratio))))

    return {
        "volume": normalized_volume,
        "active_speech_seconds": round(seconds, 3),
        "active_speech_minutes": round(active_minutes, 3),
        "minutes_per_clip": minutes_per_clip,
        "target": target,
        "soft_min": soft_min,
        "max_clips": cap,
        "exact": normalized_volume == "exact",
    }


def _candidate_score(candidate: Mapping[str, Any], score_key: str) -> float | None:
    keys = list(dict.fromkeys((score_key, "score", "final_score", "viral_score")))
    for key in keys:
        if key in candidate:
            value = _finite_float(candidate.get(key))
            if value is not None:
                return value
    return None


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _token_set(text: str) -> set[str]:
    return set(re.findall(r"[a-z0-9']+", text.lower()))


def _story_token_set(text: str) -> set[str]:
    return {
        token
        for token in _token_set(text)
        if token not in _STORY_STOP_WORDS and (len(token) > 1 or token.isdigit())
    }


def _normalize_topics(value: Any) -> set[str]:
    if isinstance(value, str):
        raw_values = [value]
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        raw_values = value
    else:
        raw_values = []
    topics: set[str] = set()
    for item in raw_values:
        if isinstance(item, Mapping):
            item = item.get("topic", item.get("name", ""))
        topic = _normalize_text(item).casefold()
        if topic:
            topics.add(topic)
    return topics


def _normalize_candidate(
    raw: Mapping[str, Any],
    index: int,
    *,
    score_key: str,
    used_ids: set[str],
) -> tuple[dict[str, Any] | None, str | None]:
    score = _candidate_score(raw, score_key)
    if score is None:
        return None, "invalid_score"

    start = _finite_float(raw.get("start", raw.get("start_time")))
    end = _finite_float(raw.get("end", raw.get("end_time")))
    if start is None:
        return None, "invalid_start"
    if end is None:
        duration = _finite_float(raw.get("duration"))
        end = start + duration if duration is not None else None
    if end is None or start < 0 or end <= start:
        return None, "invalid_range"

    original_id = _normalize_text(raw.get("yield_id", raw.get("id", raw.get("candidate_id", ""))))
    base_id = original_id or f"candidate-{index:04d}"
    yield_id = base_id
    suffix = 2
    while yield_id in used_ids:
        yield_id = f"{base_id}#{suffix}"
        suffix += 1
    used_ids.add(yield_id)

    text = _normalize_text(raw.get("text", raw.get("transcript", raw.get("summary", ""))))
    candidate = copy.deepcopy(dict(raw))
    candidate.update({
        "yield_id": yield_id,
        "yield_score": round(score, 3),
        "yield_tier": confidence_tier(score),
        "yield_source_index": index,
        "_yield_start": float(start),
        "_yield_end": float(end),
        "_yield_text_tokens": _token_set(text),
        "_yield_story_tokens": _story_token_set(text),
        "_yield_topics": _normalize_topics(raw.get("topics", [])),
    })
    return candidate, None


def _temporal_iou(first: Mapping[str, Any], second: Mapping[str, Any]) -> float:
    intersection = max(
        0.0,
        min(first["_yield_end"], second["_yield_end"])
        - max(first["_yield_start"], second["_yield_start"]),
    )
    union = max(first["_yield_end"], second["_yield_end"]) - min(
        first["_yield_start"], second["_yield_start"]
    )
    return intersection / union if union > 0 else 0.0


def _overlap_coefficient(first: Mapping[str, Any], second: Mapping[str, Any]) -> float:
    intersection = max(
        0.0,
        min(first["_yield_end"], second["_yield_end"])
        - max(first["_yield_start"], second["_yield_start"]),
    )
    shorter = min(
        first["_yield_end"] - first["_yield_start"],
        second["_yield_end"] - second["_yield_start"],
    )
    return intersection / shorter if shorter > 0 else 0.0


def _jaccard(first: set[str], second: set[str]) -> float:
    if not first or not second:
        return 0.0
    return len(first & second) / len(first | second)


def _is_duplicate(
    first: Mapping[str, Any],
    second: Mapping[str, Any],
    *,
    iou_threshold: float,
    text_threshold: float,
) -> bool:
    temporal = _temporal_iou(first, second)
    if temporal >= iou_threshold:
        return True
    text = _jaccard(first["_yield_text_tokens"], second["_yield_text_tokens"])
    return _overlap_coefficient(first, second) >= 0.35 and text >= text_threshold


def _diversity_similarity(first: Mapping[str, Any], second: Mapping[str, Any]) -> float:
    temporal = _temporal_iou(first, second)
    text = _jaccard(first["_yield_text_tokens"], second["_yield_text_tokens"])
    topics = _jaccard(first["_yield_topics"], second["_yield_topics"])
    first_midpoint = (first["_yield_start"] + first["_yield_end"]) / 2.0
    second_midpoint = (second["_yield_start"] + second["_yield_end"]) / 2.0
    proximity = math.exp(-abs(first_midpoint - second_midpoint) / 120.0)
    return max(temporal, (0.5 * text) + (0.25 * topics) + (0.25 * proximity))


def _interval_gap(first: Mapping[str, Any], second: Mapping[str, Any]) -> float:
    if first["_yield_end"] < second["_yield_start"]:
        return float(second["_yield_start"] - first["_yield_end"])
    if second["_yield_end"] < first["_yield_start"]:
        return float(first["_yield_start"] - second["_yield_end"])
    return 0.0


def _story_affinity(first: Mapping[str, Any], second: Mapping[str, Any]) -> float | None:
    """Return a comparable affinity when two candidate windows tell one story.

    A lower overlap threshold than hard deduplication prevents multiple primary
    exports of slightly different windows around the same moment.  Text/topic
    evidence can also join adjacent windows, but intentionally cannot merge
    distant candidates on generic vocabulary alone.
    """

    temporal = _temporal_iou(first, second)
    overlap = _overlap_coefficient(first, second)
    text = _jaccard(first["_yield_story_tokens"], second["_yield_story_tokens"])
    topics = _jaccard(first["_yield_topics"], second["_yield_topics"])
    gap = _interval_gap(first, second)
    first_midpoint = (first["_yield_start"] + first["_yield_end"]) / 2.0
    second_midpoint = (second["_yield_start"] + second["_yield_end"]) / 2.0
    midpoint_distance = abs(first_midpoint - second_midpoint)

    same_story = (
        temporal >= STORY_IOU_THRESHOLD
        or overlap >= STORY_OVERLAP_THRESHOLD
        or (overlap > 0.0 and text >= 0.3)
        or (
            gap <= STORY_ADJACENT_GAP_SECONDS
            and (text >= 0.35 or topics >= 0.5)
        )
        or (midpoint_distance <= 90.0 and text >= 0.55 and topics >= 0.34)
        or (text >= 0.72 and topics >= 0.5)
    )
    if not same_story:
        return None
    proximity = math.exp(-midpoint_distance / 120.0)
    return max(temporal, overlap, (0.5 * text) + (0.3 * topics) + (0.2 * proximity))


def _assign_story_clusters(
    representatives: list[dict[str, Any]],
    hard_duplicates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Annotate candidates with stable story and variant metadata."""

    clusters: list[dict[str, Any]] = []
    for candidate in representatives:
        best_cluster: dict[str, Any] | None = None
        best_affinity = -1.0
        for cluster in clusters:
            affinity = _story_affinity(candidate, cluster["anchor"])
            if affinity is not None and affinity > best_affinity:
                best_cluster = cluster
                best_affinity = affinity
        if best_cluster is None:
            clusters.append({"anchor": candidate, "representatives": [candidate]})
        else:
            best_cluster["representatives"].append(candidate)

    clusters.sort(
        key=lambda cluster: (
            min(item["_yield_start"] for item in cluster["representatives"]),
            min(item["yield_source_index"] for item in cluster["representatives"]),
        )
    )
    cluster_by_representative: dict[str, dict[str, Any]] = {}
    for index, cluster in enumerate(clusters, start=1):
        cluster["cluster_id"] = f"story-{index:04d}"
        cluster["duplicates"] = []
        for candidate in cluster["representatives"]:
            cluster_by_representative[candidate["yield_id"]] = cluster

    for duplicate in hard_duplicates:
        parent_id = duplicate.get("_yield_hard_duplicate_of")
        cluster = cluster_by_representative.get(str(parent_id))
        if cluster is not None:
            cluster["duplicates"].append(duplicate)

    for cluster in clusters:
        canonical = cluster["anchor"]
        alternates = sorted(
            [
                candidate
                for candidate in [*cluster["representatives"], *cluster["duplicates"]]
                if candidate is not canonical
            ],
            key=lambda item: (
                -float(item["yield_score"]),
                float(item["_yield_start"]),
                int(item["yield_source_index"]),
            ),
        )
        variants = [canonical, *alternates]
        cluster["variants"] = variants
        for variant_rank, candidate in enumerate(variants, start=1):
            candidate["_yield_cluster_id"] = cluster["cluster_id"]
            candidate["_yield_variant_rank"] = variant_rank
            candidate["_yield_duplicate_of"] = (
                None if candidate is canonical else canonical["yield_id"]
            )
    return clusters


def _mmr_pick(
    pool: list[dict[str, Any]],
    count: int,
    selected: list[dict[str, Any]],
    *,
    quality_weight: float,
) -> list[dict[str, Any]]:
    remaining = list(pool)
    output: list[dict[str, Any]] = []
    while remaining and len(output) < count:
        references = selected + output

        def rank(candidate: Mapping[str, Any]) -> tuple[float, float, float, int]:
            score = float(candidate["yield_score"])
            quality = min(1.0, max(0.0, (score - CONFIDENCE_THRESHOLDS["review"]) / 6.0))
            similarity = max(
                (_diversity_similarity(candidate, reference) for reference in references),
                default=0.0,
            )
            mmr = (quality_weight * quality) - ((1.0 - quality_weight) * similarity)
            return (
                mmr,
                score,
                -float(candidate["_yield_start"]),
                -int(candidate["yield_source_index"]),
            )

        chosen = max(remaining, key=rank)
        remaining.remove(chosen)
        output.append(chosen)
    return output


def _cluster_aware_variant_picks(
    pool: list[dict[str, Any]],
    count: int,
    selected: list[dict[str, Any]],
    *,
    quality_weight: float,
) -> list[dict[str, Any]]:
    """Pick at most one alternate per story before taking second alternates."""

    groups: dict[str, list[dict[str, Any]]] = {}
    for candidate in pool:
        cluster_id = str(candidate.get("_yield_cluster_id") or candidate["yield_id"])
        groups.setdefault(cluster_id, []).append(candidate)
    for variants in groups.values():
        variants.sort(
            key=lambda item: (
                int(item.get("_yield_variant_rank", 1)),
                -float(item["yield_score"]),
                float(item["_yield_start"]),
            )
        )

    output: list[dict[str, Any]] = []
    while groups and len(output) < count:
        layer = [variants.pop(0) for variants in groups.values() if variants]
        groups = {key: variants for key, variants in groups.items() if variants}
        remaining_count = count - len(output)
        output.extend(
            _mmr_pick(
                layer,
                min(remaining_count, len(layer)),
                selected + output,
                quality_weight=quality_weight,
            )
        )
    return output


def _public_candidate(candidate: Mapping[str, Any], *, role: str, rank: int) -> dict[str, Any]:
    output = {
        key: copy.deepcopy(value)
        for key, value in candidate.items()
        if not key.startswith("_yield_")
    }
    output["cluster_id"] = candidate.get("_yield_cluster_id")
    output["variant_rank"] = int(candidate.get("_yield_variant_rank", 1))
    output["duplicate_of"] = candidate.get("_yield_duplicate_of")
    output["yield_role"] = role
    output["yield_rank"] = rank
    return output


def select_yield_candidates(
    candidates: Any,
    *,
    target: Any,
    soft_min: Any = None,
    exact: bool = False,
    score_key: str = "score",
    reserve_count: Any = None,
    reserve_ratio: Any = 0.25,
    iou_threshold: Any = 0.5,
    text_similarity_threshold: Any = 0.75,
    quality_weight: Any = 0.78,
) -> dict[str, Any]:
    """Select diverse primary clips and render-backfill reserves.

    Best and strong candidates fill the requested target.  Review-tier clips
    fill a balanced batch only to its soft minimum, or to the full target for an
    explicit exact request.  Story clustering permits only one primary per
    overlapping narrative while preserving alternate windows as cluster-aware
    reserves.  Candidates below the review floor are never used.  Invalid
    candidate dictionaries are reported in ``rejected`` rather than raising
    and inputs are never mutated.
    """

    desired = max(0, _positive_int(target, 1)) if _finite_float(target, 0.0) > 0 else 0
    requested_soft = desired if soft_min is None else max(0, _positive_int(soft_min, 1))
    requested_soft = min(desired, requested_soft)
    fill_floor = desired if exact else requested_soft

    if isinstance(candidates, Mapping):
        raw_candidates = [candidates]
    elif isinstance(candidates, Sequence) and not isinstance(candidates, (str, bytes)):
        raw_candidates = list(candidates)
    else:
        raw_candidates = []

    rejected: list[dict[str, Any]] = []
    valid: list[dict[str, Any]] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(raw_candidates):
        if not isinstance(raw, Mapping):
            rejected.append({"index": index, "reason": "not_a_mapping"})
            continue
        normalized, error = _normalize_candidate(raw, index, score_key=score_key, used_ids=used_ids)
        if normalized is None:
            rejected.append({
                "index": index,
                "id": _normalize_text(raw.get("id", raw.get("candidate_id", ""))) or None,
                "reason": error,
            })
            continue
        if normalized["yield_tier"] is None:
            rejected.append({
                "index": index,
                "id": normalized["yield_id"],
                "score": normalized["yield_score"],
                "reason": "below_review_floor",
            })
            continue
        valid.append(normalized)

    iou = min(1.0, max(0.0, _finite_float(iou_threshold, 0.5) or 0.5))
    text_threshold = min(
        1.0,
        max(0.0, _finite_float(text_similarity_threshold, 0.75) or 0.75),
    )
    ordered = sorted(
        valid,
        key=lambda item: (-float(item["yield_score"]), item["_yield_start"], item["yield_source_index"]),
    )
    representatives: list[dict[str, Any]] = []
    hard_duplicates: list[dict[str, Any]] = []
    for candidate in ordered:
        duplicate_of = next(
            (
                representative
                for representative in representatives
                if _is_duplicate(
                    candidate,
                    representative,
                    iou_threshold=iou,
                    text_threshold=text_threshold,
                )
            ),
            None,
        )
        if duplicate_of is None:
            representatives.append(candidate)
        else:
            candidate["_yield_hard_duplicate_of"] = duplicate_of["yield_id"]
            hard_duplicates.append(candidate)

    story_clusters = _assign_story_clusters(representatives, hard_duplicates)
    story_representatives = [cluster["anchor"] for cluster in story_clusters]

    weight = min(1.0, max(0.5, _finite_float(quality_weight, 0.78) or 0.78))
    high_confidence = [
        candidate for candidate in story_representatives
        if candidate["yield_tier"] in {"best", "strong"}
    ]
    selected = _mmr_pick(high_confidence, desired, [], quality_weight=weight)

    selected_ids = {candidate["yield_id"] for candidate in selected}
    if len(selected) < fill_floor:
        review_pool = [
            candidate for candidate in story_representatives
            if candidate["yield_tier"] == "review" and candidate["yield_id"] not in selected_ids
        ]
        selected.extend(
            _mmr_pick(review_pool, fill_floor - len(selected), selected, quality_weight=weight)
        )
        selected_ids = {candidate["yield_id"] for candidate in selected}

    remaining_story_representatives = [
        candidate
        for candidate in story_representatives
        if candidate["yield_id"] not in selected_ids
    ]
    if reserve_count is None:
        ratio = min(1.0, max(0.0, _finite_float(reserve_ratio, 0.25) or 0.25))
        requested_reserves = max(2, int(math.ceil(desired * ratio))) if desired else 0
    else:
        requested_reserves = max(0, int(_finite_float(reserve_count, 0.0) or 0))
    reserves = _mmr_pick(
        remaining_story_representatives,
        requested_reserves,
        selected,
        quality_weight=weight,
    )
    if len(reserves) < requested_reserves:
        story_anchor_ids = {
            candidate["yield_id"] for candidate in story_representatives
        }
        variant_pool = [
            candidate
            for candidate in representatives
            if candidate["yield_id"] not in story_anchor_ids
        ]
        reserves.extend(
            _cluster_aware_variant_picks(
                variant_pool,
                requested_reserves - len(reserves),
                selected + reserves,
                quality_weight=weight,
            )
        )

    public_selected = [
        _public_candidate(candidate, role="primary", rank=index + 1)
        for index, candidate in enumerate(selected)
    ]
    public_reserves = [
        _public_candidate(candidate, role="reserve", rank=index + 1)
        for index, candidate in enumerate(reserves)
    ]
    duplicates = [
        _public_candidate(candidate, role="duplicate", rank=index + 1)
        for index, candidate in enumerate(hard_duplicates)
    ]
    tier_counts = {
        tier: sum(1 for candidate in representatives if candidate["yield_tier"] == tier)
        for tier in CONFIDENCE_THRESHOLDS
    }
    selected_cluster_ids = {
        str(candidate["_yield_cluster_id"]) for candidate in selected
    }
    reserve_cluster_ids = {
        str(candidate["_yield_cluster_id"]) for candidate in reserves
    }
    cluster_summaries = [
        {
            "cluster_id": cluster["cluster_id"],
            "representative_id": cluster["anchor"]["yield_id"],
            "candidate_ids": [candidate["yield_id"] for candidate in cluster["variants"]],
            "variant_count": len(cluster["variants"]),
            "selected": cluster["cluster_id"] in selected_cluster_ids,
            "reserve_count": sum(
                1
                for candidate in reserves
                if candidate["_yield_cluster_id"] == cluster["cluster_id"]
            ),
        }
        for cluster in story_clusters
    ]

    return {
        "target": desired,
        "soft_min": requested_soft,
        "selected": public_selected,
        "reserves": public_reserves,
        "duplicates": duplicates,
        "clusters": cluster_summaries,
        "rejected": rejected,
        "target_met": len(public_selected) >= desired,
        "soft_min_met": len(public_selected) >= requested_soft,
        "stats": {
            "input": len(raw_candidates),
            "eligible": len(valid),
            "deduped": len(representatives),
            "duplicates": len(duplicates),
            "unique_stories": len(story_clusters),
            "story_variants": max(0, len(valid) - len(story_clusters)),
            "primary_stories": len(selected_cluster_ids),
            "reserve_stories": len(reserve_cluster_ids),
            "selected": len(public_selected),
            "reserves": len(public_reserves),
            "rejected": len(rejected),
            "tiers": tier_counts,
        },
    }


def build_yield_batch(
    candidates: Any,
    active_speech_seconds: Any,
    *,
    volume: str = "balanced",
    max_clips: Any = DEFAULT_MAX_CLIPS,
    exact_count: Any = None,
    **selection_options: Any,
) -> dict[str, Any]:
    """Convenience wrapper returning a yield plan and its selected batch."""

    plan = calculate_yield_plan(
        active_speech_seconds,
        volume=volume,
        max_clips=max_clips,
        exact_count=exact_count,
    )
    selection = select_yield_candidates(
        candidates,
        target=plan["target"],
        soft_min=plan["soft_min"],
        exact=plan["exact"],
        **selection_options,
    )
    return {**plan, **selection}


def backfill_failed_renders(
    selected: Any,
    reserves: Any,
    failed_ids: Any,
    *,
    desired_count: Any = None,
) -> dict[str, Any]:
    """Promote reserves without duplicating a surviving primary's story."""

    primary = [dict(item) for item in selected or [] if isinstance(item, Mapping)]
    reserve_queue = [dict(item) for item in reserves or [] if isinstance(item, Mapping)]
    if isinstance(failed_ids, (str, bytes)):
        failures = {str(failed_ids)}
    else:
        try:
            failures = {str(value) for value in failed_ids or []}
        except TypeError:
            failures = set()

    def identities(candidate: Mapping[str, Any]) -> set[str]:
        return {
            str(value)
            for key in ("yield_id", "id", "candidate_id")
            if (value := candidate.get(key)) is not None
        }

    def cluster_identity(candidate: Mapping[str, Any]) -> str | None:
        value = candidate.get("cluster_id")
        normalized = str(value).strip() if value is not None else ""
        return normalized or None

    survivors = [candidate for candidate in primary if identities(candidate).isdisjoint(failures)]
    desired = len(primary) if desired_count is None else max(
        0,
        int(_finite_float(desired_count, len(primary)) or 0),
    )
    promoted: list[dict[str, Any]] = []
    represented_clusters = {
        cluster_id
        for candidate in survivors
        if (cluster_id := cluster_identity(candidate)) is not None
    }
    eligible_reserves = [
        candidate
        for candidate in reserve_queue
        if identities(candidate).isdisjoint(failures)
    ]
    promoted_indices: set[int] = set()
    while len(survivors) + len(promoted) < desired:
        next_index = next(
            (
                index
                for index, candidate in enumerate(eligible_reserves)
                if index not in promoted_indices
                and (
                    cluster_identity(candidate) is None
                    or cluster_identity(candidate) not in represented_clusters
                )
            ),
            None,
        )
        if next_index is None:
            break
        candidate = eligible_reserves[next_index]
        promoted_indices.add(next_index)
        promoted_candidate = copy.deepcopy(candidate)
        promoted_candidate["yield_role"] = "backfill"
        promoted.append(promoted_candidate)
        cluster_id = cluster_identity(candidate)
        if cluster_id is not None:
            represented_clusters.add(cluster_id)

    remaining = [
        copy.deepcopy(candidate)
        for index, candidate in enumerate(eligible_reserves)
        if index not in promoted_indices
    ]

    replenished = survivors + promoted
    for index, candidate in enumerate(replenished):
        candidate["yield_rank"] = index + 1
    for index, candidate in enumerate(remaining):
        candidate["yield_rank"] = index + 1

    return {
        "selected": replenished,
        "reserves": remaining,
        "backfilled": promoted,
        "failed_ids": sorted(failures),
        "desired_count": desired,
        "unfilled": max(0, desired - len(replenished)),
    }


__all__ = [
    "CONFIDENCE_THRESHOLDS",
    "VOLUME_MINUTES_PER_CLIP",
    "active_speech_duration",
    "backfill_failed_renders",
    "build_yield_batch",
    "calculate_yield_plan",
    "confidence_tier",
    "select_yield_candidates",
    "transcript_for_analysis_range",
]
