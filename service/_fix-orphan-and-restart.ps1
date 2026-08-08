# Elevated: kill orphan Pulse listeners on 3001/3443, then restart WinSW service.
$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$wrapper = Join-Path $here 'TGP-CommandCenter.exe'
$out = Join-Path $here 'install-result.txt'
function Log($m) { Add-Content $out $m; Write-Host $m }
'' | Set-Content $out
Log "=== $(Get-Date) fix-orphan-and-restart ==="

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

& $wrapper stopwait 2>&1 | ForEach-Object { Log "stop: $_" }
Start-Sleep 2

for ($attempt = 1; $attempt -le 5; $attempt++) {
    $pids = Get-PortPids
    if (-not $pids -or $pids.Count -eq 0) { break }
    Log "attempt $attempt kill pids: $($pids -join ',')"
    foreach ($procId in $pids) {
        & taskkill.exe /F /PID $procId 2>&1 | ForEach-Object { Log "$_" }
    }
    Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.CommandLine -and $_.CommandLine -match 'server\.cjs|TGP_SERVICE') {
            Log "taskkill electron pid=$($_.ProcessId)"
            & taskkill.exe /F /PID $_.ProcessId 2>&1 | ForEach-Object { Log "$_" }
        }
    }
    Start-Sleep 2
}

$still = Get-PortPids
if ($still.Count -gt 0) {
    Log "ERROR: ports still held by $($still -join ',')"
    exit 1
}
Log 'ports clear'

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
