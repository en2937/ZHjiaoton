@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "TRAFFIC_TEST_NODE="
where node.exe >nul 2>nul
if not errorlevel 1 set "TRAFFIC_TEST_NODE=node.exe"
if not defined TRAFFIC_TEST_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "TRAFFIC_TEST_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined TRAFFIC_TEST_NODE (
  echo 未找到 Node.js。请安装 Node.js 22 或更新版本，或通过 Codex 运行独立测试版。
  pause
  exit /b 1
)
"%TRAFFIC_TEST_NODE%" "ai-provider\start-test.mjs"
if errorlevel 1 pause
