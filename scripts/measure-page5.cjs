'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const img = path.resolve(__dirname, '../_p4.jpg');
const psPath = path.join(os.tmpdir(), 'tgp-measure-p5.ps1');
const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${img.replace(/'/g, "''")}'
$w=$bmp.Width; $h=$bmp.Height
function PdfX($x) { return [math]::Round($x * 612.0 / $w, 1) }
function PdfY($y) { return [math]::Round(792 - ($y * 792.0 / $h), 1) }

Write-Output '--- SUPPORTING DOC HORIZ LINES ---'
for ($y = 250; $y -lt 1100; $y += 2) {
  $dark=0
  for ($x=60; $x -lt 1640; $x += 5) {
    if ($bmp.GetPixel($x,$y).R -lt 85) { $dark++ }
  }
  if ($dark -gt 70) { Write-Output ("yPix=$y pdfY=$(PdfY $y) dark=$dark") }
}

Write-Output '--- SIGN-OFF VERTICAL RULES (lower) ---'
for ($x = 80; $x -lt 1620; $x += 2) {
  $dark=0
  for ($y=1080; $y -lt 1450; $y += 3) {
    if ($bmp.GetPixel($x,$y).R -lt 90) { $dark++ }
  }
  if ($dark -gt 25) { Write-Output ("xPix=$x pdfX=$(PdfX $x) dark=$dark") }
}

Write-Output '--- UTILIZED YES BOX SAMPLE (row1 area) ---'
# Rough: find small dark squares in utilized region for first data row
for ($y = 320; $y -lt 420; $y += 1) {
  for ($x = 80; $x -lt 400; $x += 1) {
    $c=$bmp.GetPixel($x,$y)
    if ($c.R -gt 60) { continue }
    # cheap local density
    $d=0
    for ($dy=0; $dy -lt 14; $dy++) {
      for ($dx=0; $dx -lt 14; $dx++) {
        if ($bmp.GetPixel(($x+$dx),($y+$dy)).R -lt 100) { $d++ }
      }
    }
    if ($d -ge 40 -and $d -le 120) {
      Write-Output ("box xPix=$x yPix=$y pdfX=$(PdfX ($x+6)) pdfY=$(PdfY ($y+6)) dens=$d")
      $x += 20
    }
  }
}
$bmp.Dispose()
`;
fs.writeFileSync(psPath, ps);
console.log(execFileSync('powershell', ['-NoProfile', '-File', psPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
}));
