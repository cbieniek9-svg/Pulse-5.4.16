'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const img = path.resolve(__dirname, '../_p4.jpg');
const psPath = path.join(os.tmpdir(), 'tgp-measure-signoff.ps1');
const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${img.replace(/'/g, "''")}'
$w=$bmp.Width; $h=$bmp.Height
Write-Output ("SIZE $w x $h")
# Sample horizontal dark lines in sign-off region (lower half)
for ($y = [int]($h*0.45); $y -lt ($h-40); $y += 2) {
  $dark=0
  for ($x=80; $x -lt ($w-80); $x += 6) {
    if ($bmp.GetPixel($x,$y).R -lt 90) { $dark++ }
  }
  if ($dark -gt 50) {
    $pdfY = [math]::Round(792 - ($y * 792.0 / $h), 1)
    Write-Output ("LINE yPix=$y pdfY=$pdfY dark=$dark")
  }
}
# Sample vertical structure around Name/Date/Signature columns in lower area
foreach ($x in 200,280,360,440,520,600,700,800,900,1000,1100,1200,1300,1400,1500) {
  $dark=0
  for ($y=[int]($h*0.55); $y -lt ($h-60); $y += 4) {
    if ($bmp.GetPixel($x,$y).R -lt 100) { $dark++ }
  }
  if ($dark -gt 8) {
    $pdfX = [math]::Round($x * 612.0 / $w, 1)
    Write-Output ("VCOL xPix=$x pdfX=$pdfX dark=$dark")
  }
}
$bmp.Dispose()
`;
fs.writeFileSync(psPath, ps);
console.log(execFileSync('powershell', ['-NoProfile', '-File', psPath], { encoding: 'utf8' }));
