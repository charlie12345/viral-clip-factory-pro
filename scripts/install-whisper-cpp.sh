#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${VCF_WHISPER_CPP_MODEL_NAME:-large-v3}"
VAD_MODEL="${VCF_WHISPER_CPP_VAD_MODEL_NAME:-silero-v6.2.0}"
INSTALL_VAD="${VCF_WHISPER_CPP_INSTALL_VAD:-1}"
BACKEND="${VCF_WHISPER_CPP_BACKEND:-auto}"
PREFIX="${VCF_WHISPER_CPP_PREFIX:-$HOME/.local}"
SOURCE_DIR="${VCF_WHISPER_CPP_SOURCE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/viral-clip-factory/whisper.cpp}"
REF="${VCF_WHISPER_CPP_REF:-master}"
ENV_FILE="${VCF_WHISPER_CPP_ENV_FILE:-}"
FORCE=0
PRINT_ENV=0

usage() {
  cat <<'EOF'
Install whisper.cpp plus integrity-checked Whisper and Silero VAD models.

Usage: ./scripts/install-whisper-cpp.sh [options]

Options:
  --model NAME        Official whisper.cpp model (default: large-v3)
  --vad-model NAME    Silero VAD model (default: silero-v6.2.0)
  --no-vad            Do not install or configure the optional VAD model
  --backend NAME      auto, vulkan, or cpu (default: auto)
  --prefix PATH       Install prefix (default: $HOME/.local)
  --source-dir PATH   whisper.cpp source/build directory
  --ref REF           Git branch, tag, or commit used for a new clone
  --env-file PATH     Atomically configure the app's whisper.cpp variables
  --print-env         Print the environment assignments after installation
  --force             Rebuild and replace an invalid/existing model
  -h, --help          Show this help

Environment equivalents use the VCF_WHISPER_CPP_* prefix. Examples include
VCF_WHISPER_CPP_MODEL_NAME, VCF_WHISPER_CPP_VAD_MODEL_NAME,
VCF_WHISPER_CPP_INSTALL_VAD, VCF_WHISPER_CPP_BACKEND,
VCF_WHISPER_CPP_PREFIX, VCF_WHISPER_CPP_SOURCE_DIR,
VCF_WHISPER_CPP_REF, and VCF_WHISPER_CPP_ENV_FILE.
EOF
}

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required. On Ubuntu/Debian install: git cmake build-essential curl"
}

has_vulkan_gpu() {
  local summary
  summary="$(vulkaninfo --summary 2>/dev/null)" || return 1
  grep -Eq 'PHYSICAL_DEVICE_TYPE_(DISCRETE|INTEGRATED|VIRTUAL)_GPU' <<<"$summary"
}

while (($#)); do
  case "$1" in
    --model|--vad-model|--backend|--prefix|--source-dir|--ref|--env-file)
      (($# >= 2)) || die "$1 requires a value"
      case "$1" in
        --model) MODEL="$2" ;;
        --vad-model) VAD_MODEL="$2" ;;
        --backend) BACKEND="$2" ;;
        --prefix) PREFIX="$2" ;;
        --source-dir) SOURCE_DIR="$2" ;;
        --ref) REF="$2" ;;
        --env-file) ENV_FILE="$2" ;;
      esac
      shift 2
      ;;
    --print-env) PRINT_ENV=1; shift ;;
    --no-vad) INSTALL_VAD=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

case "$BACKEND" in
  auto|vulkan|cpu) ;;
  *) die "--backend must be auto, vulkan, or cpu" ;;
esac

case "$INSTALL_VAD" in
  0|1) ;;
  *) die "VCF_WHISPER_CPP_INSTALL_VAD must be 0 or 1" ;;
esac

for command in git cmake sha1sum sha256sum c++ awk; do
  require_command "$command"
done
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1 && ! command -v wget2 >/dev/null 2>&1; then
  die "curl, wget, or wget2 is required to download the GGML model"
