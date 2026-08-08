#Requires -Version 5.1
<#
  Self-elevating install for TGP Command Center Windows service.
  Double-click INSTALL.cmd, approve UAC, watch for === SERVICE OK ===

  The service runs Electron as Node (ELECTRON_RUN_AS_NODE=1) so better-sqlite3
  stays on ABI 145 — same as the desktop .exe. Always 145.

  Or from elevated PowerShell:
    cd ...\resources\app\service
    .\Install-TGP-Service.ps1 -NoElevate
#>
param(
    [switch]$NoElevate,
    [switch]$NoPause
)

$ErrorActionPreference = "Stop"
$ServiceDir = $PSScriptRoot
$AppRoot = Split-Path -Parent $ServiceDir
$Scripts = Join-Path $AppRoot "scripts"
$Runtime = Join-Path $AppRoot "runtime\node"
$Wrapper = Join-Path $ServiceDir "TGP-CommandCenter.exe"
$XmlPath = Join-Path $ServiceDir "TGP-CommandCenter.xml"
$LogFile = Join-Path $ServiceDir "install.log"
$ReadyUrl = "http://127.0.0.1:3001/api/ready"

# Install root = parent of resources\ (same place Electron keeps tgp_ops.db)
$InstallRoot = (Resolve-Path (Join-Path $AppRoot "..\..")).Path
# Optional override: service\tgp-data-dir.txt (one line = absolute data folder)
$dataDirFile = Join-Path $ServiceDir "tgp-data-dir.txt"
if (Test-Path $dataDirFile) {
    $override = (Get-Content $dataDirFile -Raw).Trim()
    if ($override -and (Test-Path $override)) {
        $InstallRoot = (Resolve-Path $override).Path
    }
}
$ServerCjs = Join-Path $AppRoot "server.cjs"
$ElectronExe = Join-Path $AppRoot "node_modules\electron\dist\electron.exe"
$PortableNode = Join-Path $Runtime "node.exe"
$LogPath = Join-Path $ServiceDir "logs"

