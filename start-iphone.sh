#!/bin/sh
# Experimental: run inside iSH on the iPhone, not inside an SSH client connected to a PC.
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo 'iSH에서 먼저 실행하세요: apk add nodejs git qrencode'
  exit 1
fi
if [ -z "${ARENA_IP:-}" ]; then
  printf '아이폰 설정 > Wi-Fi > 연결된 Wi-Fi의 (i) > IP 주소: '
  IFS= read -r ARENA_IP
fi
if ! printf '%s\n' "$ARENA_IP" | awk -F. 'NF != 4 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || $i<0 || $i>255) exit 1}' ; then
  echo 'IPv4 주소를 다시 확인하세요. 예: 192.168.0.12'
  exit 1
fi
PORT=3000
export ARENA_IP PORT
# Small initial test; scale up only after actual iPhone measurements.
MON_CAP=${MON_CAP:-12}
MON_PER=${MON_PER:-1}
export MON_CAP MON_PER
ARENA_JOIN_URL="http://$ARENA_IP:$PORT"
printf '\n학생: %s\n협동: %s/2\n관리: %s/admin\n' "$ARENA_JOIN_URL" "$ARENA_JOIN_URL" "$ARENA_JOIN_URL"
if command -v qrencode >/dev/null 2>&1; then
  qrencode -t SVG -o public/iphone-qr.svg "$ARENA_JOIN_URL"
  printf 'QR 그림: %s/iphone-qr.svg\n' "$ARENA_JOIN_URL"
  qrencode -t ANSIUTF8 "$ARENA_JOIN_URL"
fi
echo '같은 Wi-Fi의 다른 기기에서 접속하세요. iSH는 화면에 계속 켜두세요.'
echo '실제 iPhone/iSH에서 동작·성능은 아직 검증하지 않은 실험용 실행 방법입니다.'
exec node --jitless server.js
