@echo off
REM Download portable Node (win-x64) + WinSW into resources\app for the Windows service.
REM Run from anywhere; does not require admin.
setlocal EnableExtensions
cd /d "%~dp0.."
set "APP_ROOT=%CD%"
set "RUNTIME=%APP_ROOT%\runtime\node"
set "SERVICE=%APP_ROOT%\service"
set "NODE_VER=24.15.0"
set "WINSW_VER=2.12.0"

echo.
echo === TGP fetch-service-runtime ===
echo App: %APP_ROOT%
echo.

where powershell >nul 2>&1 || (
  echo ERROR: PowerShell required to download runtime.
  exit /b 1
)

if not exist "%RUNTIME%\node.exe" (
  echo Downloading Node %NODE_VER% win-x64 ...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-service-runtime.ps1" -NodeVersion "%NODE_VER%" -WinSWVersion "%WINSW_VER%"
  if errorlevel 1 exit /b 1
) else (
  echo OK  portable Node already present: "%RUNTIME%\node.exe"
  "%RUNTIME%\node.exe" -v
)

if not exist "%SERVICE%\TGP-CommandCenter.exe" (
  echo WinSW wrapper missing — re-run fetch script.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fetch-service-runtime.ps1" -NodeVersion "%NODE_VER%" -WinSWVersion "%WINSW_VER%"
  if errorlevel 1 exit /b 1
) else (
  echo OK  WinSW wrapper: "%SERVICE%\TGP-CommandCenter.exe"
)

echo.
echo === fetch-service-runtime OK ===
echo Next: elevated service\tgp-service-install.cmd
echo.
exit /b 0
