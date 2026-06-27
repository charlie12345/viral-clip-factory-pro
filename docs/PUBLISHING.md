# Publishing To GitHub

Use a private GitHub repository until the app is ready for public release.

## What Should Be Committed

Commit source code, docs, config examples, bundled open-source fonts, and empty `.gitkeep` runtime folders.

Do not commit:

- `.env` or other secrets
- uploaded source videos
- generated clips
- `dashboard/runtime/` logs/state
- `temp_processing/` contents
- `node_modules/`
- `venv/`
- YOLO weights such as `yolov8n.pt`
- Whisper/PyTorch model caches

The current `.gitignore` is set up for this split.

## Create A Private Repo With GitHub CLI

First authenticate the GitHub CLI:

```bash
gh auth login -h github.com
gh auth status
```

Then, from the project root:

```bash
git status -sb
git add .
git commit -m "Initial private release"
gh repo create viral-clip-factory-pro --private --source=. --remote=origin --push
```

If you want a different repo name, replace `viral-clip-factory-pro`.

## Clone And Run On Another Machine

```bash
git clone git@github.com:YOUR_USER/viral-clip-factory-pro.git
cd viral-clip-factory-pro

# Node 20 LTS recommended
nvm install
nvm use

# JavaScript dependencies
npm install
npm --prefix webui install

# Python dependencies
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt

# Build and run
npm run build
node dashboard/server.js
```

Open `http://localhost:3000`.

## System Packages

Install these outside the repo:

- `ffmpeg`
- Python 3.10+ development headers and `venv`
- Node 20 LTS / npm
- optional NVIDIA driver, CUDA toolkit, and a matching PyTorch build for GPU acceleration
- optional system fonts for best baked subtitle parity

## Build Crash Note

On this workstation, normal Vite builds crashed inside V8 optimization during transform. The webui build script intentionally runs:

```bash
node --no-opt ./node_modules/vite/bin/vite.js build --sourcemap false --minify false
```

That keeps WebAssembly enabled for Vite while avoiding the V8 optimizer crash. If a future Node/Vite combination fixes the crash, `npm --prefix webui run build:fast` uses the normal Vite build.