fi

if [[ "$BACKEND" == "auto" ]]; then
  if command -v glslc >/dev/null 2>&1 \
    && command -v vulkaninfo >/dev/null 2>&1 \
    && has_vulkan_gpu; then
    BACKEND="vulkan"
  else
    BACKEND="cpu"
  fi
fi
if [[ "$BACKEND" == "vulkan" ]]; then
  command -v glslc >/dev/null 2>&1 || die "glslc is required for Vulkan. On Ubuntu/Debian install: glslc libvulkan-dev vulkan-tools"
  command -v vulkaninfo >/dev/null 2>&1 || die "vulkaninfo is required for Vulkan. On Ubuntu/Debian install: vulkan-tools"
  has_vulkan_gpu || die "no working Vulkan GPU was detected; fix the driver or use --backend cpu"
fi

mkdir -p "$(dirname "$SOURCE_DIR")" "$PREFIX/bin" "$PREFIX/share/whisper.cpp/models"
if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  [[ ! -e "$SOURCE_DIR" || -z "$(ls -A "$SOURCE_DIR" 2>/dev/null)" ]] || die "$SOURCE_DIR exists but is not a whisper.cpp Git checkout"
  git clone --filter=blob:none https://github.com/ggml-org/whisper.cpp.git "$SOURCE_DIR"
  git -C "$SOURCE_DIR" fetch --depth 1 origin "$REF"
  git -C "$SOURCE_DIR" checkout --detach FETCH_HEAD
else
  origin="$(git -C "$SOURCE_DIR" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == "https://github.com/ggml-org/whisper.cpp.git" || "$origin" == "git@github.com:ggml-org/whisper.cpp.git" ]] \
    || die "$SOURCE_DIR is not the official ggml-org/whisper.cpp checkout"
fi

BUILD_DIR="$SOURCE_DIR/build-$BACKEND"
CLI_BUILD="$BUILD_DIR/bin/whisper-cli"
cli_needs_build=0
if [[ ! -x "$CLI_BUILD" || "$FORCE" == 1 ]]; then
  cli_needs_build=1
elif [[ "$(head -c 2 "$CLI_BUILD" 2>/dev/null || true)" == '#!' ]]; then
  # A build output must be a native executable. Older versions of this helper
  # could follow a prefix symlink and replace this output with the launcher.
  rm -f "$CLI_BUILD"
  cli_needs_build=1
fi
if [[ "$cli_needs_build" == 1 ]]; then
  cmake_args=(-S "$SOURCE_DIR" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release)
  if [[ "$BACKEND" == "vulkan" ]]; then
    cmake_args+=(-DGGML_VULKAN=ON)
  else
    cmake_args+=(-DGGML_VULKAN=OFF)
  fi
  cmake "${cmake_args[@]}"
  cmake --build "$BUILD_DIR" --target whisper-cli --parallel "${VCF_BUILD_JOBS:-$(nproc 2>/dev/null || printf '4')}"
