#!/bin/sh
# 아이폰 iSH(Alpine)에서 아레나 서버 켜기:  sh start-ish.sh
# 이 아이폰이 몇 명까지 버티는지 재기:      sh start-ish.sh bench   (수업용 서버는 먼저 끄기)
#  1) 처음 한 번: apk add nodejs git  →  git clone https://github.com/gurrb20111111-crypto/oksland-arena
#  2) ish.env.example 을 ish.env 로 복사해서 비밀번호·열쇠를 적기 (ish.env는 GitHub에 안 올라감)
cd "$(dirname "$0")" || exit 1

# 처음 한 번: 질문에 답하면 ish.env를 만들어 줌 (iSH의 vi는 한글이 깨져 보여서 편집기 대신 질문으로)
if [ "$1" != "bench" ] && [ ! -f ish.env ]; then
  echo ""
  echo "  처음 설정이에요. 영어 자판으로 입력하고 Enter. (입력 글자는 화면에 안 보여요)"
  echo ""
  printf "  1) 이 아이폰 서버의 관리자 비밀번호: "; stty -echo 2>/dev/null; read -r AK; stty echo 2>/dev/null; echo ""
  printf "  2) Render의 ADMIN_KEY 값 (12자 이상, 넘기기를 안 쓰면 그냥 Enter): "; stty -echo 2>/dev/null; read -r HK; stty echo 2>/dev/null; echo ""
  printf "  3) 클리어 코드 없이 이름만으로 입장할까요? (y/n): "; read -r GT
  {
    echo "# 아이폰 교실 서버 설정 (다시 만들려면: rm ish.env 후 sh start-ish.sh)"
    echo "export PORT=3000"
    echo "export ADMIN_KEY='$AK'"
    [ -n "$HK" ] && echo "export HUB_KEY='$HK'"
    case "$GT" in y|Y|yes|ㅛ) echo "export GATE=0";; esac
  } > ish.env
  chmod 600 ish.env
  echo ""
  echo "  ish.env를 만들었어요. 서버를 켜요."
  echo ""
fi
[ -f ish.env ] && . ./ish.env

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

if [ "$1" = "bench" ]; then exec node bench.js; fi
exec node server.js
