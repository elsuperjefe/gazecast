@echo off
rem GazeCast - double-click to start. Add "demo" to try it without a phone:  start.bat demo
setlocal
cd /d "%~dp0"
title GazeCast

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=%~dp0tools\node\node.exe"

set "NEEDSETUP="
if not exist "tools\scrcpy\scrcpy-server" set "NEEDSETUP=1"
if not exist "tools\platform-tools\adb.exe" set "NEEDSETUP=1"
if "%NODE%"=="%~dp0tools\node\node.exe" if not exist "%NODE%" set "NEEDSETUP=1"
if defined NEEDSETUP (
  echo First start: fetching scrcpy, adb and Node.js. This needs the internet once.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
  if errorlevel 1 (
    echo.
    echo Setup did not finish. Check the internet connection and try again.
    pause
    exit /b 1
  )
)

set "MODE="
if /i "%~1"=="demo" set "MODE=--demo"

"%NODE%" "%~dp0bridge\server.js" --open %MODE% %2 %3
if errorlevel 1 pause
endlocal
