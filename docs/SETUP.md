# Setup

Clone from GitHub, install dependencies, then start the dashboard:

```text
https://github.com/charlie12345/viral-clip-factory-pro
```

## No Personal Keys Needed

The core local app does not require OpenAI keys, Gemini keys, WordPress credentials, or any other user-specific API credentials.

Provider credentials can be saved from **Settings → Provider credentials** or supplied through the optional `.env` file. The server never returns credential values to the browser.

## Prerequisites

Install these separately on your machine **before** running the setup scripts:

| Tool | Version / notes |
| --- | --- |
| Node.js + npm | **20 LTS** (20–22). `.nvmrc` pins `20.20.2`. Avoid Node 23+ for now. |
| `uv` | https://docs.astral.sh/uv/ — installs Python 3.12 and the project venv |
| `ffmpeg` + `ffprobe` | On your `PATH`. GPU encodes need the right build (VAAPI / AMF / NVENC). |
| Git | To clone the repository |
| Disk | Several GB for Node/Python deps; keep **10+ GB free** for media work |

Optional later:

- AMD ROCm or NVIDIA CUDA stack for faster local transcription and encoding
- System fonts for baked-subtitle parity with the browser preview
- `whisper.cpp` build tools (see below)

## Linux (desktop or server)

```bash
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro

# Debian/Ubuntu system packages (example)
sudo apt-get update
sudo apt-get install -y ffmpeg git curl build-essential

# Install Node 20 LTS (nvm example) and uv if missing:
#   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
#   nvm install
#   curl -LsSf https://astral.sh/uv/install.sh | sh

chmod +x scripts/*.sh
./scripts/setup-linux.sh
```

The script detects `gfx1151` ROCm, NVIDIA CUDA, or CPU. Override detection with
`VCF_TORCH_PROFILE=amd-gfx1151|cuda|cpu`.

```bash
cp .env.example .env   # optional
node dashboard/server.js
```

Open `http://localhost:3000`.

Linux AMD hardware encode needs FFmpeg with `h264_vaapi` / `hevc_vaapi` and
access to `/dev/dri/renderD128` (override with `VCF_VAAPI_DEVICE`).

## Windows

