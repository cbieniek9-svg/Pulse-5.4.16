@echo off
REM Install TGP Command Center as a Windows service (starts at boot, before login).
REM Prefer INSTALL.cmd / Install-TGP-Service.ps1 (self-elevating, writes install.log).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-TGP-Service.ps1"
exit /b %ERRORLEVEL%
