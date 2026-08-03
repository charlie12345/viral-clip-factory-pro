#!/usr/bin/env python3
"""Cross-platform compute and FFmpeg hardware capability helpers."""

from __future__ import annotations

import argparse
import functools
import json
import os
import platform
import shutil
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from typing import Callable, Iterable


VIDEO_BACKENDS = ("nvenc", "vaapi", "amf", "cpu")
COMPUTE_BACKENDS = ("cuda", "rocm", "cpu")


@dataclass(frozen=True)
class ComputeCapability:
    backend: str
    available: bool
    label: str
    device_name: str | None = None
    runtime_version: str | None = None


@dataclass(frozen=True)
class VideoCapability:
    backend: str
    available: bool
    label: str
    h264_encoder: str
    hevc_encoder: str
    reason: str | None = None


def _run(command: list[str], timeout: int = 15) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        capture_output=True,
        text=True,
        stdin=subprocess.DEVNULL,
        timeout=timeout,
        check=False,
    )


def detect_compute(torch_module=None) -> list[ComputeCapability]:
    """Return CUDA/ROCm/CPU capabilities without importing torch eagerly."""
    if torch_module is None:
        try:
            import torch as torch_module  # type: ignore
        except Exception:
            torch_module = None

    cuda_available = bool(
        torch_module is not None
        and getattr(getattr(torch_module, "cuda", None), "is_available", lambda: False)()
    )
    hip_version = getattr(getattr(torch_module, "version", None), "hip", None) if torch_module else None
    cuda_version = getattr(getattr(torch_module, "version", None), "cuda", None) if torch_module else None
    device_name = None
    if cuda_available:
        try:
            device_name = torch_module.cuda.get_device_name(0)
        except Exception:
            device_name = None

    is_rocm = cuda_available and bool(hip_version)
    is_cuda = cuda_available and not is_rocm
    return [
        ComputeCapability("rocm", is_rocm, "AMD ROCm", device_name if is_rocm else None, str(hip_version) if hip_version else None),
        ComputeCapability("cuda", is_cuda, "NVIDIA CUDA", device_name if is_cuda else None, str(cuda_version) if cuda_version else None),
        ComputeCapability("cpu", True, "CPU"),
    ]


def select_compute_device(requested: str, torch_module=None, gpu_enabled: bool = True) -> tuple[str, str]:
    """Resolve a public backend name to the device string Whisper expects."""
    requested = (requested or "auto").lower()
    capabilities = {item.backend: item for item in detect_compute(torch_module)}
    if not gpu_enabled or requested == "cpu":
        return "cpu", "cpu"
    if requested in ("cuda", "rocm"):
        if not capabilities[requested].available:
            raise RuntimeError(f"Requested compute backend '{requested}' is not available")
        return "cuda", requested
    for backend in ("rocm", "cuda"):
        if capabilities[backend].available:
            return "cuda", backend
    return "cpu", "cpu"


def ffmpeg_encoder_names(ffmpeg_bin: str = "ffmpeg") -> set[str]:
    if not shutil.which(ffmpeg_bin) and not os.path.isfile(ffmpeg_bin):
        return set()
    result = _run([ffmpeg_bin, "-hide_banner", "-encoders"])
    if result.returncode != 0:
        return set()
    names: set[str] = set()
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].startswith("V"):
            names.add(parts[1])
    return names


def encoder_name(backend: str, is_hdr: bool = False) -> str:
    codec = "hevc" if is_hdr else "h264"
    return {
        "nvenc": f"{codec}_nvenc",
        "vaapi": f"{codec}_vaapi",
        "amf": f"{codec}_amf",
        "cpu": "libx265" if is_hdr else "libx264",
    }[backend]


def encoder_global_args(backend: str, vaapi_device: str) -> list[str]:
    return ["-vaapi_device", vaapi_device] if backend == "vaapi" else []


