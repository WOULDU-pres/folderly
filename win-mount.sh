#!/usr/bin/env bash

set -euo pipefail

# Copy built Windows artifacts to mounted Windows directory.
# Usage:
#   ./win-mount.sh [MOUNT_PATH] [TARGET]
#   ./win-mount.sh --skip-build --skip-installer

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOUNT_PATH="/mnt/c/workspace/WindowsPdfExplorer"
TARGET="x86_64-pc-windows-gnu"
SKIP_BUILD=0
SKIP_INSTALLER=0

copy_with_retry() {
  local src="$1"
  local dst="$2"

  local retries=3
  for ((i = 1; i <= retries; i += 1)); do
    if cp -f "$src" "$dst"; then
      return 0
    fi
    if [[ $i -lt $retries ]]; then
      echo "Copy failed, retrying ${i}/${retries}: $src -> $dst"
      sleep 0.6
    fi
  done

  return 1
}

POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-installer)
      SKIP_INSTALLER=1
      shift
      ;;
    --help|-h)
      cat <<'USAGE'
Usage:
  ./win-mount.sh [MOUNT_PATH] [TARGET] [--skip-build] [--skip-installer]

Arguments:
  MOUNT_PATH  Windows mount path to copy artifacts (default: /mnt/c/workspace/WindowsPdfExplorer)
  TARGET      Tauri target (default: x86_64-pc-windows-gnu)

Options:
  --skip-build      Skip `npm run tauri build`
  --skip-installer  Skip installer rebuild/copy
USAGE
      exit 0
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

if [[ ${#POSITIONAL[@]} -ge 1 ]]; then
  MOUNT_PATH="${POSITIONAL[0]}"
fi
if [[ ${#POSITIONAL[@]} -ge 2 ]]; then
  TARGET="${POSITIONAL[1]}"
fi
if [[ ${#POSITIONAL[@]} -gt 2 ]]; then
  echo "Unknown positional arguments: ${POSITIONAL[*]:2}" >&2
  exit 1
fi

if [[ "${SKIP_BUILD}" != "1" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "npm not found" >&2
    exit 1
  fi
  echo "[1/3] Build for target: ${TARGET}"
  (cd "$ROOT_DIR" && npm run tauri build -- --target "$TARGET")
fi

TARGET_EXE_DIR="$ROOT_DIR/src-tauri/target/$TARGET/release"
WINDOWS_EXE_SRC=""
if [[ -f "$TARGET_EXE_DIR/tauri-app.exe" ]]; then
  WINDOWS_EXE_SRC="$TARGET_EXE_DIR/tauri-app.exe"
elif [[ -f "$TARGET_EXE_DIR/tauri-app" ]]; then
  WINDOWS_EXE_SRC="$TARGET_EXE_DIR/tauri-app"
else
  echo "Cannot find built Windows executable in $TARGET_EXE_DIR" >&2
  exit 1
fi

WINDOWS_DLL_SRC="$TARGET_EXE_DIR/WebView2Loader.dll"
if [[ ! -f "$WINDOWS_DLL_SRC" ]]; then
  echo "Cannot find WebView2Loader.dll in $TARGET_EXE_DIR" >&2
  exit 1
fi

mkdir -p "$MOUNT_PATH"

WINDOWS_EXE_DST="$MOUNT_PATH/WindowsPdfExplorer.exe"
WINDOWS_DLL_DST="$MOUNT_PATH/WebView2Loader.dll"
WINDOWS_INSTALLER_DST="$MOUNT_PATH/WindowsPdfExplorer-Installer.exe"

if ! copy_with_retry "$WINDOWS_EXE_SRC" "$WINDOWS_EXE_DST"; then
  echo "Failed to copy executable to $WINDOWS_EXE_DST. Close running app if needed and retry." >&2
  exit 1
fi
if ! copy_with_retry "$WINDOWS_DLL_SRC" "$WINDOWS_DLL_DST"; then
  echo "Failed to copy WebView2Loader.dll to $WINDOWS_DLL_DST. Close related process if needed and retry." >&2
  exit 1
fi
echo "[2/3] Copied app+DLL to $MOUNT_PATH"

if [[ "$SKIP_INSTALLER" == "1" ]]; then
  echo "[3/3] Skipped installer rebuild"
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. skip installer pack." >&2
  exit 0
fi

TMP_STUB="$(mktemp)"
trap 'rm -f "$TMP_STUB"' EXIT

if command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1; then
  GCC_COMPILER="x86_64-w64-mingw32-gcc"
elif command -v x86_64-pc-windows-gnu-gcc >/dev/null 2>&1; then
  GCC_COMPILER="x86_64-pc-windows-gnu-gcc"
else
  GCC_COMPILER=""
fi

if [[ -z "$GCC_COMPILER" ]]; then
  echo "No mingw compiler found. Installer build skipped."
  echo "  You can run with: $0 --skip-installer"
  exit 0
fi

echo "[3/3] Build installer stub and pack payload"
"$GCC_COMPILER" -O2 -mwindows -o "$TMP_STUB" \
  "$ROOT_DIR/tools/installer/installer_stub.c" \
  -lshell32 -lole32 -luuid -luser32

python3 - "$TMP_STUB" "$WINDOWS_EXE_DST" "$WINDOWS_DLL_DST" "$WINDOWS_INSTALLER_DST" <<'PY'
import pathlib
import sys

stub_path, exe_path, dll_path, out_path = map(pathlib.Path, sys.argv[1:])
magic = b'WPDIINS1'

exe = exe_path.read_bytes()
dll = dll_path.read_bytes()
stub = stub_path.read_bytes()

out_path.write_bytes(
  stub + exe + dll + magic + len(exe).to_bytes(8, 'little') + len(dll).to_bytes(8, 'little')
)
PY

echo "Done."
echo "  App:  $WINDOWS_EXE_DST"
echo "  DLL:  $WINDOWS_DLL_DST"
echo "  Installer: $WINDOWS_INSTALLER_DST"
