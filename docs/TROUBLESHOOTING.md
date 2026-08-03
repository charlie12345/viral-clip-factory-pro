# Troubleshooting

## whisper.cpp Shows As Unavailable

The dashboard requires both a runnable CLI and a readable GGML model. Run the
installer's configuration report with the same model, backend, and custom path
options used for installation, copy its generated assignments into `.env`,
and restart the Node server. The helper verifies or completes the installation
before it prints; `--print-env` is not a dry run.

```bash
./scripts/install-whisper-cpp.sh --print-env
```

Use absolute paths in `.env`; a leading `~` is not expanded by the dashboard.
If `vulkaninfo --summary` cannot see the intended GPU or the Vulkan binary will
not start, rebuild the portable CPU variant:

```bash
./scripts/install-whisper-cpp.sh \
  --model large-v3 \
  --backend cpu \
  --env-file "$PWD/.env"
```

Use `--force` only if the existing build or model is damaged because it also
downloads and verifies a replacement model.

See [SETUP.md](SETUP.md#optional-whispercpp-local-transcription) for the full
installation and verification procedure.

If whisper.cpp is ready but `vad_model_available` is false in
`scripts/doctor.py`, rerun the installer without `--no-vad`. A missing VAD
model does not stop transcription; it only disables silence-aware prefiltering.

## Node, TypeScript, Or Vite Segfaults

This workstation hit intermittent crashes while building the React UI. The practical fixes were:

```bash
# Use the pinned Node 20 LTS runtime
nvm install
nvm use

# Clear generated TypeScript cache
rm -f webui/*.tsbuildinfo

# If TypeScript reports impossible syntax errors inside node_modules, rewrite packages
npm --prefix webui install --force

# Build using the guarded project script
./scripts/build-webui.sh
```

The project build script runs Vite with:

```bash
node --no-opt ./node_modules/vite/bin/vite.js build --sourcemap false --minify false
```

That avoids the V8 optimizer crash seen during Vite transforms and keeps the build memory footprint lower by disabling sourcemaps and minification.

## Python Segfaults

If Python starts segfaulting after package changes, recreate the virtual environment rather than layering more packages into a possibly corrupted environment:

```bash
mv venv venv.broken.$(date +%Y%m%d%H%M%S)
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt
./venv/bin/python -m py_compile viral_factory.py
```

If segfaults continue in both Node and Python, check system-level causes: RAM instability, disk/filesystem errors, bad native packages, or incompatible runtime/library builds.
