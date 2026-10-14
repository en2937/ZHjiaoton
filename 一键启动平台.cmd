@echo off
chcp 65001 >nul
title Campus Traffic Platform
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0platform-launcher\start.ps1" %*
set "PLATFORM_EXIT=%ERRORLEVEL%"
echo.
pause
exit /b %PLATFORM_EXIT%
