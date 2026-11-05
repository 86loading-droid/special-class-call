@echo off
chcp 65001 >nul
title 특수학급 비상호출 중계 서버
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 LTS 버전을 한 번 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
node server.js
pause