def encoder_filter(vf_value: str | None, backend: str, is_hdr: bool = False) -> str | None:
    if backend != "vaapi":
        return vf_value
    upload = "format=p010,hwupload" if is_hdr else "format=nv12,hwupload"
    if vf_value and vf_value != "null":
        return f"{vf_value},{upload}"
    return upload


def encoder_args(backend: str, is_hdr: bool = False, purpose: str = "clip") -> list[str]:
    """Return conservative, widely-supported encoder arguments."""
    bitrate = "50M" if is_hdr else ("15M" if purpose == "clip" else "20M")
    maxrate = "60M" if is_hdr else "25M"
    encoder = encoder_name(backend, is_hdr)

    if backend == "nvenc":
        args = ["-c:v", encoder, "-preset", "p6" if is_hdr else "p7", "-b:v", bitrate]
        if not is_hdr:
            args.extend(["-tune", "hq", "-rc", "vbr", "-cq", "19", "-maxrate", maxrate, "-bufsize", "30M"])
    elif backend == "vaapi":
        args = ["-c:v", encoder, "-rc_mode", "VBR", "-b:v", bitrate, "-maxrate", maxrate]
        if not is_hdr:
            args.extend(["-profile:v", "high"])
    elif backend == "amf":
        args = ["-c:v", encoder, "-usage", "transcoding", "-quality", "quality", "-b:v", bitrate]
    else:
        args = [
            "-c:v", encoder,
            "-preset", "fast",
            "-crf", "18" if not is_hdr else "20",
            "-maxrate", maxrate,
            "-bufsize", "30M" if not is_hdr else "60M",
        ]

    if is_hdr:
        if backend != "vaapi":
            args.extend(["-pix_fmt", "p010le"])
        args.extend([
            "-profile:v", "main10",
            "-color_primaries", "bt2020",
            "-color_trc", "smpte2084",
            "-colorspace", "bt2020nc",
        ])
    elif backend != "vaapi":
        args.extend(["-pix_fmt", "yuv420p"])
    return args


@functools.lru_cache(maxsize=32)
def probe_video_backend(
    backend: str,
    ffmpeg_bin: str = "ffmpeg",
    vaapi_device: str = "/dev/dri/renderD128",
    is_hdr: bool = False,
) -> tuple[bool, str | None]:
    """Run a one-frame encode so compiled-but-unusable encoders are rejected."""
    encoders = ffmpeg_encoder_names(ffmpeg_bin)
    required = encoder_name(backend, is_hdr)
    if required not in encoders:
        return False, f"FFmpeg does not provide {required}"
    if backend == "vaapi" and not os.path.exists(vaapi_device):
        return False, f"VAAPI device does not exist: {vaapi_device}"

    with tempfile.TemporaryDirectory(prefix="vcf-encoder-probe-") as temp_dir:
        output = os.path.join(temp_dir, "probe.mp4")
        vf = encoder_filter(None, backend, is_hdr)
        command = [
            ffmpeg_bin, "-y", "-v", "error",
            *encoder_global_args(backend, vaapi_device),
            "-f", "lavfi", "-i", "color=c=black:s=256x256:r=1:d=1",
        ]
        if vf:
            command.extend(["-vf", vf])
        command.extend([*encoder_args(backend, is_hdr, "probe"), "-frames:v", "1", "-an", output])
        try:
            result = _run(command, timeout=20)
        except subprocess.TimeoutExpired:
            return False, f"{required} probe timed out"
        if result.returncode == 0 and os.path.exists(output):
            return True, None
        message = (result.stderr or result.stdout or "encoder probe failed").strip().splitlines()
        return False, message[-1] if message else "encoder probe failed"


def video_backend_order(requested: str = "auto") -> list[str]:
    requested = (requested or "auto").lower()
    native = ["amf", "vaapi", "nvenc"] if platform.system() == "Windows" else ["vaapi", "nvenc", "amf"]
    if requested == "cpu":
        return ["cpu"]
    if requested in VIDEO_BACKENDS:
        return [requested, *[item for item in native if item != requested], "cpu"]
    return [*native, "cpu"]


