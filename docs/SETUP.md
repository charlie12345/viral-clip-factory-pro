# Setup

## No Personal Keys Needed

The core local app does not require OpenAI keys, Gemini keys, WordPress credentials, or any other user-specific API credentials.

The optional `.env` file is only for local runtime overrides such as port or timeout values.

## Prerequisites

Install these separately on your machine:

- Node.js 20 LTS with `npm` (`.nvmrc` pins `20.20.2`; avoid Node 23+ for now)
- Python 3.10+ with `venv`
- `ffmpeg` available on your `PATH`

Install Python dependencies:

```bash
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
```

Install Node dependencies and build the browser UI:

```bash
npm install
npm --prefix webui install
npm run build
```

The build script uses `node --no-opt`, disables sourcemaps, and disables minification for Vite because this workstation hit intermittent Node/V8 crashes during production transforms. If your machine builds normally, `npm --prefix webui run build:fast` uses a closer-to-standard Vite path.

Start the dashboard:

```bash
node dashboard/server.js
```

Open `http://localhost:3000`.

## Optional GPU Setup

`clip_config.yaml` currently enables GPU acceleration. If you do not have a compatible NVIDIA/CUDA setup, either:

- install the correct PyTorch/CUDA stack for your machine, or
- change `processing.gpu_acceleration` to `false`

## FFmpeg

This project shells out to the system `ffmpeg` binary. It is not bundled in the repo.

## YOLO Weights

The Python pipeline loads `yolov8n.pt`. Do not commit model weights to git.

Depending on your Ultralytics setup, the weight file may be downloaded automatically on first run, or you may need to place it in the repo root manually.

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
