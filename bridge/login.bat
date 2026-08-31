@echo off
REM (Re)login to your Claude subscription. Run this when the bridge says
REM authentication expired. A browser window will open — pick your Claude account.

setlocal EnableDelayedExpansion

REM The Claude app is a packaged (MSIX) app: its files live under the package
REM LocalCache, not the normal AppData\Roaming path. Check both.
set "B1=%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code"
set "B2=%APPDATA%\Claude\claude-code"

set "CLAUDE="
for %%B in ("%B1%" "%B2%") do (
  if exist "%%~B" (
    for /f "delims=" %%D in ('dir /b /ad /o-n "%%~B" 2^>nul') do (
      if not defined CLAUDE if exist "%%~B\%%D\claude.exe" set "CLAUDE=%%~B\%%D\claude.exe"
    )
  )
)

if not defined CLAUDE (
  echo Could not find claude.exe in either:
  echo   %B1%
  echo   %B2%
  pause
  exit /b 1
)

echo Using: %CLAUDE%
echo Signing in to your Claude subscription...
"%CLAUDE%" auth login

echo.
echo Done. You can close this window and start run-bridge.bat.
pause
