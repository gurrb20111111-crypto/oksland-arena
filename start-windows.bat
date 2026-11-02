@echo off
chcp 65001 > nul
title 옥정섬 SOS 클리어 아레나 서버
cd /d "%~dp0"
rem 수업용 서버 켜기: 이 파일 더블클릭
rem 몇 명까지 버티는지 재기: bench-windows.bat 더블클릭 (수업용 서버는 먼저 닫기)

rem ── 설정 파일 (비밀번호·Render 열쇠) ──
if not exist "%~dp0settings.bat" (
  copy /y "%~dp0settings.example.bat" "%~dp0settings.bat" > nul
  if not "%1"=="bench" (
    echo.
    echo  settings.bat 을 새로 만들었어요. 메모장에서 비밀번호와 Render 열쇠를 적고 저장한 뒤
    echo  이 파일을 다시 더블클릭해 주세요.
    echo.
    start notepad "%~dp0settings.bat"
    pause
    exit /b
  )
)
call "%~dp0settings.bat"
if "%PORT%"=="" set PORT=3000

rem ── 최신 버전 받기 (Git이 있을 때만, 실패해도 지금 버전으로 켬) ──
where git > nul 2> nul
if not errorlevel 1 if exist "%~dp0.git" (
  git pull --ff-only -q > nul 2> nul
  if errorlevel 1 (echo  업데이트를 못 받았어요 - 지금 버전으로 켜요) else (echo  최신 버전으로 맞췄어요)
)

rem ── Node 찾기 ──
set NODE=node
if exist "%~dp0node.exe" set NODE="%~dp0node.exe"
%NODE% -v > nul 2> nul
if errorlevel 1 (
  echo.
  echo  Node.js를 찾을 수 없어요.
  echo  https://nodejs.org 에서 LTS를 설치하거나, node.exe 를 이 폴더에 넣어 주세요.
  echo.
  pause
  exit /b
)

if "%1"=="bench" (%NODE% bench.js) else (%NODE% server.js)
pause
