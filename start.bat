@echo off
REM hedaren-pet launcher (Windows). This window closes at once; nothing stays open.
REM Electron is started directly, so no node.exe / cmd.exe holds the pet alive.
setlocal
cd /d "%~dp0"

set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="

if exist "%~dp0vendor\electron\electron.exe" (
  start "" "%~dp0vendor\electron\electron.exe" --pet-edition=workbuddy "%~dp0app"
  exit /b 0
)

REM Runtime not installed yet: bootstrap through start.js (it downloads Electron).
if exist "%~dp0bin\hedaren-node.cmd" (
  call "%~dp0bin\hedaren-node.cmd" "%~dp0start.js" --detached
) else (
  node --no-warnings "%~dp0start.js" --detached
)
exit /b 0
