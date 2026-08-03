# Hardware acceleration

Viral Clip Factory separates machine-learning compute from video encoding. These can use different backends in the same job.

## Backend matrix

| Platform | Local transcription compute | Video encoding | Status |
| --- | --- | --- | --- |
| Linux AMD `gfx1151` | PyTorch Whisper on ROCm; optional `whisper.cpp` on Vulkan or HIP | FFmpeg VAAPI | Hardware-verified target |
| Windows AMD `gfx1151` | PyTorch Whisper on ROCm; optional `whisper.cpp` on Vulkan or HIP | FFmpeg AMF | Beta until tested on physical Windows hardware |
| Linux/Windows NVIDIA | PyTorch Whisper on CUDA; optional `whisper.cpp` on CUDA or Vulkan | FFmpeg NVENC | Preserved from the original implementation |
| Any supported platform | PyTorch Whisper or `whisper.cpp` on CPU | libx264/libx265 | Automatic fallback |

PyTorch intentionally exposes ROCm devices through its `torch.cuda` API. The dashboard reports them as AMD ROCm by checking `torch.version.hip`; this is not a CUDA misidentification.

PyTorch Whisper is the default transcription engine and supports `turbo` in addition to the original model sizes. For a portable local alternative, build `whisper.cpp` with the backend appropriate for the machine, then set `VCF_WHISPER_CPP_PATH` to its CLI executable and `VCF_WHISPER_CPP_MODEL` to a compatible GGML `.bin` model. Those paths are external runtime configuration; binaries and model weights are not bundled.

## Linux AMD

Prerequisites:

- AMDGPU/ROCm support for the GPU
- access to `/dev/kfd` and `/dev/dri/renderD128`
- FFmpeg containing `h264_vaapi` and `hevc_vaapi`

Install and verify:

```bash
VCF_TORCH_PROFILE=amd-gfx1151 ./scripts/setup-linux.sh
./venv/bin/python scripts/doctor.py
```

Override the render node with `VCF_VAAPI_DEVICE=/dev/dri/renderD129` when necessary.

### whisper.cpp on AMD Vulkan

The project helper supports Vulkan and CPU builds. Vulkan is the recommended
whisper.cpp backend on Linux AMD because it is cross-vendor and does not
require the ROCm compiler toolchain. Install the build and Vulkan prerequisites
first on Debian or Ubuntu:

```bash
sudo apt-get install build-essential cmake git curl libvulkan-dev glslc vulkan-tools
vulkaninfo --summary
```

Then install the full multilingual `large-v3` model and let the helper choose
Vulkan only when its tools and runtime are usable:

```bash
./scripts/install-whisper-cpp.sh \
  --model large-v3 \
  --backend auto \
  --env-file "$PWD/.env"
```

The default model is 2.9 GiB on disk and uses roughly 3.9 GB at runtime. The
helper also installs the small, integrity-checked Silero v6.2 VAD model. The
command atomically updates only the executable, transcription-model, and VAD-model
`VCF_WHISPER_CPP_*` keys in `.env`.
Restart the dashboard afterward. Do not use `~` in manual paths. See
[SETUP.md](SETUP.md#optional-whispercpp-local-transcription) for the model
table, integrated setup flag, verification command, and CPU recovery path.

HIP/ROCm builds remain available upstream for advanced installations, but the
project helper intentionally exposes only `auto`, `vulkan`, and `cpu`. A manual
HIP build works with the application when its `whisper-cli` and GGML model are
configured through the same environment variables.

## Windows AMD

Install a current AMD graphics driver, an FFmpeg build with AMF enabled, Node 20-22, and `uv`. Then run:

```powershell
.\scripts\setup-windows.ps1 -TorchProfile amd-gfx1151
.\venv\Scripts\python.exe scripts\doctor.py
```

The setup uses AMD's architecture-specific `gfx1151` PyTorch wheel index. AMF and ROCm availability are checked independently.

The repository's `install-whisper-cpp.sh` helper is currently for Linux. On
Windows, follow the official whisper.cpp build instructions for Vulkan, HIP,
CUDA, or CPU, then set `VCF_WHISPER_CPP_PATH`, `VCF_WHISPER_CPP_MODEL`, and
optionally `VCF_WHISPER_CPP_VAD_MODEL` to absolute Windows paths before
starting the dashboard.

## Selection and fallback

Video and transcription selection are independent. `auto` prefers the native AMD encoder on AMD platforms, then another working hardware encoder, then CPU. An explicit video backend is tried first but still falls back so a long render is not lost solely because hardware initialization failed.

For transcription, **Auto local** prefers accelerated PyTorch Whisper, then a
ready whisper.cpp installation, then PyTorch Whisper on CPU. Selecting
whisper.cpp explicitly requires both a runnable CLI and a readable GGML model.
The setup helper's `--backend auto` independently chooses a Vulkan build when
the required Vulkan tools/runtime pass, or a CPU build otherwise.

Available CLI controls:

```text
--compute-device auto|cpu|cuda|rocm
--video-encoder auto|cpu|nvenc|vaapi|amf
--transcription-provider auto|openai_whisper|whisper_cpp|deepgram
--transcription-model tiny|base|small|medium|large-v3|turbo
--local-semantic
--gemini-analysis
--vaapi-device /dev/dri/renderD128
```

Deepgram Nova-3 and Gemini are cloud analysis choices rather than hardware backends. They remain off unless selected for a job. A local semantic reranker can instead use any configured OpenAI-compatible server through `VCF_LOCAL_LLM_URL` and `VCF_LOCAL_LLM_MODEL`; `VCF_LOCAL_LLM_API_KEY` is optional. Missing providers and runtime errors fall back to the available local analysis path.
