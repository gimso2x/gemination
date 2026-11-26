#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

set +e
./start.sh "$@"
EXIT_CODE=$?
set -e

if [ "${EXIT_CODE}" -ne 0 ] && [ -t 0 ]; then
  echo ""
  read -r -p "오류가 발생해 종료되었습니다 (코드 ${EXIT_CODE}). 창을 닫으려면 Enter를 누르세요..." _
fi

exit "${EXIT_CODE}"
