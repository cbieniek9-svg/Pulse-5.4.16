@echo off
REM Rebuild better-sqlite3 for system Node (unit tests / npm run test:ci ONLY).
REM WARNING: This switches away from ABI 145 and WILL break the Windows service.
REM After tests, restore with: scripts\fix-native-modules.cmd  (or npm run rebuild:electron)
cd /d "%~dp0.."
echo.
echo === TGP fix-native-modules (Node — TEST ONLY) ===
echo WARNING: Store / service requires Electron ABI 145.
echo This script is only for local Node unit tests. Restore 145 before starting the service.
echo Directory: %CD%
echo.
where node >nul 2>&1 || (
  echo ERROR: Node.js not found. Install Node 20+ on this PC first.
  exit /b 1
)
echo Node:
node -v
node -e "console.log('NODE_MODULE_VERSION', process.versions.modules)"
echo.
echo Rebuilding better-sqlite3 for this Node...
call npm run rebuild:node
if errorlevel 1 exit /b 1
echo.
echo Verifying native module loads under Node...
call node -e "require('better-sqlite3'); console.log('Node: better-sqlite3 OK');"
if errorlevel 1 (
  echo.
  echo Rebuild finished but Node still cannot load the module.
  exit /b 1
)
echo.
echo === OK for Node tests only. Restore service: npm run rebuild:electron then restart TGP-CommandCenter ===
echo.
