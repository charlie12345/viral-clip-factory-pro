# Viral Clip Factory

Local-first viral clip generator with:

- a browser dashboard on port `3000` (React + TypeScript + Tailwind, built into `dashboard/public/dist/`)
- a Node/Express upload, preview, and job-control server
- a Python render/transcription pipeline with graceful SIGTERM cancel
- automatic AMD ROCm/VAAPI/AMF, NVIDIA CUDA/NVENC, and CPU fallback
- smart speaker switching with stable talking-head tracking, camera-off rejection, and 2D portrait crops
- duration-aware Shorts yield modes, confidence tiers, render reserves, and Generate More without re-transcription
- visual-first multi-clip action/cosplay compilations with motion-aware cuts and transitions, without requiring speech
- a non-destructive long-form editor with waveform preview, manual/transcript cuts, undo/redo, autosave, and audio finishing
- baked subtitles, an original animated caption-style studio, clip re-rendering, and an in-browser caption editor
- a job queue with cancel and history, render profiles, and batch operations

The repository does not include personal secrets, local logs, uploaded media, generated clips, model weights, or machine-specific runtime state.

## Clean-clone privacy and repository safety

This public source tree is designed to be safe to clone and start from scratch:

- Uploaded footage, rendered clips, source copies, download/job history, temporary render files, and local runtime state are ignored by Git.
- `.env` files, private keys, credential files, model weights, virtual environments, generated web bundles, and local FFmpeg downloads are ignored too.
- The only credential file in the repository is [`.env.example`](.env.example), which contains empty placeholders. Copy it to `.env` locally; never commit your populated `.env` file.
- The app creates its upload, output, and job-history directories on the machine that runs it. A fresh clone contains only placeholder directories, not anyone’s content.

If you are publishing a fork or contributing changes, run `git status --ignored` before committing and stage named source files instead of using a blanket `git add -A`.

## Do I Need API Keys?

No for the core app.

You do need local software installed on your machine:

- Node.js 20-22
- Python 3.12
- `ffmpeg`
- Python dependencies from `requirements.txt`

You may also need:

- a ROCm-capable AMD or CUDA-capable NVIDIA PyTorch install if you want GPU acceleration
- optional system fonts if you want the baked subtitles to match the browser preview as closely as possible

Optional analysis providers are disabled until you select them for a job. The local defaults use PyTorch Whisper (including the `turbo` model) and the existing on-device viral-moment heuristics. You can additionally configure:

- `whisper.cpp` for portable Vulkan, HIP/ROCm, CUDA, or CPU transcription with automatic language detection and optional Silero VAD
- Deepgram Nova-3 for cloud transcription and automatic topic extraction
- a local OpenAI-compatible model server for semantic moment reranking
- Gemini for supplementary video-and-audio moment analysis

