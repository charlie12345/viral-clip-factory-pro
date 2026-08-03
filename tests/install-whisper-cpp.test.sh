#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

SOURCE_DIR="$TEMP_ROOT/source"
PREFIX="$TEMP_ROOT/prefix"
ENV_FILE="$TEMP_ROOT/app.env"
FAKE_BIN="$TEMP_ROOT/bin"
mkdir -p "$SOURCE_DIR/models" "$FAKE_BIN"
git -C "$SOURCE_DIR" init -q
git -C "$SOURCE_DIR" remote add origin https://github.com/ggml-org/whisper.cpp.git

MODEL_CONTENT='verified large-v3 fixture'
VAD_CONTENT='verified silero fixture'
EXPECTED_SHA1="$(printf '%s' "$MODEL_CONTENT" | sha1sum | awk '{print $1}')"
printf '| large-v3 | fixture | `%s` |\n' "$EXPECTED_SHA1" >"$SOURCE_DIR/models/README.md"

cat >"$SOURCE_DIR/models/download-ggml-model.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\$2"
printf '%s' '$MODEL_CONTENT' >"\$2/ggml-\$1.bin"
EOF
chmod +x "$SOURCE_DIR/models/download-ggml-model.sh"

cat >"$SOURCE_DIR/models/download-vad-model.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\$2"
printf '%s' '$VAD_CONTENT' >"\$2/ggml-\$1.bin"
EOF
chmod +x "$SOURCE_DIR/models/download-vad-model.sh"

# The production installer pins the real upstream model hash. This fixture
# uses tiny deterministic content, so emulate that one upstream hash while
# delegating every unrelated checksum to the system implementation.
REAL_SHA256SUM="$(command -v sha256sum)"
cat >"$FAKE_BIN/sha256sum" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *ggml-silero-v6.2.0.bin ]]; then
  printf '%s  %s\n' '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987' "\$1"
else
  exec '$REAL_SHA256SUM' "\$@"
fi
EOF
chmod +x "$FAKE_BIN/sha256sum"

cat >"$FAKE_BIN/cmake" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "--build" ]]; then
  build_dir="$2"
  mkdir -p "$build_dir/bin"
  cat >"$build_dir/bin/whisper-cli" <<'CLI'
#!/usr/bin/env bash
printf 'whisper.cpp fixture\n'
CLI
  chmod +x "$build_dir/bin/whisper-cli"
  exit 0
fi
while (($#)); do
  if [[ "$1" == "-B" ]]; then
    mkdir -p "$2"
    exit 0
  fi
  shift
done
exit 1
EOF
chmod +x "$FAKE_BIN/cmake"

printf 'KEEP_ME=yes\nVCF_WHISPER_CPP_PATH=/old/cli\nVCF_WHISPER_CPP_MODEL=/old/model\nVCF_WHISPER_CPP_VAD_MODEL=/old/vad\n' >"$ENV_FILE"
chmod 640 "$ENV_FILE"

PATH="$FAKE_BIN:$PATH" "$ROOT/scripts/install-whisper-cpp.sh" \
  --backend cpu \
  --model large-v3 \
  --source-dir "$SOURCE_DIR" \
  --prefix "$PREFIX" \
  --env-file "$ENV_FILE"

test -x "$PREFIX/bin/whisper-cli"
test "$(cat "$PREFIX/share/whisper.cpp/models/ggml-large-v3.bin")" = "$MODEL_CONTENT"
test "$(cat "$PREFIX/share/whisper.cpp/models/ggml-silero-v6.2.0.bin")" = "$VAD_CONTENT"
test "$(grep -c '^VCF_WHISPER_CPP_PATH=' "$ENV_FILE")" -eq 1
test "$(grep -c '^VCF_WHISPER_CPP_MODEL=' "$ENV_FILE")" -eq 1
test "$(grep -c '^VCF_WHISPER_CPP_VAD_MODEL=' "$ENV_FILE")" -eq 1
grep -Fx 'KEEP_ME=yes' "$ENV_FILE" >/dev/null
grep -Fx "VCF_WHISPER_CPP_PATH=$PREFIX/bin/whisper-cli" "$ENV_FILE" >/dev/null
grep -Fx "VCF_WHISPER_CPP_MODEL=$PREFIX/share/whisper.cpp/models/ggml-large-v3.bin" "$ENV_FILE" >/dev/null
grep -Fx "VCF_WHISPER_CPP_VAD_MODEL=$PREFIX/share/whisper.cpp/models/ggml-silero-v6.2.0.bin" "$ENV_FILE" >/dev/null
test "$(stat -c '%a' "$ENV_FILE")" = 640

# A valid installation is idempotent and does not redownload the model.
PATH="$FAKE_BIN:$PATH" "$ROOT/scripts/install-whisper-cpp.sh" \
  --backend cpu --model large-v3 --source-dir "$SOURCE_DIR" --prefix "$PREFIX" >/dev/null

# A corrupt cached model is rejected unless replacement was explicitly requested.
printf 'corrupt' >"$PREFIX/share/whisper.cpp/models/ggml-large-v3.bin"
if PATH="$FAKE_BIN:$PATH" "$ROOT/scripts/install-whisper-cpp.sh" \
  --backend cpu --model large-v3 --source-dir "$SOURCE_DIR" --prefix "$PREFIX" >/dev/null 2>&1; then
  printf 'corrupt model unexpectedly passed verification\n' >&2
  exit 1
fi
PATH="$FAKE_BIN:$PATH" "$ROOT/scripts/install-whisper-cpp.sh" \
  --backend cpu --model large-v3 --source-dir "$SOURCE_DIR" --prefix "$PREFIX" --force >/dev/null
test "$(cat "$PREFIX/share/whisper.cpp/models/ggml-large-v3.bin")" = "$MODEL_CONTENT"

printf 'install-whisper-cpp tests passed\n'
