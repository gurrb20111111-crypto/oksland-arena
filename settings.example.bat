@echo off
rem ===== 아레나 서버 설정 (이 파일은 GitHub에 올라가지 않아요) =====

rem 이 노트북 서버의 관리자(TV)·운영자 비밀번호. 학생이 추측하기 어려운 값으로.
set ADMIN_KEY=여기에_노트북_관리자_비밀번호

rem Render 안내소 열쇠 = Render → oksland-arena → Environment 의 ADMIN_KEY 값과 똑같이 (12자 이상).
rem 적어 두면 학생이 늘 쓰던 Render 주소(QR·게임 버튼)로 들어와도 이 노트북으로 자동 연결돼요.
rem 넘기기를 안 쓰려면 앞에 rem 을 붙이세요.
set HUB_KEY=여기에_Render_ADMIN_KEY_값

rem 와이파이 IP를 잘못 잡을 때만 (명령 프롬프트에서 ipconfig → 무선 LAN의 IPv4 주소)
rem set LAN_IP=10.20.30.45

rem 켜자마자 학생을 넘기지 않으려면 (나중에 교실주소/hub 에서 켜기)
rem set ROUTE=0

rem 클리어 코드 없이 이름만으로 아레나 입장
rem set GATE=0
