#Requires -Version 5.1
param(
    [string]$NodeVersion = "24.15.0",
    [string]$WinSWVersion = "2.12.0",
    [switch]$SkipNode
)

$ErrorActionPreference = "Stop"
$AppRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $AppRoot "runtime\node"
$ServiceDir = Join-Path $AppRoot "service"
$TempDir = Join-Path $env:TEMP "tgp-service-runtime"

New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
New-Item -ItemType Directory -Force -Path $ServiceDir | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

function Get-File([string]$Url, [string]$OutFile) {
    Write-Host "GET $Url"
    Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
}

# --- Portable Node ---
$nodeExe = Join-Path $RuntimeDir "node.exe"
if (-not $SkipNode -and -not (Test-Path $nodeExe)) {
    $nodeZipName = "node-v$NodeVersion-win-x64.zip"
    $nodeUrl = "https://nodejs.org/dist/v$NodeVersion/$nodeZipName"
    $nodeZip = Join-Path $TempDir $nodeZipName
    Get-File $nodeUrl $nodeZip
    $extractTo = Join-Path $TempDir "node-extract"
    if (Test-Path $extractTo) { Remove-Item -Recurse -Force $extractTo }
    Expand-Archive -Path $nodeZip -DestinationPath $extractTo -Force
    $inner = Join-Path $extractTo "node-v$NodeVersion-win-x64"
    if (-not (Test-Path (Join-Path $inner "node.exe"))) {
        throw "Node zip layout unexpected - node.exe not found under $inner"
    }
    Copy-Item -Path (Join-Path $inner "*") -Destination $RuntimeDir -Recurse -Force
    $ver = & $nodeExe -v
    Write-Host "OK  Node $ver -> $RuntimeDir"
} elseif (-not $SkipNode) {
    $ver = & $nodeExe -v
    Write-Host "OK  Node already at $nodeExe ($ver)"
}

# --- WinSW ---
$winswExe = Join-Path $ServiceDir "TGP-CommandCenter.exe"
if (-not (Test-Path $winswExe)) {
    $winswUrl = "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW-x64.exe"
    Get-File $winswUrl $winswExe
    Write-Host "OK  WinSW -> $winswExe"
} else {
    Write-Host "OK  WinSW already at $winswExe"
}

Write-Host "Done."
