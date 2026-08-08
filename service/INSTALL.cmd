@echo off
REM Double-click this file, then click YES on the UAC / Administrator prompt.
REM Success message: === SERVICE OK ===
cd /d "%~dp0"
echo.
echo ============================================================
echo  TGP Command Center — install Windows service
echo  Folder: %CD%
echo.
echo  A UAC prompt will appear. You MUST click YES.
echo  Without Administrator rights the service will not install
echo  and phones/TV will stop after reboot or logout.
echo ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-TGP-Service.ps1"
set ERR=%ERRORLEVEL%
echo.
echo Exit code: %ERR%
echo Full log: %~dp0install.log
if exist "%~dp0install-result-flag.txt" (
  echo Result flag:
  type "%~dp0install-result-flag.txt"
)
if not "%ERR%"=="0" (
  echo.
  echo INSTALL DID NOT SUCCEED. Open install.log and service\logs\.
)
echo.
pause
