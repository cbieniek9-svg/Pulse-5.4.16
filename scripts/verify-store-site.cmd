@echo off

cd /d "%~dp0.."

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-store-site.ps1"

pause

