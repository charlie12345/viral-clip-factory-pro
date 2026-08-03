#!/usr/bin/env python3
"""Validate Viral Clip Factory runtime dependencies and accelerators."""

from __future__ import annotations

import importlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from hardware_accel import system_capabilities  # noqa: E402
from transcription_backends import probe_whisper_cpp  # noqa: E402


def command_version(command: str, args: list[str]) -> dict:
    path = shutil.which(command)
    if not path:
        return {"available": False, "path": None, "version": None}
    result = subprocess.run([path, *args], capture_output=True, text=True, check=False)
    line = (result.stdout or result.stderr or "").splitlines()
    return {"available": result.returncode == 0, "path": path, "version": line[0] if line else None}


def module_status(name: str) -> dict:
    try:
        module = importlib.import_module(name)
        return {"available": True, "version": getattr(module, "__version__", None)}
    except Exception as error:
        return {"available": False, "error": str(error)}


def runtime_setting(name: str) -> str | None:
    """Read a non-secret runtime path from the process or the repo .env file."""
    if value := os.environ.get(name):
        return value
    try:
        lines = (ROOT / ".env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    prefix = f"{name}="
    for raw_line in lines:
        line = raw_line.strip()
        if not line.startswith(prefix):
            continue
        value = line[len(prefix) :].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        return value or None
    return None


def main() -> int:
    modules = ["torch", "whisper", "cv2", "yaml", "face_recognition", "ultralytics", "librosa", "yt_dlp", "pytubefix"]
    report = {
        "python": {"version": sys.version.split()[0], "executable": sys.executable},
        "node": command_version("node", ["--version"]),
        "ffmpeg": command_version(os.environ.get("VCF_FFMPEG_PATH", "ffmpeg"), ["-version"]),
        "ffprobe": command_version(os.environ.get("VCF_FFPROBE_PATH", "ffprobe"), ["-version"]),
        "modules": {name: module_status(name) for name in modules},
        "hardware": system_capabilities(
            os.environ.get("VCF_FFMPEG_PATH", "ffmpeg"),
            os.environ.get("VCF_VAAPI_DEVICE", "/dev/dri/renderD128"),
        ),
        "whisperCpp": probe_whisper_cpp(
            executable=runtime_setting("VCF_WHISPER_CPP_PATH"),
            model_path=runtime_setting("VCF_WHISPER_CPP_MODEL"),
            vad_model_path=runtime_setting("VCF_WHISPER_CPP_VAD_MODEL"),
        ),
        "trackingModel": {
            "path": str(ROOT / "yolov8n.pt"),
            "present": (ROOT / "yolov8n.pt").exists(),
            "note": "Ultralytics downloads this weight on first use when network access is available.",
        },
    }
    print(json.dumps(report, indent=2))

    required_commands = report["node"]["available"] and report["ffmpeg"]["available"] and report["ffprobe"]["available"]
    required_modules = all(item["available"] for item in report["modules"].values())
    return 0 if required_commands and required_modules else 1


if __name__ == "__main__":
    raise SystemExit(main())
