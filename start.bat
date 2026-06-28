@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run Pokemon Scenario Lab.
  echo Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)

set "PYTHON_FOUND="
where py >nul 2>nul && set "PYTHON_FOUND=1"
where python >nul 2>nul && set "PYTHON_FOUND=1"
where python3 >nul 2>nul && set "PYTHON_FOUND=1"
if not defined PYTHON_FOUND (
  echo.
  echo Note: Python 3.12 or newer is required only for automated dataset refresh.
  echo Install 64-bit Python from https://www.python.org/downloads/windows/
  echo The rest of the app can still run without it.
  echo.
)

node "%~dp0server.mjs"
if errorlevel 1 pause
