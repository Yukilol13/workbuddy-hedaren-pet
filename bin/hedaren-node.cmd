@echo off
rem ===================================================================
rem  hedaren-pet node runtime wrapper (Windows)
rem  Resolves node at run time; never hard-codes a version path.
rem  Order: HEDAREN_NODE_EXE -> WorkBuddy versions/current ->
rem         newest under versions/ -> node on PATH ->
rem         bundled Electron (as node).
rem  Usage: hedaren-node.cmd <script> [args...]
rem ===================================================================
setlocal enabledelayedexpansion
set "N="
set "WBROOT=%USERPROFILE%\.workbuddy\binaries\node\versions"

if defined HEDAREN_NODE_EXE if exist "%HEDAREN_NODE_EXE%" set "N=%HEDAREN_NODE_EXE%"

if not defined N if exist "%WBROOT%\current" (
  set "VER="
  for /f "usebackq delims=" %%V in ("%WBROOT%\current") do if not defined VER set "VER=%%V"
  if defined VER if exist "%WBROOT%\!VER!\node.exe" set "N=%WBROOT%\!VER!\node.exe"
)

if not defined N for /d %%D in ("%WBROOT%\*") do if exist "%%D\node.exe" set "N=%%D\node.exe"

if not defined N for /f "delims=" %%P in ('where node.exe 2^>nul') do if not defined N set "N=%%P"

if defined N (
  "%N%" %*
  exit /b %ERRORLEVEL%
)

if exist "%~dp0..\vendor\electron\electron.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%~dp0..\vendor\electron\electron.exe" %*
  exit /b %ERRORLEVEL%
)

echo [hedaren] No node runtime found. Install WorkBuddy first, then run install.js again. 1>&2
exit /b 127
