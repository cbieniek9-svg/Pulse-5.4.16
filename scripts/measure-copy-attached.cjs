'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const img = path.resolve(__dirname, '../_p4.jpg').replace(/\\/g, '/');
const psPath = path.join(os.tmpdir(), 'tgp-copy-att.ps1');
fs.writeFileSync(psPath, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${img}'
$seen = @{}
for ($y = 460; $y -lt 540; $y += 2) {
  for ($x = 1200; $x -lt 1550; $x += 2) {
    if ($bmp.GetPixel($x, $y).R -gt 70) { continue }
    $d = 0
    for ($dy = 0; $dy -lt 12; $dy++) {
      for ($dx = 0; $dx -lt 12; $dx++) {
        if ($bmp.GetPixel(($x + $dx), ($y + $dy)).R -lt 100) { $d++ }
      }
    }
    if ($d -ge 35 -and $d -le 100) {
      $pdfX = [math]::Round(($x + 5) * 612.0 / 1700, 1)
      $pdfY = [math]::Round(792 - (($y + 5) * 792.0 / 2200), 1)
      $key = [string]$pdfX
      if (-not $seen.ContainsKey($key)) {
        $seen[$key] = $true
        Write-Output ("box pdfX=$pdfX pdfY=$pdfY")
      }
      $x += 18
    }
  }
}
$bmp.Dispose()
`);
console.log(execFileSync('powershell', ['-NoProfile', '-File', psPath], { encoding: 'utf8' }));
