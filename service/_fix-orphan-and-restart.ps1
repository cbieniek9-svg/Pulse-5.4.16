# Elevated: kill orphan Pulse listeners on 3001/3443, then restart WinSW service.
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$appRoot = Split-Path -Parent $here
$serverPath = [System.IO.Path]::GetFullPath((Join-Path $appRoot 'server.cjs'))
$serverNeedle = $serverPath.ToLowerInvariant().Replace('/', '\')
$wrapper = Join-Path $here 'TGP-CommandCenter.exe'
$out = Join-Path $here 'install-result.txt'
function Log($m) { Add-Content $out $m; Write-Host $m }
'' | Set-Content $out
Log "=== $(Get-Date) fix-orphan-and-restart ==="
Log "server needle: $serverPath"

function Get-PortPids {
    $found = @()
    foreach ($line in (netstat -ano)) {
        if ($line -match 'LISTENING' -and ($line -match ':3001\s' -or $line -match ':3443\s')) {
            $parts = @(($line -split '\s+') | Where-Object { $_ })
            $pidStr = $parts[-1]
            if ($pidStr -match '^\d+$') { $found += [int]$pidStr }
        }
    }
    return @($found | Select-Object -Unique)
}

function Test-TgpInstallProcess([int]$procId) {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue
    if (-not $p -or -not $p.CommandLine) { return $false }
    $cmd = $p.CommandLine.ToLowerInvariant().Replace('/', '\')
    return $cmd.Contains($serverNeedle)
}

& $wrapper stopwait 2>&1 | ForEach-Object { Log "stop: $_" }
Start-Sleep 2

for ($attempt = 1; $attempt -le 5; $attempt++) {
    $pids = Get-PortPids
    if (-not $pids -or $pids.Count -eq 0) { break }
    Log "attempt $attempt port pids: $($pids -join ',')"
    foreach ($procId in $pids) {
        if (-not (Test-TgpInstallProcess $procId)) {
            Log "skip pid=$procId (cmdline does not contain this install's server.cjs)"
            continue
        }
        Log "taskkill pid=$procId"
        & taskkill.exe /F /PID $procId 2>&1 | ForEach-Object { Log "$_" }
    }
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if (Test-TgpInstallProcess ([int]$_.ProcessId)) {
            Log "taskkill electron pid=$($_.ProcessId)"
            & taskkill.exe /F /PID $_.ProcessId 2>&1 | ForEach-Object { Log "$_" }
        }
    }
    Start-Sleep 2
}

$remaining = @(Get-PortPids)
$stillOurs = @($remaining | Where-Object { Test-TgpInstallProcess $_ })
if ($stillOurs.Count -gt 0) {
    Log "ERROR: ports still held by this install: $($stillOurs -join ',')"
    exit 1
}
$foreign = @($remaining | Where-Object { -not (Test-TgpInstallProcess $_) })
if ($foreign.Count -gt 0) {
    Log "ERROR: ports 3001/3443 held by foreign PID(s): $($foreign -join ',') — not killing; resolve manually before restart"
    exit 1
}
Log 'ports clear for this install'

& $wrapper start 2>&1 | ForEach-Object { Log "start: $_" }
Start-Sleep 8
$status = & $wrapper status 2>&1
Log "status: $status"
$svc = Get-Service TGP-CommandCenter -ErrorAction SilentlyContinue
Log "Get-Service Status=$($svc.Status)"
try {
    $r = Invoke-RestMethod 'http://127.0.0.1:3001/api/ready' -TimeoutSec 8
    Log "ready ok=$($r.ok) v=$($r.appVersion) service=$($r.service) uptime=$([math]::Round($r.uptime,1))"
} catch {
    Log "ready-fail: $($_.Exception.Message)"
    exit 1
}
if ($svc.Status -ne 'Running') {
    Log 'ERROR: service not Running after start'
    exit 2
}
Log 'OK'
exit 0
