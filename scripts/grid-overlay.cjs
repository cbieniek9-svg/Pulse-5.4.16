'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const calib = path.join(root, '_calib');
const pageIndex = Number(process.argv[2] || 0);
const src = path.join(calib, `page-${pageIndex}.jpg`).replace(/\\/g, '/');
const dst = path.join(calib, `grid-${pageIndex}.jpg`).replace(/\\/g, '/');
const W = 1700;
const H = 2200;
const PDF_W = 612;
const PDF_H = 792;

const psPath = path.join(os.tmpdir(), `tgp-grid-${pageIndex}.ps1`);
fs.writeFileSync(psPath, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$font = New-Object System.Drawing.Font 'Consolas', 9
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 255, 0, 0)), 1
$penMajor = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(180, 0, 100, 255)), 1
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Blue)
function PixX($pdfX) { return [int](($pdfX * ${W}) / ${PDF_W}) }
function PixY($pdfY) { return [int](((${PDF_H} - $pdfY) * ${H}) / ${PDF_H}) }
for ($x = 0; $x -le ${PDF_W}; $x += 20) {
  $px = PixX $x
  $p = if ($x % 60 -eq 0) { $penMajor } else { $pen }
  $g.DrawLine($p, $px, 0, $px, ${H})
  if ($x % 40 -eq 0) { $g.DrawString([string]$x, $font, $brush, $px + 2, 20) }
}
for ($y = 0; $y -le ${PDF_H}; $y += 20) {
  $py = PixY $y
  $p = if ($y % 60 -eq 0) { $penMajor } else { $pen }
  $g.DrawLine($p, 0, $py, ${W}, $py)
  if ($y % 40 -eq 0) { $g.DrawString(('y=' + $y), $font, $brush, 8, $py - 12) }
}
$g.Dispose()
$bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Output 'ok'
`);
console.log(execFileSync('powershell', ['-NoProfile', '-File', psPath], { encoding: 'utf8' }).trim(), dst);
