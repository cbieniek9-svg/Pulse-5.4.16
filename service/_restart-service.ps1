# Update WinSW XML for this install folder + restart service; log to install-result.txt
# Service always runs Electron as Node (ABI 145).
$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
$app = Split-Path -Parent $here
$installRoot = (Resolve-Path (Join-Path $app "..\..")).Path
# Optional override: service\tgp-data-dir.txt (one line = absolute data folder).
# Keeps app code on Desktop while the store DB stays on E:\ (or any other path).
$dataDirFile = Join-Path $here "tgp-data-dir.txt"
if (Test-Path $dataDirFile) {
  $override = (Get-Content $dataDirFile -Raw).Trim()
  if ($override -and (Test-Path $override)) { $installRoot = (Resolve-Path $override).Path }
}
$out = Join-Path $here "install-result.txt"
$wrapper = Join-Path $here "TGP-CommandCenter.exe"
$electron = Join-Path $app "node_modules\electron\dist\electron.exe"
$server = Join-Path $app "server.cjs"
function Log($m) { Add-Content $out $m; Write-Host $m }
"" | Set-Content $out
Log "=== $(Get-Date) restart ==="
Log "app $app"
Log "data $installRoot"
if (-not (Test-Path $electron)) { Log "ERROR: missing $electron"; exit 1 }
if (-not (Test-Path $wrapper)) { Log "ERROR: missing $wrapper"; exit 1 }
$abi = & cmd /c "set ELECTRON_RUN_AS_NODE=1&& `"$electron`" -e `"process.stdout.write(process.versions.modules+' '+process.versions.electron)`""
Log "electron-as-node $abi"
Push-Location $app
try {
  & cmd /c "set ELECTRON_RUN_AS_NODE=1&& `"$electron`" -e `"require('better-sqlite3'); console.log('sqlite ok ABI', process.versions.modules)`"" 2>&1 | ForEach-Object { Log $_ }
  $sqliteExit = $LASTEXITCODE
  if ($sqliteExit -ne 0) {
    Log "ERROR: sqlite check failed (exit $sqliteExit)"
    exit 1
  }
} finally { Pop-Location }

# refresh xml for THIS folder (never keep a previous machine's absolute paths)
$xml = @"
<service>
  <id>TGP-CommandCenter</id>
  <name>TGP Command Center</name>
  <description>TGP Command Center headless API (phones, TV, /rec). Starts at boot before login. Electron-as-Node ABI 145.</description>
  <executable>$electron</executable>
  <arguments>"$server"</arguments>
  <workingdirectory>$app</workingdirectory>
  <env name="ELECTRON_RUN_AS_NODE" value="1"/>
  <env name="TGP_SERVICE" value="1"/>
  <env name="TGP_DATA_DIR" value="$installRoot"/>
  <logmode>rotate</logmode>
  <logpath>$here\logs</logpath>
  <onfailure action="restart" delay="5 sec"/>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
</service>
"@
Set-Content (Join-Path $here "TGP-CommandCenter.xml") $xml -Encoding UTF8

Push-Location $here
try {
  & $wrapper stopwait 2>&1 | ForEach-Object { Log "stop: $_" }
  Start-Sleep 2
  & $wrapper start 2>&1 | ForEach-Object { Log "start: $_" }
  Start-Sleep 10
  Log "status: $(& $wrapper status 2>&1)"
  Log (sc.exe query TGP-CommandCenter | Out-String)
  try {
    $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/api/ready -TimeoutSec 15
    Log "ready: $($r.Content)"
  } catch {
    Log "ready fail: $($_.Exception.Message)"
    Get-Content (Join-Path $here "logs\TGP-CommandCenter.err.log") -Tail 20 -ErrorAction SilentlyContinue | ForEach-Object { Log $_ }
    exit 1
  }
} finally { Pop-Location }
