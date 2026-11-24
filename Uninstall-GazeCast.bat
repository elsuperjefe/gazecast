@echo off
title Remove GazeCast shortcuts
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop');$p=[Environment]::GetFolderPath('Programs');@((Join-Path $d 'GazeCast.lnk'),(Join-Path $p 'GazeCast.lnk'),(Join-Path $p 'GazeCast (demo).lnk'))|ForEach-Object{if(Test-Path $_){Remove-Item $_ -Force}};Write-Host '';Write-Host '  GazeCast shortcuts removed. Your files and phone settings are untouched.'"
echo.
pause
