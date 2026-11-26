#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Tailscale.app/Contents/MacOS:$PATH"

if ! command -v bun >/dev/null 2>&1; then
  if [ -t 0 ]; then
    read -r -p "Bun 런타임이 설치되어 있지 않습니다. 지금 자동으로 설치할까요? [Y/n]: " INSTALL_BUN
    if [ -z "${INSTALL_BUN}" ] || [[ "${INSTALL_BUN}" =~ ^[Yy]$ ]]; then
      if command -v curl >/dev/null 2>&1 && curl -fsSL https://bun.sh/install | bash; then
        export PATH="$HOME/.bun/bin:$PATH"
      fi
    fi
  fi
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "오류: Bun 런타임이 필요합니다."
  echo "설치 명령: curl -fsSL https://bun.sh/install | bash"
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[1/2] 의존성 설치 중 (bun install)..."
  if [ -f "bun.lock" ]; then
    bun install --frozen-lockfile
  else
    bun install
  fi
fi

exec bun run src/cli.ts up "$@"
