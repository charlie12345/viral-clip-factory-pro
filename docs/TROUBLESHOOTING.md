# Troubleshooting

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
