#!/usr/bin/env bash
# Convenience script for local testing: install deps, then launch opencode in dev mode.
# Dev mode runs the TS entrypoint directly via bun -- no compiled build is needed for this.
# Pass --full-build to instead run the real cross-platform release build (script/build.ts)
# and execute the compiled binary for this machine's platform/arch.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is not installed (see https://bun.sh)" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "==> Installing dependencies (bun install)"
  bun install
fi

if [ "${1:-}" = "--full-build" ]; then
  echo "==> Building release binaries (bun run build)"
  bun run --cwd packages/opencode build

  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  [ "$os" = "darwin" ] || [ "$os" = "linux" ] || { echo "error: unsupported OS for --full-build: $os" >&2; exit 1; }
  arch=$(uname -m)
  case "$arch" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "error: unsupported arch for --full-build: $arch" >&2; exit 1 ;;
  esac

  binary=$(find packages/opencode/dist -type f -path "*${os}-${arch}*" -name opencode | head -1)
  if [ -z "$binary" ]; then
    echo "error: could not find built binary for ${os}-${arch} under packages/opencode/dist" >&2
    exit 1
  fi

  echo "==> Running built binary: $binary"
  exec "$binary"
fi

echo "==> Starting dev (bun run dev)"
exec bun run dev
