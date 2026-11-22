@echo off
REM hedaren-pet launcher (Windows). Node is resolved at run time by bin\hedaren-node.cmd.
cd /d "%~dp0"

if exist "%~dp0bin\hedaren-node.cmd" (
  call "%~dp0bin\hedaren-node.cmd" "%~dp0start.js"
) else (
  node --no-warnings start.js
)

if errorlevel 1 (
  echo.
  echo [ERROR] Failed to start. Run install.bat first to fetch the Electron runtime.
  pause
)
