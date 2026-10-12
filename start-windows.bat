@echo off
chcp 65001 > nul
title 옥정섬 SOS 클리어 아레나 서버
cd /d "%~dp0"
set PORT=3000
rem 관리자 비밀번호를 고정하려면 아래 줄 앞의 rem 을 지우고 비밀번호를 적으세요.
rem set ADMIN_KEY=mypassword
if exist "%~dp0node.exe" (
  "%~dp0node.exe" server.js
) else (
  where node > nul 2> nul
  if errorlevel 1 (
    echo.
    echo  Node.js를 찾을 수 없어요.
    echo  https://nodejs.org 에서 LTS를 설치하거나, node.exe 를 이 폴더에 넣어 주세요.
    echo.
  ) else (
    node server.js
  )
)
pause
