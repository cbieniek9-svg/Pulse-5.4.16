# Minimal elevate: install+start WinSW only (XML already has absolute paths).
# Writes result to service\install-result.txt
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here "install-result.txt"
$wrapper = Join-Path $here "TGP-CommandCenter.exe"
$logDir = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($m) { Add-Content $out $m; Write-Host $m }

"" | Set-Content $out
Log "=== $(Get-Date) ==="
Log "Admin? $(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))"

Push-Location $here
try {
  Log "stop: $(& $wrapper stop 2>&1)"
  Log "uninstall: $(& $wrapper uninstall 2>&1)"
  Log "install: $(& $wrapper install 2>&1) exit=$LASTEXITCODE"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  Log "start: $(& $wrapper start 2>&1) exit=$LASTEXITCODE"
  Log "status: $(& $wrapper status 2>&1)"
  Log "sc: $(sc.exe query TGP-CommandCenter 2>&1 | Out-String)"
  try {
    $r = Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3001/api/ready -TimeoutSec 15
    Log "ready: $($r.Content)"
  } catch {
    Log "ready fail: $($_.Exception.Message)"
    if (Test-Path (Join-Path $logDir "*")) {
      Get-ChildItem $logDir | ForEach-Object { Log "--- $($_.Name) ---"; Get-Content $_.FullName -Tail 30 | ForEach-Object { Log $_ } }
    }
  }
} finally {
  Pop-Location
}
