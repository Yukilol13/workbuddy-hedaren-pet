@echo off
chcp 65001 >nul
REM 和大人桌宠 · 一键启动（Windows 双击即可）
cd /d "%~dp0"

 REM 优先用 WorkBuddy 内置 node，其次系统 node
 set "NODE_EXE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
 if not exist "%NODE_EXE%" set "NODE_EXE=node"

 "%NODE_EXE%" --no-warnings start.js
 if errorlevel 1 (
   echo.
   echo [错误] 启动失败。请确认已安装 Node.js 18+ 或首次运行 install.js 下载 Electron。
   pause
 )
