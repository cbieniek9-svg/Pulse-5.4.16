@echo off
REM Rebuild better-sqlite3 for Electron ABI 145 (REQUIRED for Windows service + .exe).
REM The service runs Electron as Node (ELECTRON_RUN_AS_NODE) — always ABI 145.
cd /d "%~dp0.."
echo.
echo === TGP fix-native-modules (Electron ABI 145) ===
echo Directory: %CD%
echo.
where node >nul 2>&1 || (
  echo ERROR: Node.js not found. Install Node 20+ on this PC first.
  exit /b 1
)
echo Node (build tooling only):
node -v
echo.
echo Rebuilding better-sqlite3 for Electron 41.3.0 (ABI 145)...
call npm run rebuild:electron
if errorlevel 1 exit /b 1
echo.
echo Verifying native module loads under Electron-as-Node...
REM CRITICAL: without ELECTRON_RUN_AS_NODE, Electron treats -e args as an app path
REM and can show: Unable to find Electron app at ...\console.log(process.version)
set ELECTRON_RUN_AS_NODE=1
set "ELECTRON_EXE=%CD%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo ERROR: missing %ELECTRON_EXE% — run npm install first.
  exit /b 1
)
"%ELECTRON_EXE%" -e "require('better-sqlite3'); console.log('Electron: better-sqlite3 OK ABI', process.versions.modules);"
if errorlevel 1 (
  echo.
  echo Rebuild finished but Electron still cannot load the module.
  exit /b 1
)
echo.
echo === OK — restart Windows service: resources\app\service\_restart-service.ps1 ===
echo Do NOT run rebuild:node / fix-native-modules-node.cmd on a live store — that switches to ABI 137 and breaks the service.
echo.
