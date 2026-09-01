@echo off
REM ===========================================================================
REM  PayFlux - one-click start for Windows
REM
REM  Just double-click this file.
REM
REM  It brings up the whole stack in Docker:
REM    - Storefront  (a demo shop where you can actually buy something)
REM    - Console     (the admin dashboard)
REM    - API         (+ Swagger docs)
REM    - Worker, MongoDB, Redis
REM
REM  ...and handles the things people otherwise get stuck on: generating the
REM  JWT secrets, finding free ports, and seeding demo data once the API is
REM  genuinely ready.
REM
REM  Requires Docker Desktop:  https://www.docker.com/products/docker-desktop
REM
REM  (Named RUN-PAYFLUX rather than start.bat on purpose: cmd.exe has a builtin
REM   START command, and a file called start.bat is shadowed by it when typed
REM   without a path.)
REM ===========================================================================

setlocal
title PayFlux

REM Always run from this script's own folder, so double-clicking works no
REM matter what the current directory happens to be.
cd /d "%~dp0"

if not exist "scripts\launch.ps1" (
  echo.
  echo  ERROR: scripts\launch.ps1 is missing.
  echo         Run this from inside the cloned repository folder.
  echo.
  pause
  exit /b 1
)

REM -ExecutionPolicy Bypass applies to this process only. It does not change
REM any machine setting, and it means the script runs on a default Windows
REM install where downloaded .ps1 files are otherwise blocked.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\launch.ps1" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo.
  echo  PayFlux exited with code %RC%.
  echo.
  pause
)

exit /b %RC%