def available_video_backends(
    requested: str = "auto",
    ffmpeg_bin: str = "ffmpeg",
    vaapi_device: str = "/dev/dri/renderD128",
    is_hdr: bool = False,
    gpu_enabled: bool = True,
) -> list[str]:
    if not gpu_enabled:
        return ["cpu"]
    available = []
    for backend in video_backend_order(requested):
        ok, _ = probe_video_backend(backend, ffmpeg_bin, vaapi_device, is_hdr)
        if ok:
            available.append(backend)
    return available or ["cpu"]


def run_with_encoder_fallback(
    command_builder: Callable[[str], list[str]],
    backends: Iterable[str],
    *,
    context: str,
    log: Callable[[str], None] = print,
) -> tuple[str, subprocess.CompletedProcess[str]]:
    failures: list[str] = []
    for backend in backends:
        try:
            result = _run(command_builder(backend), timeout=60 * 60 * 6)
        except subprocess.TimeoutExpired:
            failures.append(f"{backend}: render timed out")
            log(f"{context}: {backend} timed out; trying the next backend")
            continue
        if result.returncode == 0:
            if failures:
                log(f"{context}: using {backend} after fallback")
            else:
                log(f"{context}: using {backend}")
            return backend, result
        detail = (result.stderr or result.stdout or "unknown error").strip().splitlines()
        reason = detail[-1] if detail else "unknown error"
        failures.append(f"{backend}: {reason}")
        log(f"{context}: {backend} failed; trying the next backend")
    raise RuntimeError(f"{context} failed with all encoders: {' | '.join(failures)}")


def system_capabilities(
    ffmpeg_bin: str = "ffmpeg",
    vaapi_device: str = "/dev/dri/renderD128",
    torch_module=None,
    probe: bool = True,
) -> dict:
    encoders = ffmpeg_encoder_names(ffmpeg_bin)
    video = []
    labels = {"nvenc": "NVIDIA NVENC", "vaapi": "AMD/VAAPI", "amf": "AMD AMF", "cpu": "CPU"}
    for backend in VIDEO_BACKENDS:
        compiled = encoder_name(backend, False) in encoders
        available, reason = probe_video_backend(backend, ffmpeg_bin, vaapi_device) if probe else (compiled, None)
        video.append(asdict(VideoCapability(
            backend,
            available,
            labels[backend],
            encoder_name(backend, False),
            encoder_name(backend, True),
            reason,
        )))
    return {
        "platform": platform.system().lower(),
        "machine": platform.machine(),
        "ffmpegPath": shutil.which(ffmpeg_bin) or ffmpeg_bin,
        "vaapiDevice": vaapi_device,
        "compute": [asdict(item) for item in detect_compute(torch_module)],
        "videoEncoders": video,
        "recommendedCompute": next((item.backend for item in detect_compute(torch_module) if item.available), "cpu"),
        "recommendedVideoEncoder": next((item["backend"] for item in video if item["available"]), "cpu"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect Viral Clip Factory hardware support")
    parser.add_argument("--json", action="store_true", help="Print machine-readable capability JSON")
    parser.add_argument("--no-probe", action="store_true", help="Only inspect compiled FFmpeg encoders")
    parser.add_argument("--ffmpeg", default=os.environ.get("VCF_FFMPEG_PATH", "ffmpeg"))
    parser.add_argument("--vaapi-device", default=os.environ.get("VCF_VAAPI_DEVICE", "/dev/dri/renderD128"))
    args = parser.parse_args()
    capabilities = system_capabilities(args.ffmpeg, args.vaapi_device, probe=not args.no_probe)
    if args.json:
        print(json.dumps(capabilities))
    else:
        print(json.dumps(capabilities, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
