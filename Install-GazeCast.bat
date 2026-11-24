@echo off
title Install GazeCast
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo   Something went wrong. Please tell Claude what this window says.
)
echo.
pause
