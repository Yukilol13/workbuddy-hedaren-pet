@echo off
REM hedaren-pet installer (Windows). Works with any node: WorkBuddy bundled, system, or Electron.
setlocal
cd /d "%~dp0"
if exist "%~dp0bin\hedaren-node.cmd" (
  call "%~dp0bin\hedaren-node.cmd" "%~dp0install.js" %*
) else (
  node --no-warnings install.js %*
)
if errorlevel 1 (
  echo.
  echo [ERROR] Install failed. Make sure WorkBuddy is installed, or Node 18+ is on PATH.
)
pause
