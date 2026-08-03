# Publishing And Cloning

Public source lives at:

```text
https://github.com/charlie12345/viral-clip-factory-pro
```

## What Is Committed

Commit source code, docs, config examples, bundled open-source fonts, tests,
setup scripts, and empty `.gitkeep` runtime folders.

**Do not commit:**

| Path / pattern | Why |
| --- | --- |
| `.env` | Secrets and machine paths |
| `dashboard/runtime/` | Job state, provider credentials, thumbnails |
| `dashboard/uploads/` | User source videos |
| `viral_clips/` | Generated clips and sidecars |
| `temp_processing/` | Scratch media |
| `node_modules/`, `venv/` | Reinstalled by setup scripts |
| `yolov8*.pt`, `*.pt`, `*.bin` | Model weights (downloaded at runtime) |
| `*.mp4`, `*.mov`, `*.mkv`, … | Footage and exports |
| `dashboard/public/dist/` | Web UI build output (rebuilt by setup) |

The root `.gitignore` enforces this split. Before every push:

```bash
git status
git check-ignore -v .env yolov8n.pt dashboard/runtime/provider-settings.json
# Confirm no real keys in the diff:
git diff --cached | rg -i 'api[_-]?key|secret|BEGIN (RSA |OPENSSH )?PRIVATE' || true
```

## Push Updates (maintainers)

```bash
git status -sb
git add -A
git status   # re-check: no .env, no media, no weights
git commit -m "Describe the change"
git push origin main
```

Prefer HTTPS with `gh auth login` or SSH keys. Never put tokens in the repo.

## Clone And Run (end users)

### Linux

```bash
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro
# Need: Node 20, uv, ffmpeg
chmod +x scripts/*.sh
./scripts/setup-linux.sh
cp .env.example .env
node dashboard/server.js
```

Open http://localhost:3000

### Windows (PowerShell)

```powershell
git clone https://github.com/charlie12345/viral-clip-factory-pro.git
cd viral-clip-factory-pro
# Need: Node 20, uv, ffmpeg on PATH
.\scripts\setup-windows.ps1
Copy-Item .env.example .env
node dashboard\server.js
```

Open http://localhost:3000

### Cloud / headless server

See [SETUP.md — Cloud servers](SETUP.md#cloud-servers-vps-and-gpu-vms) for
sizing, GPU notes, Tailscale/SSH access, reverse-proxy auth, and a systemd unit.
Short version: install on Ubuntu, run setup, keep `HOST=127.0.0.1`, publish only
through a VPN or authenticated reverse proxy — the app has no built-in login.

## System Packages Outside The Repo

- `ffmpeg` (+ GPU encode support if you want hardware exports)
- Python 3.12 via `uv`
- Node 20 LTS / npm
- optional AMD ROCm/VAAPI or NVIDIA CUDA/NVENC
- optional whisper.cpp build tools and Vulkan packages in [SETUP.md](SETUP.md#optional-whispercpp-local-transcription)
- optional system fonts for best baked-subtitle parity

## Build Crash Note

On some workstations, normal Vite builds crashed inside V8 optimization during
transform. The webui build script intentionally runs:

```bash
node --no-opt ./node_modules/vite/bin/vite.js build --sourcemap false --minify false
```

That keeps WebAssembly enabled for Vite while avoiding the V8 optimizer crash.
If a future Node/Vite combination fixes the crash,
`npm --prefix webui run build:fast` uses the normal Vite build.