fi
[[ -x "$CLI_BUILD" ]] || die "whisper-cli was not produced at $CLI_BUILD"
RUNTIME_DIR="$PREFIX/libexec/whisper.cpp"
mkdir -p "$RUNTIME_DIR"
runtime_cli_temp="$(mktemp "$RUNTIME_DIR/.whisper-cli.XXXXXX")"
cp "$CLI_BUILD" "$runtime_cli_temp"
chmod 0755 "$runtime_cli_temp"
mv -f "$runtime_cli_temp" "$RUNTIME_DIR/whisper-cli"
shopt -s nullglob
runtime_libraries=("$BUILD_DIR/bin"/lib*.so*)
if ((${#runtime_libraries[@]})); then
  cp -a "${runtime_libraries[@]}" "$RUNTIME_DIR/"
fi
shopt -u nullglob
quoted_runtime_dir="$(printf '%q' "$RUNTIME_DIR")"
launcher_temp="$(mktemp "$PREFIX/bin/.whisper-cli.XXXXXX")"
{
  printf '#!/usr/bin/env bash\n'
  printf 'runtime_dir=%s\n' "$quoted_runtime_dir"
  printf 'export LD_LIBRARY_PATH="$runtime_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\n'
  printf 'exec "$runtime_dir/whisper-cli" "$@"\n'
} >"$launcher_temp"
chmod 0755 "$launcher_temp"
# Atomic replacement is important when an existing launcher is a symlink. A
# direct shell redirection would follow it and overwrite the build artifact.
mv -fT "$launcher_temp" "$PREFIX/bin/whisper-cli"

MODEL_DIR="$PREFIX/share/whisper.cpp/models"
MODEL_PATH="$MODEL_DIR/ggml-$MODEL.bin"
expected_sha1="$({
  awk -F'|' -v wanted="$MODEL" '
    {
      name = $2
      gsub(/[[:space:]]/, "", name)
      if (name == wanted) {
        hash = $4
        gsub(/[^0-9a-f]/, "", hash)
        if (length(hash) == 40) { print hash; exit }
      }
    }
  ' "$SOURCE_DIR/models/README.md"
} || true)"
[[ ${#expected_sha1} -eq 40 ]] || die "no upstream SHA-1 is published for model '$MODEL'; choose a model listed in whisper.cpp/models/README.md"

model_valid=0
if [[ -f "$MODEL_PATH" && "$FORCE" == 0 ]]; then
  actual_sha1="$(sha1sum "$MODEL_PATH" | awk '{print $1}')"
  [[ "$actual_sha1" == "$expected_sha1" ]] && model_valid=1
fi
if [[ "$model_valid" == 0 ]]; then
  [[ ! -e "$MODEL_PATH" || "$FORCE" == 1 ]] || die "$MODEL_PATH failed its upstream SHA-1 check; rerun with --force to replace it"
  TEMP_MODEL_DIR="$(mktemp -d "$MODEL_DIR/.download.XXXXXX")"
  cleanup() { rm -rf "$TEMP_MODEL_DIR"; }
  trap cleanup EXIT
  "$SOURCE_DIR/models/download-ggml-model.sh" "$MODEL" "$TEMP_MODEL_DIR"
  downloaded="$TEMP_MODEL_DIR/ggml-$MODEL.bin"
  [[ -f "$downloaded" ]] || die "the upstream downloader did not produce $downloaded"
  actual_sha1="$(sha1sum "$downloaded" | awk '{print $1}')"
  [[ "$actual_sha1" == "$expected_sha1" ]] || die "downloaded model SHA-1 mismatch (expected $expected_sha1, got $actual_sha1)"
  mv -f "$downloaded" "$MODEL_PATH"
  rm -rf "$TEMP_MODEL_DIR"
  trap - EXIT
  model_valid=1
fi

VAD_MODEL_PATH=""
expected_vad_sha256=""
if [[ "$INSTALL_VAD" == 1 ]]; then
  case "$VAD_MODEL" in
    silero-v6.2.0) expected_vad_sha256="2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987" ;;
    silero-v5.1.2) expected_vad_sha256="29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf" ;;
    *) die "unsupported VAD model '$VAD_MODEL'; choose silero-v6.2.0 or silero-v5.1.2" ;;
  esac

  VAD_MODEL_PATH="$MODEL_DIR/ggml-$VAD_MODEL.bin"
  vad_model_valid=0
  if [[ -f "$VAD_MODEL_PATH" && "$FORCE" == 0 ]]; then
    actual_vad_sha256="$(sha256sum "$VAD_MODEL_PATH" | awk '{print $1}')"
    [[ "$actual_vad_sha256" == "$expected_vad_sha256" ]] && vad_model_valid=1
  fi
  if [[ "$vad_model_valid" == 0 ]]; then
    [[ ! -e "$VAD_MODEL_PATH" || "$FORCE" == 1 ]] \
      || die "$VAD_MODEL_PATH failed its pinned SHA-256 check; rerun with --force to replace it"
    TEMP_VAD_DIR="$(mktemp -d "$MODEL_DIR/.vad-download.XXXXXX")"
    cleanup_vad() { rm -rf "$TEMP_VAD_DIR"; }
    trap cleanup_vad EXIT
    "$SOURCE_DIR/models/download-vad-model.sh" "$VAD_MODEL" "$TEMP_VAD_DIR"
    downloaded_vad="$TEMP_VAD_DIR/ggml-$VAD_MODEL.bin"
    [[ -f "$downloaded_vad" ]] || die "the upstream downloader did not produce $downloaded_vad"
    actual_vad_sha256="$(sha256sum "$downloaded_vad" | awk '{print $1}')"
    [[ "$actual_vad_sha256" == "$expected_vad_sha256" ]] \
      || die "downloaded VAD model SHA-256 mismatch (expected $expected_vad_sha256, got $actual_vad_sha256)"
    mv -f "$downloaded_vad" "$VAD_MODEL_PATH"
    rm -rf "$TEMP_VAD_DIR"
    trap - EXIT
  fi
fi

write_env_file() {
  local target="$1" directory temporary existing_mode
  directory="$(dirname "$target")"
  mkdir -p "$directory"
  existing_mode=""
  if [[ -f "$target" ]]; then
    existing_mode="$(stat -c '%a' "$target" 2>/dev/null || true)"
  fi
  umask 077
  temporary="$(mktemp "$directory/.vcf-env.XXXXXX")"
  if [[ -f "$target" ]]; then
    awk '!/^VCF_WHISPER_CPP_(PATH|MODEL|VAD_MODEL)=/' "$target" >"$temporary"
  fi
  if [[ -s "$temporary" && "$(tail -c 1 "$temporary" | wc -l)" -eq 0 ]]; then
    printf '\n' >>"$temporary"
  fi
  printf 'VCF_WHISPER_CPP_PATH=%s\nVCF_WHISPER_CPP_MODEL=%s\n' "$PREFIX/bin/whisper-cli" "$MODEL_PATH" >>"$temporary"
  if [[ -n "$VAD_MODEL_PATH" ]]; then
    printf 'VCF_WHISPER_CPP_VAD_MODEL=%s\n' "$VAD_MODEL_PATH" >>"$temporary"
  fi
  [[ -z "$existing_mode" ]] || chmod "$existing_mode" "$temporary"
  mv -f "$temporary" "$target"
}

if [[ -n "$ENV_FILE" ]]; then
  write_env_file "$ENV_FILE"
fi

"$PREFIX/bin/whisper-cli" --version >/dev/null
printf 'whisper.cpp installed successfully\n'
printf '  backend: %s\n  executable: %s\n  model: %s\n  SHA-1: %s\n' "$BACKEND" "$PREFIX/bin/whisper-cli" "$MODEL_PATH" "$expected_sha1"
if [[ -n "$VAD_MODEL_PATH" ]]; then
  printf '  VAD model: %s\n  VAD SHA-256: %s\n' "$VAD_MODEL_PATH" "$expected_vad_sha256"
fi
if [[ -n "$ENV_FILE" ]]; then
  printf '  configured: %s\n' "$ENV_FILE"
fi
if [[ "$PRINT_ENV" == 1 || -z "$ENV_FILE" ]]; then
  printf '\nVCF_WHISPER_CPP_PATH=%s\nVCF_WHISPER_CPP_MODEL=%s\n' "$PREFIX/bin/whisper-cli" "$MODEL_PATH"
  if [[ -n "$VAD_MODEL_PATH" ]]; then
    printf 'VCF_WHISPER_CPP_VAD_MODEL=%s\n' "$VAD_MODEL_PATH"
  fi
fi
