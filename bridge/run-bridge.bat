@echo off
REM Starts the Claude-in-Tab bridge (runs on your Claude subscription).
REM Double-click this file, then use the extension. Close the window to stop.
REM Uses the local virtual environment in .venv (all Python deps live here).

setlocal

set "PY=%~dp0.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo Local environment not found. Run setup-venv.bat once first.
  pause
  exit /b 1
)

echo Starting Claude-in-Tab bridge...
"%PY%" "%~dp0server.py"

echo.
echo Bridge stopped.
pause
