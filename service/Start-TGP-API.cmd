@echo off
REM Starts the headless TGP API via Electron-as-Node (ABI 145). Safe to run at login.
REM If already up, exits quietly. No Administrator rights required.
setlocal
cd /d "%~dp0.."
set "APP=%CD%"
set "ELECTRON=%APP%\node_modules\electron\dist\electron.exe"
set "SERVER=%APP%\server.cjs"
set "DATA=%APP%\..\.."
for %%I in ("%DATA%") do set "DATA=%%~fI"
REM Optional override: service\tgp-data-dir.txt
if exist "%~dp0tgp-data-dir.txt" (
  set /p DATA=<"%~dp0tgp-data-dir.txt"
)

if not exist "%ELECTRON%" (
  echo ERROR: missing Electron: "%ELECTRON%"
  echo Copy full node_modules from home prepare:store ^(include electron^).
  exit /b 1
)
if not exist "%SERVER%" (
  echo ERROR: missing "%SERVER%"
  exit /b 1
)

REM Already serving?
powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/api/ready -TimeoutSec 2; if($r.StatusCode -eq 200){ exit 0 } } catch { exit 1 }"
if %ERRORLEVEL%==0 exit /b 0

set "ELECTRON_RUN_AS_NODE=1"
set "TGP_SERVICE=1"
set "TGP_DATA_DIR=%DATA%"
start "TGP-API" /MIN "%ELECTRON%" "%SERVER%"
exit /b 0
