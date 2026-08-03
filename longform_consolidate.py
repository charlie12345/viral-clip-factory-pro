#!/usr/bin/env python3
"""Consolidate the media used by a long-form sequence with optional handles."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


VIDEO_CODECS = {"copy", "prores", "dnxhr", "h264"}
IMAGE_EXTENSIONS = {
    ".avif",
    ".bmp",
    ".gif",
    ".heic",
    ".heif",
    ".jpeg",
    ".jpg",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
}


def _finite(value: Any, fallback: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return fallback
    return parsed if math.isfinite(parsed) else fallback


def _safe_name(value: Any, fallback: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "").strip()).strip("._-")
    return (cleaned or fallback)[:120]


def _run(command: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def _probe(path: str, ffprobe_bin: str) -> dict[str, Any]:
    result = _run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels",
            "-of",
            "json",
            path,
        ],
        timeout=60,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or "ffprobe failed").strip())
    payload = json.loads(result.stdout or "{}")
    payload["duration"] = _finite(payload.get("format", {}).get("duration"), 0)
    return payload


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(path)


def _video_output(path: str, codec: str, index: int, name: str) -> tuple[str, list[str]]:
    stem = _safe_name(name or Path(path).stem, f"clip-{index + 1}")
    prefix = f"{index + 1:04d}-{stem}"
    if codec == "prores":
        return f"{prefix}.mov", [
            "-c:v",
            "prores_ks",
            "-profile:v",
            "3",
            "-pix_fmt",
            "yuv422p10le",
            "-c:a",
            "pcm_s24le",
        ]
    if codec == "dnxhr":
        return f"{prefix}.mov", [
            "-c:v",
            "dnxhd",
            "-profile:v",
            "dnxhr_hq",
            "-pix_fmt",
            "yuv422p",
            "-c:a",
            "pcm_s24le",
        ]
    if codec == "h264":
        return f"{prefix}.mp4", [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "15",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "320k",
            "-movflags",
            "+faststart",
        ]
    extension = Path(path).suffix.lower()
    if not extension or len(extension) > 10:
        extension = ".mkv"
    return f"{prefix}{extension}", ["-c", "copy", "-avoid_negative_ts", "make_zero"]


def _transcode_item(
    item: dict[str, Any],
    *,
    index: int,
    media_dir: Path,
    codec: str,
    handles: float,
    ffmpeg_bin: str,
    ffprobe_bin: str,
) -> dict[str, Any]:
    source = str(item.get("path") or "").strip()
    result = {
        **item,
        "sourcePath": source or None,
        "consolidatedPath": None,
        "consolidatedRelativePath": None,
        "status": "offline",
        "error": None,
    }
    if not source or not os.path.isfile(source):
        result["error"] = "Source media is missing."
        return result

    extension = Path(source).suffix.lower()
    if extension in IMAGE_EXTENSIONS:
        filename = f"{index + 1:04d}-{_safe_name(item.get('name') or Path(source).stem, 'still')}{extension}"
        output_path = media_dir / "stills" / filename
        output_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, output_path)
        result.update(
            {
                "status": "complete",
                "consolidatedPath": str(output_path.resolve()),
                "consolidatedRelativePath": str(output_path.relative_to(media_dir.parent)),
                "actualSourceStart": 0,
                "actualSourceEnd": None,
                "headHandleSec": 0,
                "tailHandleSec": 0,
                "streams": [{"codec_type": "video", "codec_name": "still"}],
            }
        )
        return result

    try:
        probe = _probe(source, ffprobe_bin)
    except Exception as error:
        result["error"] = str(error)
        return result

    streams = probe.get("streams") or []
    has_video = any(stream.get("codec_type") == "video" for stream in streams)
    has_audio = any(stream.get("codec_type") == "audio" for stream in streams)
    if not has_video and not has_audio:
        result["error"] = "Source does not contain usable video or audio streams."
        return result

    source_duration = max(0.0, _finite(probe.get("duration"), 0))
    requested_start = max(0.0, _finite(item.get("sourceStart"), 0))
    requested_end = max(requested_start + 0.02, _finite(item.get("sourceEnd"), requested_start + 0.02))
    actual_start = max(0.0, requested_start - handles)
    actual_end = requested_end + handles
    if source_duration > 0:
        actual_start = min(actual_start, max(0.0, source_duration - 0.02))
        actual_end = min(source_duration, actual_end)
    actual_end = max(actual_start + 0.02, actual_end)
    clip_duration = actual_end - actual_start

    if has_video:
        filename, codec_args = _video_output(source, codec, index, str(item.get("name") or ""))
        output_path = media_dir / "video" / filename
        maps = ["-map", "0:v:0?", "-map", "0:a:0?"]
    else:
        filename = f"{index + 1:04d}-{_safe_name(item.get('name') or Path(source).stem, 'audio')}.wav"
        output_path = media_dir / "audio" / filename
        maps = ["-map", "0:a:0?"]
        codec_args = ["-vn", "-c:a", "pcm_s24le"]

    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f"{output_path.stem}.partial{output_path.suffix}")
    command = [
        ffmpeg_bin,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-v",
        "error",
        "-ss",
        f"{actual_start:.6f}",
        "-i",
        source,
        "-t",
        f"{clip_duration:.6f}",
        *maps,
        "-map_metadata",
        "0",
        *codec_args,
        str(temporary_path),
    ]
    process = _run(command, timeout=max(300, min(14_400, 120 + clip_duration * 20)))
    if process.returncode != 0:
        temporary_path.unlink(missing_ok=True)
        result["error"] = (process.stderr or "FFmpeg consolidation failed").strip().splitlines()[-1]
        return result
    temporary_path.replace(output_path)
    result.update(
        {
            "status": "complete",
            "consolidatedPath": str(output_path.resolve()),
            "consolidatedRelativePath": str(output_path.relative_to(media_dir.parent)),
            "actualSourceStart": round(actual_start, 6),
            "actualSourceEnd": round(actual_end, 6),
            "headHandleSec": round(requested_start - actual_start, 6),
            "tailHandleSec": round(actual_end - requested_end, 6),
            "streams": streams,
        }
    )
    return result


def consolidate(
    manifest_path: str,
    output_directory: str,
    *,
    ffmpeg_bin: str = "ffmpeg",
    ffprobe_bin: str = "ffprobe",
    progress_path: str | None = None,
) -> dict[str, Any]:
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    codec = str(manifest.get("codec") or "prores").lower()
    if codec not in VIDEO_CODECS:
        raise ValueError(f"Unsupported consolidation codec: {codec}")
    handles = max(0.0, min(120.0, _finite(manifest.get("handlesSec"), 2.0)))
    items = list(manifest.get("items") or [])[:10_000]
    output_dir = Path(output_directory).resolve()
    media_dir = output_dir / "media"
    output_dir.mkdir(parents=True, exist_ok=True)
    progress_file = Path(progress_path).resolve() if progress_path else output_dir / "progress.json"

    project_path = str(manifest.get("projectPath") or "").strip()
    if project_path and os.path.isfile(project_path):
        project_dir = output_dir / "project"
        project_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(project_path, project_dir / "project.json")

    copied_support = []
    for index, support in enumerate((manifest.get("supportFiles") or [])[:1000]):
        source = str(support.get("path") or "").strip()
        if not source or not os.path.isfile(source):
            continue
        filename = f"{index + 1:04d}-{_safe_name(support.get('name') or Path(source).name, 'support-file')}"
        if Path(filename).suffix == "":
            filename += Path(source).suffix
        destination = output_dir / "support" / filename
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied_support.append(
            {
                **support,
                "sourcePath": source,
                "consolidatedPath": str(destination),
                "consolidatedRelativePath": str(destination.relative_to(output_dir)),
            }
        )

    consolidated_items = []
    total = len(items)
    _write_json(
        progress_file,
        {"status": "running", "completed": 0, "total": total, "percent": 0, "current": None},
    )
    for index, item in enumerate(items):
        _write_json(
            progress_file,
            {
                "status": "running",
                "completed": index,
                "total": total,
                "percent": round((index / max(1, total)) * 100, 1),
                "current": str(item.get("name") or item.get("id") or f"Clip {index + 1}"),
            },
        )
        consolidated_items.append(
            _transcode_item(
                item,
                index=index,
                media_dir=media_dir,
                codec=codec,
                handles=handles,
                ffmpeg_bin=ffmpeg_bin,
                ffprobe_bin=ffprobe_bin,
            )
        )

    completed = sum(item.get("status") == "complete" for item in consolidated_items)
    failed = total - completed
    status = "complete" if failed == 0 else ("partial" if completed else "failed")
    result = {
        "manifestVersion": 1,
        "kind": "longform-consolidated-turnover",
        "projectName": manifest.get("projectName"),
        "title": manifest.get("title"),
        "createdAt": datetime.now(UTC).isoformat(),
        "codec": codec,
        "handlesSec": handles,
        "frameRate": manifest.get("frameRate") or 30,
        "status": status,
        "summary": {"total": total, "complete": completed, "failed": failed},
        "items": consolidated_items,
        "supportFiles": copied_support,
    }
    _write_json(output_dir / "manifest.json", result)
    _write_json(
        progress_file,
        {
            "status": status,
            "completed": completed,
            "total": total,
            "percent": 100,
            "current": None,
            "failed": failed,
        },
    )
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    parser.add_argument("output_directory")
    parser.add_argument("--ffmpeg", default=os.environ.get("VCF_FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--ffprobe", default=os.environ.get("VCF_FFPROBE_PATH", "ffprobe"))
    parser.add_argument("--progress")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = consolidate(
            args.manifest,
            args.output_directory,
            ffmpeg_bin=args.ffmpeg,
            ffprobe_bin=args.ffprobe,
            progress_path=args.progress,
        )
        print(json.dumps(result))
        return 0 if result["status"] != "failed" else 2
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
