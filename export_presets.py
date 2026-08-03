"""Creator export presets and safe output naming."""

from __future__ import annotations

import os
import re


EXPORT_PRESETS = {
    "generic": {
        "id": "generic",
        "label": "Generic Vertical",
        "width": 1080,
        "height": 1920,
        "default_max_duration": 60,
        "safe_area": {"top": 0.08, "right": 0.08, "bottom": 0.12, "left": 0.08},
    },
    "youtube_shorts": {
        "id": "youtube_shorts",
        "label": "YouTube Shorts",
        "width": 1080,
        "height": 1920,
        "default_max_duration": 180,
        "safe_area": {"top": 0.08, "right": 0.14, "bottom": 0.18, "left": 0.06},
    },
    "instagram_reels": {
        "id": "instagram_reels",
        "label": "Instagram Reels",
        "width": 1080,
        "height": 1920,
        "default_max_duration": 90,
        "safe_area": {"top": 0.12, "right": 0.08, "bottom": 0.2, "left": 0.08},
    },
    "tiktok": {
        "id": "tiktok",
        "label": "TikTok",
        "width": 1080,
        "height": 1920,
        "default_max_duration": 60,
        "safe_area": {"top": 0.1, "right": 0.16, "bottom": 0.2, "left": 0.06},
    },
}


def get_export_preset(preset_id: str | None) -> dict:
    return dict(EXPORT_PRESETS.get(preset_id or "generic", EXPORT_PRESETS["generic"]))


def safe_output_name(template: str, source_path: str, preset_id: str, index: int, score: float) -> str:
    source = os.path.splitext(os.path.basename(source_path))[0]
    values = {
        "source": source,
        "platform": preset_id,
        "index": index,
        "score": f"{score:.1f}",
    }
    try:
        rendered = template.format_map(values)
    except (KeyError, ValueError):
        rendered = "{source}_{platform}_{index}_{score}".format_map(values)
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", rendered).strip("._-")
    return f"{(safe or 'clip')[:160]}.mp4"