Cloud media is uploaded only when its provider is explicitly selected for that job. Add or replace provider credentials from **Settings → Provider credentials**, or supply the equivalent environment variables. Saved credentials stay in a git-ignored, owner-only server file and are never returned to the browser. See [SETUP.md](docs/SETUP.md#optional-transcription-and-viral-analysis-providers) for configuration.

## Get It From GitHub And Run It

Repository: https://github.com/charlie12345/viral-clip-factory-pro

### What you need on every machine

| Requirement | Notes |
| --- | --- |
| **Node.js 20 LTS** (20–22) | `.nvmrc` pins `20.20.2`. Avoid Node 23+ for now. |
| **Python 3.12** | Installed via [`uv`](https://docs.astral.sh/uv/) by the setup scripts |
| **`uv`** | https://docs.astral.sh/uv/ |
| **`ffmpeg` + `ffprobe`** | Must be on your `PATH` |
| Disk | Several GB for dependencies; 10+ GB free recommended for media work |
| GPU (optional) | AMD ROCm / NVIDIA CUDA for faster transcription and encoding; CPU works |

No API keys are required for the core local app. Optional cloud providers
(Deepgram, Gemini) are off until you enable them per job.

### Fresh GitHub clone: quickest supported path

For a new Linux machine, install **Git**, **Node.js 20–22**, **uv**, and an
`ffmpeg` build that includes `ffprobe`; then run:

```bash
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro
./scripts/setup-linux.sh
cp .env.example .env  # optional; leave provider-key fields empty for local-only use
npm start
```

Open `http://localhost:3000`, then verify the installation with
`./venv/bin/python scripts/doctor.py`. The setup script installs the Python
environment, Node dependencies, and the production web build. It chooses a
CPU profile when no supported GPU runtime is available. Windows users should
follow the PowerShell steps below; server and GPU deployment guidance is in
[docs/SETUP.md](docs/SETUP.md).

### Linux

```bash
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro

# Install system tools first (Debian/Ubuntu example)
# sudo apt-get update
# sudo apt-get install -y ffmpeg git curl
# Install Node 20 LTS and uv if you do not already have them.

chmod +x scripts/*.sh
./scripts/setup-linux.sh   # auto-detects AMD gfx1151, NVIDIA CUDA, or CPU

# Optional: also install whisper.cpp + large-v3 (≈2.9 GiB model)
# VCF_INSTALL_WHISPER_CPP=1 ./scripts/setup-linux.sh

cp .env.example .env       # optional runtime overrides
node dashboard/server.js   # or: npm start
```

Open **http://localhost:3000**

Force a torch profile if auto-detection is wrong:

```bash
VCF_TORCH_PROFILE=cpu ./scripts/setup-linux.sh
# VCF_TORCH_PROFILE=cuda
# VCF_TORCH_PROFILE=amd-gfx1151
```

### Windows

1. Install [Node.js 20 LTS](https://nodejs.org/), [Git](https://git-scm.com/),
   [`uv`](https://docs.astral.sh/uv/), and an FFmpeg build that includes the
   encoders you need (`h264_amf` / `hevc_amf` for AMD, NVENC for NVIDIA, or
   software x264).
2. Open **PowerShell** in a folder where you want the project:

```powershell
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro

.\scripts\setup-windows.ps1
# Optional: force a profile
# .\scripts\setup-windows.ps1 -TorchProfile cpu
# .\scripts\setup-windows.ps1 -TorchProfile cuda
# .\scripts\setup-windows.ps1 -TorchProfile amd-gfx1151

Copy-Item .env.example .env
node dashboard\server.js
```

Open **http://localhost:3000**

### Cloud server (VPS / GPU VM)

The app is a local dashboard with **no built-in login**. Do not expose port
3000 to the public internet without a reverse proxy, TLS, and authentication
(or a private network such as Tailscale / WireGuard / VPC).

Minimum practical cloud box:

- **CPU-only**: 4+ vCPU, 16 GB RAM, 50+ GB SSD (transcription will be slow)
- **GPU recommended**: NVIDIA T4 / L4 / A10 (or better) with recent drivers + CUDA-capable FFmpeg, **or** an AMD ROCm-capable instance
- Ubuntu 22.04/24.04 LTS is the best-supported server OS
- Persistent disk for uploads and renders (`VCF_MEDIA_ROOT`)

```bash
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro
./scripts/setup-linux.sh          # or VCF_TORCH_PROFILE=cuda ./scripts/setup-linux.sh
cp .env.example .env
# Edit .env:
#   HOST=0.0.0.0          # listen on all interfaces (still protect with firewall/proxy)
#   PORT=3000
#   VCF_MEDIA_ROOT=/var/lib/viral-clip-factory
#   VCF_MEDIA_MOUNT=/var/lib   # optional: refuse to start if volume is missing
node dashboard/server.js
```

Put a reverse proxy (Caddy, nginx, Traefik) with HTTPS and basic auth / SSO in
front of the Node process, or bind to localhost and publish only through
**Tailscale Serve** / a VPN. Full cloud checklist, firewall notes, and systemd
unit: [SETUP.md — Cloud servers](docs/SETUP.md#cloud-servers-vps-and-gpu-vms).

### Optional whisper.cpp (Linux)

`whisper.cpp` is optional because models are large. During a fresh Linux setup:

```bash
VCF_INSTALL_WHISPER_CPP=1 ./scripts/setup-linux.sh
```

On an existing install:

```bash
./scripts/install-whisper-cpp.sh --model large-v3 --backend auto --env-file "$PWD/.env"
```

See [SETUP.md](docs/SETUP.md#optional-whispercpp-local-transcription) for
prerequisites, model choices, verification, and CPU fallback.

### Development (hot reload)

```bash
npm run dev    # Vite on 5173 + Express on 3000
```

The Vite dev server proxies `/api`, `/clips`, and other Express routes to port 3000.

### Verify the install

```bash
# Linux
./venv/bin/python scripts/doctor.py
curl -fsS http://127.0.0.1:3000/api/system/capabilities | ./venv/bin/python -m json.tool

# Windows
.\venv\Scripts\python.exe scripts\doctor.py
```

## Web UI

The new React + TypeScript front-end lives under `webui/` and is a strict replacement for the older single-file `dashboard/public/index.html` (now archived as `dashboard/public/index-legacy.html` for reference).

The primary pages use a single sidebar nav, with dedicated editors opened from the Library:

- **Dashboard** — stats, new-render wizard, live log feed
- **Library** — searchable shorts and long-form grid, confidence tiers, Generate More from saved candidates, batch operations, and thumbnails
- **Editor** — full-page caption editor (replaces the old modal) with a live caption-style studio, drag-to-reposition overlay, font/zoom sliders, word-level timing, optional static text glow, Apply & Re-render, and Bake & Download
- **Long-form editor** — edited playback, waveform/playhead, acoustic silence analysis, manual and filler-review cuts, editable boundaries, undo/redo, autosaved drafts, transcript seeking, loudness normalization, limiter, denoise, and hard-picture-cut/microfade controls
- **Montage** — build either a 15–90 second vertical montage from 2–20 short clips or a 3–15 minute horizontal montage from 1–20 long-form videos, with visual goals, pacing, source coverage, ordering, and transition controls
- **Jobs** — active job with cancel, full job history, live logs
- **Settings** — upload defaults, render profiles, editor preferences, server info

Existing `/api/*` routes remain compatible; the UI also uses the hardware-capability endpoint added for backend diagnostics.

Long-form renders preserve transcript/topic metadata and write edited-timeline transcript, SRT, and VTT sidecars automatically. When chapter markers are present in the project metadata, a YouTube-style chapter text file is emitted as well.

### Vertical and Horizontal AI Montages

Open **Montage** in the sidebar or choose **AI Montage** from the Dashboard. The
prominent format selector offers **Short Montage** (vertical 9:16) and
**Long-Form Montage** (horizontal 16:9). The local compilation worker samples
every source for faces, people, motion peaks,
scene changes, sharpness, exposure, and color. It tracks the largest persistent
foreground person by their full bounding box, while a face only refines the
person it actually belongs to. This stops a small background attendee from
pulling the crop away from the cosplayer. A dominant person is placed on a
rule-of-thirds line only when their body and costume remain contained; wide or
moving subjects use a full-costume contextual view over a soft blurred vertical
background. Low-confidence shots safely fall back to a center crop. It rejects weak black/static frames, selects diverse moments,
sequences them into an energy curve, and renders clean audio/video joins with
smart, minimal, or hard-cut transitions. This path does not run Whisper and does
not depend on spoken words or captions.

**Short Montage** accepts 2–20 clips, normalizes mixed source formats to vertical
9:16, and offers 15, 30, 45, 60, and 90 second targets. **Long-Form Montage**
accepts 1–20 long-form videos, preserves a horizontal 16:9 presentation, and
offers 3, 5, 10, and 15 minute targets. Horizontal results are registered as
long-form exports, so they open in the long-form editor from Library.

For **Short Montage**, the sequencer distributes strong moments from the same
uploaded clip across the edit. Two short-form cuts from the same source are
never placed next to each other; when the material is too imbalanced, the
weakest excess moments are dropped. **Long-Form Montage** prefers alternating
sources in automatic mode, but can place distinct, non-overlapping moments from
one source together when that is the only material left. Turning automatic
sequencing off keeps uploaded source order and each source's chronology.

Every completed montage is forced to browser-compatible H.264 `yuv420p`, then
probed for its dimensions and duration and fully decoded once before its atomic
publish. An incomplete or incompatible render is rejected instead of appearing
as a successful black or zero-duration Library item.

The server retains the staged sources and manifest for exactly the newest
successful montage (bounded by the 2GB upload limit), replacing the prior cache
only after a new montage succeeds. This makes the latest project safely
rerunnable without accumulating every upload indefinitely.
The latest failed montage also receives one bounded recovery slot, replacing
the prior failed attempt while preserving the latest successful project.

The Dashboard exposes **Short or Long-Form Montage** directly inside Output Mode
and beneath the regular one-video upload box. Sources selected in the Montage
page are submitted together as one job rather than as separate renders.

Choose **Use every clip/video** when every uploaded source must
appear. Choose **Best moments** when weak sources may be omitted. Finished
compilations appear in Library with a **9:16 Montage** or **16:9 Montage** badge,
while their selected shots and reasons are preserved in the adjacent JSON
sidecar.

The default **Creator mix** keeps ordinary joins as true hard cuts and inserts
a varied transition after every third or fourth outgoing clip: Swipe left,
Swipe right, Pull up, then Pull down. The cadence repeats at clips 3, 7, 10,
14, 17, and so on. **Smooth fades** and **Hard cuts** remain available when a
different style is wanted.

Compilation uploads are disk-backed and resumable. Each source is transferred
sequentially in 32MB chunks, so a network interruption or paused browser does
not restart already saved footage. After a page reload, reselect the same files
to continue the saved session. The defaults allow 20GB per video and 100GB per
montage, retain incomplete sessions for 72 hours, and preserve 50GB of free
space on the configured media volume. Limits and retention can be overridden
with the `VCF_COMPILATION_*` environment variables documented in
`.env.example`.

Set `VCF_MEDIA_ROOT` to a roomy, persistent filesystem. Incoming chunks,
retained recovery sources, multipart staging, and disposable montage render
work are kept beneath that root instead of the system temporary directory. The
finished 1080p montage still appears normally in Library.
For removable storage, also set `VCF_MEDIA_MOUNT` to its mount point. The server
then refuses to start if the volume is missing, preventing large uploads from
falling through onto the system disk.

## Project Layout

```text
dashboard/
  public/
    dist/           # Vite build output (generated)
    fonts/          # bundled creator fonts
    index-legacy.html  # old single-page UI, kept for reference
  server.js
  runtime/          # generated at runtime
docs/
webui/              # React + TypeScript + Tailwind front-end
  src/
clip_config.yaml
requirements.txt
viral_factory.py
action_compilation.py
```

Runtime directories are created locally and ignored by git:

- `dashboard/runtime/`
- `dashboard/uploads/`
- `temp_processing/`
- `viral_clips/`

## Hardware Controls

Settings exposes the detected compute and video backends. Each job can use:

- compute: `auto`, `rocm`, `cuda`, or `cpu`
- video: `auto`, `vaapi`, `amf`, `nvenc`, or `cpu`
- local PyTorch Whisper with models from `tiny` through `large-v3` plus `turbo`, or optional `whisper.cpp` with an explicitly configured GGML model (`large-v3` by default) and Silero VAD
- optional Deepgram transcription, local semantic reranking, and Gemini video analysis
- Generic, YouTube Shorts, Instagram Reels, and TikTok export presets

Run `./venv/bin/python scripts/doctor.py` to inspect the full environment. See [HARDWARE.md](docs/HARDWARE.md) for Linux and Windows GPU setup.

## Tests

```bash
npm run test:node
./venv/bin/python -m unittest discover -s tests -v
npm run typecheck:webui
```

## Required Local Installs

See [SETUP.md](docs/SETUP.md) for the full setup guide.

## Third-Party Software

See [THIRD_PARTY.md](docs/THIRD_PARTY.md) for dependency and licensing notes. See [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for build/runtime segfault recovery steps.

## License and Ultralytics YOLO

Viral Clip Factory is released under **AGPL-3.0-only**; see [LICENSE](LICENSE).
That is the open-source route required for this project because it imports
Ultralytics YOLO and uses its downloadable YOLO weights. Under Ultralytics'
published licensing terms, an application using its code, models, or training
pipeline must either release the complete corresponding project source under
AGPL-3.0 or hold an Ultralytics Enterprise license.

If you deploy the app where people can access it over a network, AGPL section
13 requires you to prominently offer those users the corresponding source at no
charge. The current public corresponding source is available in the
[Viral Clip Factory source tree](https://github.com/charlie12345/viral-clip-factory-pro/tree/main).
The UI provides a **Source & license** link for this purpose. Set
`VCF_SOURCE_URL` to the public URL for the exact source revision you deploy,
including your changes, scripts, and configuration. A private repository or an
inaccessible link does not meet that requirement.

Do not distribute a proprietary or private YOLO-enabled build under this
repository's default terms. For commercial use, either meet the same AGPL
source-availability requirements or obtain an Ultralytics Enterprise license.
Alternatively, remove Ultralytics YOLO and its weights and complete a fresh
license review. See [THIRD_PARTY.md](docs/THIRD_PARTY.md) for the audited
dependency and font notices.
