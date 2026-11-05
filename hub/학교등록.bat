@echo off
chcp 65001 >nul
title 학교 등록 (처음 한 번만)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다. 설치 파일을 먼저 실행해 주세요.
  pause
  exit /b 1
)
echo 학교 등록을 시작합니다. 안내에 따라 입력하고 Enter를 누르세요.
echo.
set /p SCHOOL_NAME=학교 이름을 입력하고 Enter: 
set /p SCHOOL_CODE=학교 코드 영문 대문자와 숫자 6~12자 입력하고 Enter: 
echo.
node server.js add-school "%SCHOOL_NAME%" "%SCHOOL_CODE%"
echo.
echo 끝났습니다. 이 창을 닫고 "시작하기.bat"을 더블클릭하세요.
pause
