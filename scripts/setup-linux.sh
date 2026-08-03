#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PYTHON_VERSION="${VCF_PYTHON_VERSION:-3.12}"
TORCH_PROFILE="${VCF_TORCH_PROFILE:-auto}"
TORCH_VERSION="${VCF_TORCH_VERSION:-2.11.0}"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required. Install it from https://docs.astral.sh/uv/ and rerun."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 20-22 and npm are required."
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg and ffprobe must be installed before setup."
  exit 1
fi

uv python install "$PYTHON_VERSION"
uv venv --python "$PYTHON_VERSION" venv

if [[ "$TORCH_PROFILE" == "auto" ]]; then
  if command -v rocminfo >/dev/null 2>&1 && rocminfo 2>/dev/null | grep "gfx1151" >/dev/null; then
    TORCH_PROFILE="amd-gfx1151"
  elif command -v nvidia-smi >/dev/null 2>&1; then
    TORCH_PROFILE="cuda"
  else
    TORCH_PROFILE="cpu"
  fi
fi

case "$TORCH_PROFILE" in
  amd-gfx1151)
    uv pip install --python venv/bin/python \
      --index-url https://repo.amd.com/rocm/whl/gfx1151/ \
      "torch==${TORCH_VERSION}+rocm7.13.0" \
      "torchvision==0.26.0+rocm7.13.0" \
      "torchaudio==${TORCH_VERSION}+rocm7.13.0"
    ;;
  cuda)
    CUDA_INDEX="${VCF_CUDA_INDEX_URL:-https://download.pytorch.org/whl/cu130}"
    uv pip install --python venv/bin/python --index-url "$CUDA_INDEX" \
      "torch==${TORCH_VERSION}" "torchvision==0.26.0" "torchaudio==${TORCH_VERSION}"
    ;;
  cpu)
    uv pip install --python venv/bin/python --index-url https://download.pytorch.org/whl/cpu \
      "torch==${TORCH_VERSION}" "torchvision==0.26.0" "torchaudio==${TORCH_VERSION}"
    ;;
  *)
    echo "Unknown VCF_TORCH_PROFILE: $TORCH_PROFILE"
    exit 1
    ;;
esac

uv pip install --python venv/bin/python --no-deps -r requirements.lock.txt
npm ci
npm --prefix webui ci
npm run build

if [[ "${VCF_INSTALL_WHISPER_CPP:-0}" == "1" ]]; then
  whisper_args=(
    --model "${VCF_WHISPER_CPP_MODEL_NAME:-large-v3}"
    --backend "${VCF_WHISPER_CPP_BACKEND:-auto}"
    --env-file "${VCF_WHISPER_CPP_ENV_FILE:-$ROOT/.env}"
  )
  [[ -z "${VCF_WHISPER_CPP_PREFIX:-}" ]] || whisper_args+=(--prefix "$VCF_WHISPER_CPP_PREFIX")
  [[ -z "${VCF_WHISPER_CPP_SOURCE_DIR:-}" ]] || whisper_args+=(--source-dir "$VCF_WHISPER_CPP_SOURCE_DIR")
  [[ -z "${VCF_WHISPER_CPP_REF:-}" ]] || whisper_args+=(--ref "$VCF_WHISPER_CPP_REF")
  ./scripts/install-whisper-cpp.sh "${whisper_args[@]}"
fi

echo "Installed with torch profile: $TORCH_PROFILE"
venv/bin/python scripts/doctor.py
