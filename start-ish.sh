#!/bin/sh
# 아이폰 iSH(Alpine)에서 아레나 서버 켜기:  sh start-ish.sh
#  1) 처음 한 번: apk add nodejs git  →  git clone https://github.com/gurrb20111111-crypto/oksland-arena
#  2) ish.env.example 을 ish.env 로 복사해서 비밀번호·열쇠를 적기 (ish.env는 GitHub에 안 올라감)
cd "$(dirname "$0")" || exit 1

if [ ! -f ish.env ]; then
  cp ish.env.example ish.env
  echo ""
  echo "  ish.env 를 새로 만들었어요. 비밀번호와 열쇠를 적은 뒤 다시 실행해 주세요:"
  echo "    vi ish.env"
  echo ""
  exit 1
fi
. ./ish.env

# 앱을 내려도 iOS가 iSH를 멈추지 않게 (iSH 위치 권한을 '항상'으로)
if [ -e /dev/location ] && ! pgrep -f "cat /dev/location" >/dev/null 2>&1; then
  cat /dev/location > /dev/null &
  echo "  위치 신호로 백그라운드 유지 켬"
fi

# 최신 버전 받기 (실패해도 지금 버전으로 켬)
if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  if git pull --ff-only -q 2>/dev/null; then echo "  최신 버전: $(git log -1 --format='%h %s' | cut -c1-60)"
  else echo "  업데이트를 못 받았어요 (인터넷 또는 이 기기에서 고친 파일 때문) → 지금 버전으로 켜요"; fi
fi

exec node server.js
