#!/bin/bash
cd "$(dirname "$0")"
export PORT=${PORT:-3000}
if command -v node >/dev/null 2>&1; then
  node server.js
else
  echo ""
  echo "  Node.js를 찾을 수 없어요. https://nodejs.org 에서 LTS를 설치해 주세요."
  echo ""
  read -n 1 -s -r -p "  아무 키나 누르면 닫혀요"
fi
