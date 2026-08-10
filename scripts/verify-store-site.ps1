# Post-copy sanity check on the store PC (no Node required).
# Usage: powershell -File scripts/verify-store-site.ps1
# Run from resources/app after copying from home.

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host ""
Write-Host "=== TGP Store Site Verify ===" -ForegroundColor Cyan
Write-Host "Directory: $(Get-Location)"
Write-Host ""

$fail = 0
function Test-PathOk($rel, $label) {
    $p = Join-Path (Get-Location) $rel
    if (Test-Path $p) {
        Write-Host "  OK  $label" -ForegroundColor Green
    } else {
        Write-Host "  FAIL  $label missing ($rel)" -ForegroundColor Red
        $script:fail++
    }
}

Test-PathOk 'main.cjs' 'Electron main'
Test-PathOk 'src\db.cjs' 'Database layer'
Test-PathOk 'src\app-version.cjs' 'App version'
Test-PathOk 'node_modules\electron\dist\electron.exe' 'Electron runtime'
Test-PathOk 'service\TGP-CommandCenter.exe' 'WinSW service wrapper'
Test-PathOk 'service\TGP-CommandCenter.xml' 'WinSW service config'
Test-PathOk 'dist\ui\index.html' 'React UI build output'
Test-PathOk 'public\js\mobile\core.js' 'Mobile core module'
Test-PathOk 'public\js\mobile\lifecycle.js' 'Mobile lifecycle'
Test-PathOk 'reports.html' 'Reports portal'
Test-PathOk 'mgr-settings.html' 'Settings Editor'
Test-PathOk 'public\js\mgr-settings.js' 'Settings Editor script'
Test-PathOk 'public\css\mgr-settings.css' 'Settings Editor styles'
Test-PathOk 'CHANGELOG.md' 'Changelog'
Test-PathOk 'node_modules\better-sqlite3\build\Release\better_sqlite3.node' 'Native SQLite module'

$verLine = Select-String -Path 'src\app-version.cjs' -Pattern "APP_VERSION\s*=\s*'([^']+)'" | Select-Object -First 1
if ($verLine) {
    $ver = $verLine.Matches.Groups[1].Value
    Write-Host "  OK  APP_VERSION $ver" -ForegroundColor Green
} else {
    Write-Host "  FAIL  Could not read APP_VERSION" -ForegroundColor Red
    $fail++
}

Write-Host ""
if ($fail -gt 0) {
    Write-Host "=== SITE VERIFY FAILED ($fail issue(s)) ===" -ForegroundColor Red
    Write-Host "Re-copy resources/app from home after npm run prepare:store"
    Write-Host ""
    exit 1
}

Write-Host "=== SITE VERIFY OK ===" -ForegroundColor Green
Write-Host "Start TGP Command Center V3.exe and confirm VERSION $ver on mobile login."
Write-Host "See PATCH_NOTES.txt for this release."
Write-Host "DO NOT overwrite tgp_ops.db or backups\ when updating."
Write-Host ""
