#!/usr/bin/env python3
"""Write a linked AAF composition from Viral Clip Factory interchange JSON."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from fractions import Fraction
from typing import Any, Sequence

import aaf2


def _probe(path_value: str, ffprobe_bin: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
            path_value,
        ],
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or f"Could not probe {path_value}").strip())
    return json.loads(result.stdout or "{}")


def _frames(seconds: Any, rate: Fraction) -> int:
    try:
        return max(0, int(round(float(seconds) * float(rate))))
    except (TypeError, ValueError):
        return 0


def write_aaf(
    manifest_path: str,
    output_path: str,
    *,
    ffprobe_bin: str = "ffprobe",
) -> dict[str, Any]:
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    items = [item for item in manifest.get("items", []) if isinstance(item, dict)]
    title = str(manifest.get("title") or "Viral Clip Factory Sequence")
    rate = Fraction(str(manifest.get("frameRate") or 30)).limit_denominator(1001)
    linked = 0
    offline = 0

    with aaf2.open(output_path, "w") as aaf:
        composition = aaf.create.CompositionMob(title)
        composition.usage = "Usage_TopLevel"
        composition.comments["Application"] = "Viral Clip Factory"
        composition.comments["Interchange"] = "AAF linked sequence"
        aaf.content.mobs.append(composition)
        picture_slot = composition.create_picture_slot(edit_rate=rate)
        picture_slot.name = "V1"
        sequence = picture_slot.segment
        cursor = 0
        media_cache: dict[str, Any] = {}

        for index, item in enumerate(sorted(items, key=lambda entry: float(entry.get("timelineStart", 0)))):
            timeline_start = _frames(item.get("timelineStart"), rate)
            duration = max(1, _frames(float(item.get("timelineEnd", 0)) - float(item.get("timelineStart", 0)), rate))
            if timeline_start > cursor:
                sequence.components.append(aaf.create.Filler(media_kind="picture", length=timeline_start - cursor))
                cursor = timeline_start

            media_path = str(item.get("path") or "")
            component = None
            if media_path and os.path.exists(media_path):
                try:
                    master_mob = media_cache.get(media_path)
                    if master_mob is None:
                        result = aaf.content.create_ama_link(media_path, _probe(media_path, ffprobe_bin))
                        master_mob = result[0] if isinstance(result, tuple) else result
                        media_cache[media_path] = master_mob
                    source_slot = next(
                        (slot for slot in master_mob.slots if str(slot.media_kind).lower() == "picture"),
                        None,
                    )
                    if source_slot is not None:
                        source_rate = Fraction(str(source_slot.edit_rate)).limit_denominator(1001)
                        component = master_mob.create_source_clip(
                            slot_id=source_slot.slot_id,
                            start=_frames(item.get("sourceStart"), source_rate),
                            length=duration,
                            media_kind="picture",
                        )
                        component.length = duration
                        linked += 1
                except Exception:
                    component = None
            if component is None:
                component = aaf.create.Filler(media_kind="picture", length=duration)
                offline += 1
            sequence.components.append(component)
            cursor += duration
            composition.comments[f"Clip {index + 1}"] = str(item.get("name") or media_path or "Offline media")[:200]

        if not sequence.components:
            sequence.components.append(aaf.create.Filler(media_kind="picture", length=1))

    return {
        "output": output_path,
        "linkedClips": linked,
        "offlineClips": offline,
        "frameRate": float(rate),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Write a linked AAF sequence")
    parser.add_argument("manifest")
    parser.add_argument("output")
    parser.add_argument("--ffprobe", default="ffprobe")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        result = write_aaf(args.manifest, args.output, ffprobe_bin=args.ffprobe)
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
