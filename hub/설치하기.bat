@echo off
chcp 65001 >nul
title 특수학급 비상호출 설치
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
