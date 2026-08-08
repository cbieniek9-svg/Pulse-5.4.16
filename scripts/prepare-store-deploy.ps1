# Build a store-ready resources/app folder at home (Node required here only).
# The store PC only needs the copied folder + TGP Command Center V3.exe — no npm on site.
#
# Usage (from resources/app):
#   powershell -ExecutionPolicy Bypass -File scripts/prepare-store-deploy.ps1
#
# Optional: copy output list to USB, then on store PC replace resources/app/ (keep tgp_ops.db + backups).

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host ""
Write-Host "=== TGP Store Deploy Prep ===" -ForegroundColor Cyan
Write-Host "Working directory: $(Get-Location)"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js not found. Install Node 20+ on this home PC first."
}

$nodeVer = node -v
Write-Host "Node: $nodeVer"

Write-Host ""
Write-Host "[1/3] npm install (rebuilds better-sqlite3 for Electron ABI 145 via postinstall)..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "[2/3] rebuild:electron (confirm ABI 145 for Windows service + .exe)..." -ForegroundColor Yellow
npm run rebuild:electron
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "[3/4] verify-store-deploy (Electron ABI 145, version, unit tests)..." -ForegroundColor Yellow
node scripts/verify-store-deploy.cjs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "[4/4] Deploy manifest..." -ForegroundColor Yellow
$ver = node -e "console.log(require('./src/app-version.cjs').APP_VERSION)"
$manifest = @"
TGP Store Deploy Package
Version: $ver
Built: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
Node: $nodeVer

--- Recent highlights (see PATCH_NOTES.txt) ---
Settings Editor (/settings) | Today's Briefing hub panel | TV pairing in settings

Patch notes: PATCH_NOTES.txt | CHANGELOG.md
"@
$manifest | Out-File -FilePath "STORE_DEPLOY.txt" -Encoding utf8
Write-Host "  Wrote STORE_DEPLOY.txt"

Write-Host ""
Write-Host "=== READY TO COPY ===" -ForegroundColor Green
Write-Host ""
Write-Host "Copy this entire folder to the store PC:"
Write-Host "  $(Get-Location)"
Write-Host ""
Write-Host "Include node_modules (required - store has no Node)."
Write-Host ""
Write-Host "On the store PC:"
Write-Host "  1. Stop TGP Command Center .exe (and service if updating)"
Write-Host "  2. Replace resources\app\ with this folder (include node_modules\electron)"
Write-Host "  3. DO NOT overwrite tgp_ops.db or backups\"
Write-Host "  4. Start / reinstall Windows service (service\INSTALL.cmd) — required"
Write-Host "  5. Optional: open .exe for UI-only while service owns :3001"
Write-Host "  6. Run scripts\verify-store-site.cmd to confirm the copy"
Write-Host ""
Write-Host "Always ABI 145 (rebuild:electron). Service runs Electron-as-Node. Do not rebuild:node on store."
Write-Host "Optional: omit tests\ and test-results\ to save space (not needed in production)."
Write-Host ""
