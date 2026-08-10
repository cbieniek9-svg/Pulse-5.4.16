@echo off
REM Stop and uninstall the TGP Command Center Windows service.
REM Right-click -> Run as administrator.
setlocal EnableExtensions
cd /d "%~dp0"
set "WRAPPER=%CD%\TGP-CommandCenter.exe"

net session >nul 2>&1
if errorlevel 1 (
  echo ERROR: Run this script as Administrator.
  exit /b 1
)

if not exist "%WRAPPER%" (
  echo ERROR: Missing %WRAPPER%
  exit /b 1
)

echo Stopping and uninstalling TGP-CommandCenter ...
"%WRAPPER%" stop
"%WRAPPER%" uninstall
set "UNINSTALL_EXIT=%ERRORLEVEL%"
if not "%UNINSTALL_EXIT%"=="0" (
  echo ERROR: WinSW uninstall failed with exit code %UNINSTALL_EXIT%.
  exit /b %UNINSTALL_EXIT%
)
echo Done.
exit /b 0
