@echo off
REM Right-click this file -> Run as administrator
REM Always runs the installer from THIS folder (do not copy to Desktop).
cd /d "%~dp0"
echo Installing TGP Windows service from:
echo   %CD%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-TGP-Service.ps1" -NoElevate -NoPause
set ERR=%ERRORLEVEL%
echo.
echo Exit code: %ERR%
if exist "%~dp0install.log" (
  echo ---- install.log tail ----
  powershell -NoProfile -Command "Get-Content '%~dp0install.log' -Tail 30"
)
if exist "%~dp0install-result-flag.txt" type "%~dp0install-result-flag.txt"
echo.
if not "%ERR%"=="0" echo FAILED - service was not installed.
if "%ERR%"=="0" echo SUCCESS - check services.msc for TGP Command Center.
pause
exit /b %ERR%
