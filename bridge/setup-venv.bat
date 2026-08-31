@echo off
REM One-time setup: creates the local Python environment (.venv) in this folder
REM and installs the bridge's dependencies into it. Re-run only if .venv is
REM missing or you want to rebuild it. Needs internet (PyPI) the first time.

setlocal

REM Use the Python launcher if present, else whatever "python" is on PATH.
REM Requires Python 3.10+ (3.13 recommended).
set "PY=python"
py -3 --version >nul 2>nul && set "PY=py -3"

echo Creating local environment in "%~dp0.venv" ...
%PY% -m venv "%~dp0.venv"
if errorlevel 1 (
  echo Failed to create the virtual environment.
  pause
  exit /b 1
)

echo Installing dependencies (this can take a minute) ...
"%~dp0.venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r "%~dp0requirements.txt"
if errorlevel 1 (
  echo Dependency install failed.
  pause
  exit /b 1
)

REM The SDK ships a ~238 MB bundled copy of claude.exe we never use (the bridge
REM runs your installed Claude app's CLI). Delete it to keep the venv small.
del /q "%~dp0.venv\Lib\site-packages\claude_agent_sdk\_bundled\claude.exe" 2>nul

echo.
echo Setup complete. You can now run run-bridge.bat.
pause