function Write-Log([string]$msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
    Write-Host $msg
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Wait-KeyIfNeeded {
    if (-not $NoPause) { pause }
}

function Invoke-ElectronNode {
    param([Parameter(Mandatory=$true)][string[]]$ElectronArgs)
    $prev = $env:ELECTRON_RUN_AS_NODE
    $env:ELECTRON_RUN_AS_NODE = "1"
    try {
        & $ElectronExe @ElectronArgs
        return $LASTEXITCODE
    } finally {
        if ($null -eq $prev) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
        else { $env:ELECTRON_RUN_AS_NODE = $prev }
    }
}

function Stop-ConflictingListeners {
    # Free port 3001 + release tgp-server.lock so WinSW can bind.
    $lockPath = Join-Path $InstallRoot "tgp-server.lock"
    if (Test-Path $lockPath) {
        try {
            $lock = Get-Content $lockPath -Raw | ConvertFrom-Json
            if ($lock.pid) {
                $proc = Get-Process -Id ([int]$lock.pid) -ErrorAction SilentlyContinue
                if ($proc) {
                    Write-Log "Stopping prior TGP server pid=$($lock.pid) ($($proc.ProcessName))"
                    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
                }
            }
        } catch {
            Write-Log "Lock read skipped: $($_.Exception.Message)"
        }
        Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
    }

    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
        $cmd = [string]$_.CommandLine
        if ($cmd -and ($cmd -like "*server.cjs*") -and ($cmd -like "*$AppRoot*")) {
            Write-Log "Stopping node server.cjs pid=$($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    }

    # Desktop .exe hosting the API will fight the service for port 3001.
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -match 'TGP|electron' -or ($_.Path -and $_.Path -like "*\TGP_V*\*")
    } | ForEach-Object {
        if ($_.Path -and ($_.Path -like "*$InstallRoot*" -or $_.ProcessName -match '^TGP')) {
            Write-Log "Stopping desktop app pid=$($_.Id) ($($_.ProcessName)) so service can own port 3001"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 2
}

# Fresh log
"=== TGP service install log ===" | Set-Content -Path $LogFile -Encoding UTF8
Write-Log "Script: $PSCommandPath"
Write-Log "ServiceDir: $ServiceDir"

if (-not $NoElevate -and -not (Test-Admin)) {
    Write-Log "Not admin - requesting UAC elevation..."
    Write-Host ""
    Write-Host "*** Click YES on the Administrator / UAC prompt ***"
    Write-Host ""
    $nopauseArg = if ($NoPause) { " -NoPause" } else { "" }
    $arg = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -NoElevate$nopauseArg"
    try {
        $p = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arg -Wait -PassThru
        Write-Log "Elevated process exit code: $($p.ExitCode)"
        if (Test-Path $LogFile) { Get-Content $LogFile | Select-Object -Last 50 }
        if ($p.ExitCode -ne 0) {
            Write-Host ""
            Write-Host "INSTALL FAILED (exit $($p.ExitCode)). See install.log in this folder."
            Wait-KeyIfNeeded
        }
        exit $p.ExitCode
    } catch {
        Write-Log "UAC elevation failed or was cancelled: $($_.Exception.Message)"
        Write-Host ""
        Write-Host "You must click YES on the Administrator prompt for the service to install."
        Write-Host "Or open an elevated PowerShell and run:"
        Write-Host "  cd `"$ServiceDir`""
        Write-Host "  .\Install-TGP-Service.ps1 -NoElevate"
        Wait-KeyIfNeeded
        exit 1
    }
}

if (-not (Test-Admin)) {
    Write-Log "ERROR: still not running as Administrator."
    Wait-KeyIfNeeded
    exit 1
}

Write-Log "=== TGP service install (admin) ==="
Write-Log "App: $AppRoot"
Write-Log "Data: $InstallRoot"
Write-Log "User: $env:USERNAME"
Write-Log "Runtime: Electron as Node (ABI 145 always)"

# 1) Fetch WinSW (+ portable Node for optional rebuild tooling) if missing
$fetchPs1 = Join-Path $Scripts "fetch-service-runtime.ps1"
if (-not (Test-Path $Wrapper) -or -not (Test-Path $PortableNode)) {
    Write-Log "Fetching WinSW + portable Node tooling..."
    & $fetchPs1
    if (-not $?) { throw "fetch-service-runtime failed" }
}

if (-not (Test-Path $Wrapper)) { throw "Missing $Wrapper after fetch" }
if (-not (Test-Path $ServerCjs)) { throw "Missing $ServerCjs" }
if (-not (Test-Path $XmlPath)) { throw "Missing $XmlPath" }
if (-not (Test-Path $ElectronExe)) {
    throw "Missing Electron runtime: $ElectronExe — copy full node_modules (include electron) from home prepare:store"
}

$abiOut = ""
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $abiOut = & cmd /c "set ELECTRON_RUN_AS_NODE=1&& `"$ElectronExe`" -e `"process.stdout.write(process.versions.modules+' '+process.versions.electron)`"" 2>&1
} finally {
    $ErrorActionPreference = $prevEap
}
Write-Log "Electron-as-Node: $abiOut"
if ("$abiOut" -notmatch '\b145\b') {
    Write-Log "WARNING: expected NODE_MODULE_VERSION 145 from Electron; got: $abiOut"
}

# 2) Verify / rebuild better-sqlite3 for Electron ABI 145
Write-Log "Verifying better-sqlite3 under Electron ABI 145 (rebuild if needed)..."
Push-Location $AppRoot
try {
    $probeFile = Join-Path $AppRoot "_tgp_sqlite_probe.cjs"
    @(
        "'use strict';"
        "const Database = require('better-sqlite3');"
        "const d = new Database(':memory:');"
        "d.close();"
        "console.log('better-sqlite3 OK ABI', process.versions.modules);"
    ) | Set-Content -Path $probeFile -Encoding ASCII

    $probeOk = $false
    $ErrorActionPreference = "Continue"
    try {
        $probeOut = & cmd /c "set ELECTRON_RUN_AS_NODE=1&& `"$ElectronExe`" `"$probeFile`"" 2>&1
        $probeCode = $LASTEXITCODE
        foreach ($line in @($probeOut)) { Write-Log ("probe: " + $line) }
        if ($probeCode -eq 0) { $probeOk = $true }
    } finally {
        $ErrorActionPreference = $prevEap
        Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
    }

    if (-not $probeOk) {
        Write-Log "Native module mismatch - rebuilding better-sqlite3 for the installed Electron version (ABI 145)..."
        $ErrorActionPreference = "Continue"
        try {
            $npm = Get-Command npm -ErrorAction SilentlyContinue
            if ($npm) {
                $rebuildOut = & npm run rebuild:electron 2>&1
                $rebuildCode = $LASTEXITCODE
            } elseif (Test-Path (Join-Path $Runtime "npm.cmd")) {
                $rebuildOut = & (Join-Path $Runtime "npm.cmd") run rebuild:electron 2>&1
                $rebuildCode = $LASTEXITCODE
            } else {
                throw "npm not found — run npm run rebuild:electron on the home PC before copying, or install Node on this PC"
            }
            foreach ($line in @($rebuildOut)) { Write-Log ("rebuild: " + $line) }
            if ($rebuildCode -ne 0) { throw "rebuild:electron failed ($rebuildCode)" }
        } finally {
            $ErrorActionPreference = $prevEap
        }

        $probeFile = Join-Path $AppRoot "_tgp_sqlite_probe.cjs"
        @(
            "'use strict';"
            "const Database = require('better-sqlite3');"
            "const d = new Database(':memory:');"
            "d.close();"
            "console.log('better-sqlite3 OK ABI', process.versions.modules);"
        ) | Set-Content -Path $probeFile -Encoding ASCII
        $ErrorActionPreference = "Continue"
        try {
            $verifyOut = & cmd /c "set ELECTRON_RUN_AS_NODE=1&& `"$ElectronExe`" `"$probeFile`"" 2>&1
            $verifyCode = $LASTEXITCODE
            foreach ($line in @($verifyOut)) { Write-Log ("verify: " + $line) }
            if ($verifyCode -ne 0) { throw "better-sqlite3 still cannot load under Electron ABI 145" }
        } finally {
            $ErrorActionPreference = $prevEap
            Remove-Item $probeFile -Force -ErrorAction SilentlyContinue
        }
    } else {
        Write-Log "better-sqlite3 OK under Electron ABI 145 (no rebuild needed)"
    }
} finally {
    Pop-Location
}

New-Item -ItemType Directory -Force -Path $LogPath | Out-Null
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null

# 2b) Free port 3001 (orphan node / desktop .exe) before WinSW starts
Stop-ConflictingListeners

# 3) Always rewrite XML with absolute paths for THIS install
# Service executable = Electron as Node so ABI is always 145.
$xml = @"
<service>
  <id>TGP-CommandCenter</id>
  <name>TGP Command Center</name>
  <description>TGP Command Center headless API (phones, TV, /rec). Starts at boot before login. Electron-as-Node ABI 145.</description>
  <executable>$ElectronExe</executable>
  <arguments>"$ServerCjs"</arguments>
  <workingdirectory>$AppRoot</workingdirectory>
  <env name="ELECTRON_RUN_AS_NODE" value="1"/>
  <env name="TGP_SERVICE" value="1"/>
  <env name="TGP_DATA_DIR" value="$InstallRoot"/>
  <logmode>rotate</logmode>
  <logpath>$LogPath</logpath>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
</service>
"@
Set-Content -Path $XmlPath -Value $xml -Encoding UTF8
Write-Log "Wrote absolute paths into TGP-CommandCenter.xml"
Write-Log "  executable: $ElectronExe (ELECTRON_RUN_AS_NODE=1)"
Write-Log "  data: $InstallRoot"

# 3b) LAN firewall: HTTP phones + HTTPS camera
foreach ($rule in @(
    @{ Name = 'TGP Command Center HTTP'; Port = 3001 },
    @{ Name = 'TGP Command Center HTTPS'; Port = 3443 }
)) {
    try {
        netsh advfirewall firewall delete rule name="$($rule.Name)" | Out-Null
        $fw = netsh advfirewall firewall add rule name="$($rule.Name)" dir=in action=allow protocol=TCP localport=$($rule.Port) 2>&1
        Write-Log "firewall $($rule.Name) :$($rule.Port): $fw"
    } catch {
        Write-Log "firewall warn $($rule.Name): $($_.Exception.Message)"
    }
}

# 4) Install + start
Write-Log "Installing Windows service TGP-CommandCenter..."
Push-Location $ServiceDir
try {
    & $Wrapper stop 2>&1 | ForEach-Object { Write-Log "stop: $_" }
    & $Wrapper uninstall 2>&1 | ForEach-Object { Write-Log "uninstall: $_" }
    $installOut = & $Wrapper install 2>&1
    $installOut | ForEach-Object { Write-Log "install: $_" }
    if ($LASTEXITCODE -ne 0) { throw "WinSW install failed ($LASTEXITCODE)" }

    $startOut = & $Wrapper start 2>&1
    $startOut | ForEach-Object { Write-Log "start: $_" }
    if ($LASTEXITCODE -ne 0) { throw "WinSW start failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

Write-Log "Waiting for $ReadyUrl ..."
$ok = $false
$body = $null
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri $ReadyUrl -TimeoutSec 2
        if ($r.StatusCode -eq 200) {
            $ok = $true
            $body = $r.Content
            Write-Log "ready: $body"
            break
        }
    } catch {
        Start-Sleep -Seconds 1
    }
}

$sc = & sc.exe query TGP-CommandCenter 2>&1
$sc | ForEach-Object { Write-Log "sc: $_" }

$svc = Get-Service TGP-CommandCenter -ErrorAction SilentlyContinue
if ($svc) {
    Write-Log ("Service Status={0} StartType={1} DisplayName={2}" -f $svc.Status, $svc.StartType, $svc.DisplayName)
} else {
    Write-Log "ERROR: Get-Service TGP-CommandCenter returned nothing"
}

if (-not $ok) {
    Write-Log "ERROR: /api/ready did not respond. Dumping recent logs..."
    Get-ChildItem $LogPath -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Log "--- $($_.Name) ---"
        Get-Content $_.FullName -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Write-Log $_ }
    }
    $errLog = Join-Path $InstallRoot "tgp_error.log"
    if (Test-Path $errLog) {
        Write-Log "--- tgp_error.log ---"
        Get-Content $errLog -Tail 40 | ForEach-Object { Write-Log $_ }
    }
    "FAIL" | Set-Content (Join-Path $ServiceDir "install-result-flag.txt") -Encoding ASCII
    Write-Host ""
    Write-Host "Install did not fully succeed. See: $LogFile"
    Wait-KeyIfNeeded
    exit 1
}

Write-Log "=== SERVICE OK ==="
"OK" | Set-Content (Join-Path $ServiceDir "install-result-flag.txt") -Encoding ASCII
Write-Host ""
Write-Host "Look in services.msc for:  TGP Command Center"
Write-Host "Or run:  sc query TGP-CommandCenter"
Write-Host "Ready: $body"
Write-Host "Log: $LogFile"
Write-Host ""
Wait-KeyIfNeeded
exit 0
