# Viral Clip Factory

Local-first viral clip generator with:

- a browser dashboard on port `3000` (React + TypeScript + Tailwind, built into `dashboard/public/dist/`)
- a Node/Express upload, preview, and job-control server
- a Python render/transcription pipeline with graceful SIGTERM cancel
- baked subtitles, subtitle style previews, clip re-rendering, and an in-browser caption editor
- a job queue with cancel and history, render profiles, and batch operations

This public repo is a sanitized clone of the working app. It does not include personal secrets, local logs, uploaded media, generated clips, or machine-specific runtime state.

## Do I Need API Keys?

No for the core app.

You do need local software installed on your machine:

- Node.js 20+
- Python 3
- `ffmpeg`
- Python dependencies from `requirements.txt`

You may also need:

- a CUDA-capable PyTorch install if you want GPU acceleration
- optional system fonts if you want the baked subtitles to match the browser preview as closely as possible

## Quick Start

Use Node 20 LTS. This repo includes an `.nvmrc` pinned to `20.20.2`. The production web build runs Vite through `node --no-opt` because this machine hit a V8 optimizer crash during Vite transforms.

```bash
# 1. Install JS deps for the server + webui
npm install
npm --prefix webui install

# 2. Build the React front-end (outputs to dashboard/public/dist/)
npm run build

# 3. Install Python deps
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# 4. Run the server (also serves the built webui)
node dashboard/server.js
```

Then open:

- `http://localhost:3000`

For hot-reload development of the front-end:

```bash
npm run dev    # runs the Vite dev server (5173) and the Express server (3000) together
```

The Vite dev server proxies `/api`, `/clips`, and other Express routes to port 3000.

## Web UI

The new React + TypeScript front-end lives under `webui/` and is a strict replacement for the older single-file `dashboard/public/index.html` (now archived as `dashboard/public/index-legacy.html` for reference).

Five pages, single sidebar nav:

- **Dashboard** — stats, new-render wizard, live log feed
- **Library** — searchable clip grid, multi-select, batch delete, batch re-render, batch download, server-generated thumbnails
- **Editor** — full-page caption editor (replaces the old modal) with live preview, drag-to-reposition overlay, font/zoom sliders, word-level timing, Apply & Re-render, Bake & Download
- **Jobs** — active job with cancel, full job history, live logs
- **Settings** — upload defaults, render profiles, editor preferences, server info

All `/api/*` routes are unchanged from the original; the UI is a thin shell over the same Python pipeline.

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
```

Runtime directories are created locally and ignored by git:

- `dashboard/runtime/`
- `dashboard/uploads/`
- `temp_processing/`
- `viral_clips/`

## Required Local Installs

See [SETUP.md](docs/SETUP.md) for the full setup guide.

## Third-Party Software

See [THIRD_PARTY.md](docs/THIRD_PARTY.md) for dependency and licensing notes. See [TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) for build/runtime segfault recovery steps.

## Current License Position

This repo includes a `LICENSE` using `AGPL-3.0-only` as the safest default because the current implementation imports Ultralytics YOLO directly. Review that choice before publishing if you later replace that dependency or obtain separate licensing terms.