1. Install [Node.js 20 LTS](https://nodejs.org/), [Git for Windows](https://git-scm.com/),
   [`uv`](https://docs.astral.sh/uv/), and FFmpeg on your `PATH`.
2. For AMD GPUs, use an FFmpeg build that includes `h264_amf` and `hevc_amf`.
   For NVIDIA, prefer a build with NVENC.
3. Open **PowerShell**:

```powershell
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro

.\scripts\setup-windows.ps1
# .\scripts\setup-windows.ps1 -TorchProfile cpu
# .\scripts\setup-windows.ps1 -TorchProfile cuda
# .\scripts\setup-windows.ps1 -TorchProfile amd-gfx1151

Copy-Item .env.example .env
node dashboard\server.js
```

Open `http://localhost:3000`.

Windows Python lives at `.\venv\Scripts\python.exe`. Run the doctor with:

```powershell
.\venv\Scripts\python.exe scripts\doctor.py
```

## After setup (all platforms)

```bash
# Copy and edit runtime settings if you need non-defaults
cp .env.example .env

# Start (serves the built web UI from dashboard/public/dist)
node dashboard/server.js
# equivalent: npm start
```

Defaults:

- **HOST** `127.0.0.1` — localhost only (safe default; **no login system**)
- **PORT** `3000`

To expose it on a trusted LAN or private network interface, set
`HOST=0.0.0.0` in `.env`. Prefer a VPN (Tailscale, WireGuard) or reverse proxy
with authentication over a bare public bind.

The web build script uses `node --no-opt`, disables sourcemaps, and disables
minification for Vite because some workstations hit intermittent Node/V8
crashes during production transforms. If your machine builds normally,
`npm --prefix webui run build:fast` uses a closer-to-standard Vite path.

## Cloud servers (VPS and GPU VMs)

Use this path when you want the dashboard running on a remote machine and you
will open it from a laptop or phone over the network.

### What you need

| Area | Recommendation |
| --- | --- |
| OS | **Ubuntu 22.04 or 24.04 LTS** (best documented path) |
| CPU-only VM | 4+ vCPU, **16 GB RAM**, 50+ GB SSD |
| GPU VM | NVIDIA T4 / L4 / A10+ with current drivers, **or** AMD ROCm-capable hardware |
| RAM with Whisper `large-v3` | Prefer **16–32 GB+** system RAM; GPU VRAM helps a lot |
| Storage | Separate data volume for media; 100+ GB if you do montages / long-form |
| Network | Private access only (Tailscale / WireGuard / VPC security group) |
| Process manager | `systemd` user or system unit, or Docker/supervisor of your choice |

The Node server is **not multi-tenant** and has **no built-in authentication**.
Treat it like an internal tool:

1. Keep the process on `127.0.0.1` and publish only via **Tailscale Serve**, **SSH
   tunnel**, or a reverse proxy on localhost, **or**
2. Bind `HOST=0.0.0.0` only behind a firewall that allows your IP/VPN, plus
   **HTTPS + auth** (Caddy basic auth, oauth2-proxy, Cloudflare Access, etc.).

Never put a naked `http://YOUR_PUBLIC_IP:3000` on the open internet.

### Cloud install (Ubuntu + optional NVIDIA)

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg git curl build-essential

# Node 20 LTS via nvm (example)
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# restart shell or source nvm, then:
nvm install 20
nvm use 20

# uv
curl -LsSf https://astral.sh/uv/install.sh | sh

git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro
chmod +x scripts/*.sh

# CPU-only cloud box:
./scripts/setup-linux.sh
# NVIDIA GPU cloud box (after drivers/CUDA are installed):
# VCF_TORCH_PROFILE=cuda ./scripts/setup-linux.sh

sudo mkdir -p /var/lib/viral-clip-factory
sudo chown "$USER:$USER" /var/lib/viral-clip-factory

cp .env.example .env
```

Example `.env` for a cloud host:

```dotenv
PORT=3000
HOST=127.0.0.1
VCF_PYTHON_PATH=./venv/bin/python
VCF_FFMPEG_PATH=ffmpeg
VCF_FFPROBE_PATH=ffprobe
VCF_MEDIA_ROOT=/var/lib/viral-clip-factory
# Optional: refuse to start if the data volume is unmounted
# VCF_MEDIA_MOUNT=/var/lib
```

Start once to verify:

```bash
node dashboard/server.js
curl -fsS http://127.0.0.1:3000/api/system/capabilities
```

### Private remote access options

**A. Tailscale (simple, private HTTPS)**

On the server (with Tailscale installed and logged in):

```bash
# App listens on localhost
HOST=127.0.0.1 PORT=3000 node dashboard/server.js

# From another shell — publish only to your tailnet (does not open the public internet)
tailscale serve --bg --https=3000 http://127.0.0.1:3000
```

Open `https://<machine-name>.ts.net:3000/` from any device on the same tailnet.

**B. SSH tunnel (no public port)**

```bash
ssh -L 3000:127.0.0.1:3000 user@your-server
# then browse http://localhost:3000 on your laptop
```

**C. Reverse proxy with TLS + auth**

Point Caddy/nginx/Traefik at `http://127.0.0.1:3000`, terminate TLS, and require
login. Keep the Node process bound to localhost.

### Example systemd user service

```ini
# ~/.config/systemd/user/viral-clip-factory.service
[Unit]
Description=Viral Clip Factory dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/viral-clip-factory-pro
Environment=NODE_ENV=production
EnvironmentFile=-%h/viral-clip-factory-pro/.env
ExecStart=/usr/bin/node dashboard/server.js
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now viral-clip-factory.service
# linger so it survives logout on a headless server:
# sudo loginctl enable-linger "$USER"
```

### Cloud sizing notes

- **Transcription** dominates CPU/GPU time. CPU-only `large-v3` is fine for
  testing short clips; production workloads want a GPU.
- **Montages / multi-GB uploads** need a large `VCF_MEDIA_ROOT` on real disk,
  not a small root volume or RAM-backed `/tmp`.
- **One concurrent heavy job** is the practical default; plan RAM for the
  Whisper model plus FFmpeg plus the browser upload path.
- Optional cloud APIs (Deepgram, Gemini) reduce local GPU need but **upload
  media to third parties** only when a job explicitly opts in.

## Optional GPU Setup

`clip_config.yaml` enables acceleration and defaults to automatic probing. The application runs a real one-frame encode test, so an encoder compiled into FFmpeg but lacking usable hardware is skipped.

- install the appropriate ROCm/CUDA stack using the setup scripts, or
- change `processing.gpu_acceleration` to `false`

See [HARDWARE.md](HARDWARE.md) for backend-specific details.

## Optional whisper.cpp Local Transcription

`whisper.cpp` is a separate local transcription engine; installing the Python
`openai-whisper` package does not install it. It is optional because the
compiled program and GGML model weights are external to this repository, and
the default `large-v3` model is a 2.9 GiB download. The installer also adds the
small Silero v6.2 VAD model so long recordings can skip non-speech regions.

The Linux helper clones the official
[whisper.cpp repository](https://github.com/ggml-org/whisper.cpp), builds the
selected revision, downloads the requested model with the upstream downloader,
and checks its published SHA-1 before installing it. `--ref` selects the branch,
tag, or commit for a new source checkout; an existing checkout is deliberately
left at its current revision. Its defaults are:

| Item | Default |
| --- | --- |
| Model | Multilingual `large-v3` |
| VAD model | `silero-v6.2.0` |
| Backend | `auto` (Vulkan when usable, otherwise CPU) |
| Executable | `$HOME/.local/bin/whisper-cli` |
| Runtime payload | `$HOME/.local/libexec/whisper.cpp` |
| Model path | `$HOME/.local/share/whisper.cpp/models/ggml-large-v3.bin` |
| VAD path | `$HOME/.local/share/whisper.cpp/models/ggml-silero-v6.2.0.bin` |
| Source revision | Upstream `master` for a new clone |
| Source/build cache | `${XDG_CACHE_HOME:-$HOME/.cache}/viral-clip-factory/whisper.cpp` |

### Linux prerequisites

The CPU build needs Git, CMake, a C/C++ compiler, and either `curl` or `wget`.
The Vulkan build additionally needs Vulkan development headers, `glslc`, a
Vulkan loader/driver for the GPU, and preferably `vulkaninfo` for validation.
The helper also uses `awk`, `sha1sum`, and `sha256sum`, normally supplied by
the base system and `coreutils` on Linux.
Plan for at least 5 GiB of free space for the default model, cached source, and
build output.
For Debian or Ubuntu:

```bash
sudo apt-get update
sudo apt-get install build-essential cmake git curl libvulkan-dev glslc vulkan-tools
vulkaninfo --summary
```

On AMD, `vulkaninfo` must list the intended Radeon GPU. Vulkan acceleration
does not require a CUDA GPU. If the Vulkan checks fail, `--backend auto` safely
builds the CPU backend instead.

### Install

For a new application setup, opt in to whisper.cpp while installing everything
else:

```bash
VCF_INSTALL_WHISPER_CPP=1 \
VCF_WHISPER_CPP_MODEL_NAME=large-v3 \
VCF_WHISPER_CPP_BACKEND=auto \
./scripts/setup-linux.sh
```

The opt-in setup passes the repository's `.env` to the helper, which atomically
adds or replaces only `VCF_WHISPER_CPP_PATH`, `VCF_WHISPER_CPP_MODEL`, and
`VCF_WHISPER_CPP_VAD_MODEL`, and preserves every unrelated setting. Set
`VCF_WHISPER_CPP_ENV_FILE=/absolute/path/to/custom.env` to configure a different
environment file.

For an application that is already set up:

```bash
./scripts/install-whisper-cpp.sh \
  --model large-v3 \
  --backend auto \
  --env-file "$PWD/.env"
```

The helper accepts `--backend auto|vulkan|cpu`, `--model NAME`,
`--vad-model NAME`, `--no-vad`, `--prefix DIR`, `--source-dir DIR`,
`--ref GIT_REF`, `--env-file PATH`, `--force`, and `--print-env`. Without
`--env-file`, a standalone install prints the generated
assignments instead of writing configuration. `--print-env` also prints them
when an environment file was requested. The output is produced after a
successful install and verification; it is not a dry-run flag. A valid existing
binary and model are reused, while failed or partial model downloads are not
accepted.

The installed launcher, CLI, and shared libraries are copied under the prefix,
so clearing the source/build cache after a successful installation does not
break transcription. A later reinstall will clone and build the source again.

With the default prefix, the generated configuration is equivalent to the
following, replacing `your-user` with the actual account name:

```dotenv
VCF_WHISPER_CPP_PATH=/home/your-user/.local/bin/whisper-cli
VCF_WHISPER_CPP_MODEL=/home/your-user/.local/share/whisper.cpp/models/ggml-large-v3.bin
VCF_WHISPER_CPP_VAD_MODEL=/home/your-user/.local/share/whisper.cpp/models/ggml-silero-v6.2.0.bin
```

Use absolute paths. A leading `~` is not expanded by the dashboard capability
check. Restart `node dashboard/server.js` after changing `.env`.

### Model choice

These are the upstream multilingual model sizes most relevant to this
application:

| Model | Download | Good fit |
| --- | ---: | --- |
| `small` | 466 MiB | Faster transcription on limited hardware |
| `medium` | 1.5 GiB | Balanced speed and accuracy |
| `large-v3-turbo` | 1.5 GiB | Faster large-family alternative |
| `large-v3-q5_0` | 1.1 GiB | Quantized large-v3 when disk/memory is tighter |
| `large-v3` | 2.9 GiB | Best accuracy; project helper default |

Upstream estimates about 852 MB of runtime memory for `small`, 2.1 GB for
`medium`, and 3.9 GB for the full `large-v3`. English-only `.en` and other
quantized variants are also available; quantization trades some model fidelity
for a smaller footprint. The filename selected by `VCF_WHISPER_CPP_MODEL` is
the model whisper.cpp actually loads; changing the dashboard model-size field
does not download or switch this external file. Install another model and
update the path when you want to change it.

### Language detection and Silero VAD

whisper.cpp requests automatic language detection by default. Set
`VCF_WHISPER_CPP_LANGUAGE` to a supported language code only when the recording
language is known; use `auto` for mixed or unknown inputs.

When `VCF_WHISPER_CPP_VAD_MODEL` points to a readable Silero model, the app
enables whisper.cpp VAD before transcription. A missing or stale optional VAD
path safely falls back to ordinary whole-audio transcription. The installer
downloads Silero v6.2.0 from the official whisper.cpp model source and verifies
its pinned SHA-256. Use `--no-vad` when VAD should not be installed or written
to the environment file.

The upstream VAD defaults are suitable for most recordings. These optional
environment values tune them; malformed or out-of-range values are ignored:

```dotenv
VCF_WHISPER_CPP_VAD_THRESHOLD=0.5
VCF_WHISPER_CPP_VAD_MIN_SPEECH_DURATION_MS=250
VCF_WHISPER_CPP_VAD_MIN_SILENCE_DURATION_MS=100
VCF_WHISPER_CPP_VAD_MAX_SPEECH_DURATION_S=300
VCF_WHISPER_CPP_VAD_SPEECH_PAD_MS=30
VCF_WHISPER_CPP_VAD_SAMPLES_OVERLAP=0.1
```

### Verify and recover

Check the installed files before starting the server:

```bash
test -x "$HOME/.local/bin/whisper-cli"
test -r "$HOME/.local/share/whisper.cpp/models/ggml-large-v3.bin"
test -r "$HOME/.local/share/whisper.cpp/models/ggml-silero-v6.2.0.bin"
"$HOME/.local/bin/whisper-cli" --help
./venv/bin/python scripts/doctor.py
```

The doctor's `whisperCpp` entry should report `"available": true` and
`"vad_model_available": true`. It reads the non-secret whisper.cpp paths from
`.env` for this check.

After the server is restarted, **Settings → Hardware** should show
`whisper.cpp` as available. The same check is exposed through the local API:

```bash
curl -fsS http://127.0.0.1:3000/api/system/capabilities | \
  ./venv/bin/python -m json.tool
```

In `transcriptionProviders`, the `whisper_cpp` entry should report
`"available": true`.

Use **Auto local** when graceful provider selection matters. It prefers
accelerated PyTorch Whisper, then a ready whisper.cpp installation, then
PyTorch Whisper on CPU. To replace a broken or incompatible Vulkan build with
the portable CPU build:

```bash
./scripts/install-whisper-cpp.sh \
  --model large-v3 \
  --backend cpu \
  --env-file "$PWD/.env"
```

Add `--force` only when the existing build or model must be replaced; forcing
replacement downloads and verifies the 2.9 GiB model again.

## Optional Transcription and Viral-Analysis Providers

The default path stays local: PyTorch Whisper performs transcription (`turbo` is available alongside the original Whisper models), then the built-in heuristics find candidate moments. Provider failures fall back gracefully to the available local path instead of aborting the render.

The easiest option is **Settings → Provider credentials** in the dashboard. Secret fields are write-only: after saving, the UI shows whether a credential is configured but cannot retrieve it. Values saved there are stored in `dashboard/runtime/provider-settings.json`, which is git-ignored and created with owner-only file permissions (`0600`). This protects the file from other non-privileged users, but it is not encrypted; an administrator with access to the server account can still read it.

You can instead configure providers through environment variables:

```dotenv
# Portable local transcription (Vulkan, HIP/ROCm, CUDA, or CPU)
VCF_WHISPER_CPP_PATH=/absolute/path/to/whisper-cli
VCF_WHISPER_CPP_MODEL=/absolute/path/to/ggml-large-v3.bin
VCF_WHISPER_CPP_LANGUAGE=auto
VCF_WHISPER_CPP_VAD_MODEL=/absolute/path/to/ggml-silero-v6.2.0.bin

# Cloud transcription and automatic topic extraction
DEEPGRAM_API_KEY=

# Local semantic reranking through an OpenAI-compatible endpoint
VCF_LOCAL_LLM_URL=http://127.0.0.1:8080/v1/chat/completions
VCF_LOCAL_LLM_MODEL=your-local-model-name
VCF_LOCAL_LLM_API_KEY=

# Optional cloud video-and-audio analysis
GEMINI_API_KEY=
```

Dashboard-saved values override the matching environment value. Clearing a dashboard-saved credential returns that provider to its environment configuration, when one exists. `VCF_LOCAL_LLM_API_KEY` is optional for local servers that do not require authentication. Configuring a key only makes a provider available; it does not enable it. Choose Deepgram as the transcription provider, local semantic reranking, or Gemini analysis explicitly in each job's settings. Deepgram and Gemini send media to their respective cloud services only for an opted-in job.

Topic discovery is automatic. There is no custom keyword-entry step: transcript topics and semantic context supplement the existing signals so strong moments are not limited to a fixed keyword list. If an optional provider is unavailable or errors, the job records the fallback and continues with the remaining local analysis.

Equivalent CLI controls are:

```text
--transcription-provider auto|openai_whisper|whisper_cpp|deepgram
--transcription-model tiny|base|small|medium|large-v3|turbo
--local-semantic
--gemini-analysis
```

## FFmpeg

This project shells out to the system `ffmpeg` binary. It is not bundled in the repo.

## YOLO Weights

The Python pipeline loads `yolov8n.pt`. Do not commit model weights to git.

Depending on your Ultralytics setup, the weight file may be downloaded automatically on first run, or you may need to place it in the repo root manually.

Ultralytics publishes YOLO under AGPL-3.0 or its Enterprise license. This
project takes the AGPL route, so a network deployment must give every remote
user access to the complete corresponding source. Set `VCF_SOURCE_URL` in your
local `.env` to a public URL for the exact deployed revision; the dashboard
renders that source link in its legal notice. Do not use a private or
token-protected URL. If you cannot publish the complete corresponding source,
including any YOLO weights you distribute, obtain an Ultralytics Enterprise
license before using YOLO in that deployment.

## Fonts

The clean repo only ships a bundled set of open-source preview fonts. For best bake/preview parity on your machine, install compatible system fonts such as:

- Montserrat
- Anton
- Bebas Neue
- Oswald
- Poppins
- Barlow Condensed
- Archivo Black
- Rajdhani
- Liberation Sans / Serif / Mono
- DejaVu Sans / Serif

## Publishing

See [PUBLISHING.md](PUBLISHING.md) for private GitHub repo setup and clone/install instructions.
