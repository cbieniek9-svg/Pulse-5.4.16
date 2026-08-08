'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const W = 1700; const H = 2200; const Wpdf = 612; const Hpdf = 792;
const px = (x) => Math.round((x * W) / Wpdf);
const py = (y) => Math.round(((Hpdf - y) * H) / Hpdf);
const left = px(55); const right = px(540);
const top = py(565); const bot = py(538);
const src = path.join(__dirname, '..', '_calib', 'page-0.jpg').replace(/\\/g, '/');
const dst = path.join(__dirname, '..', '_calib', 'type-row-zoom.jpg').replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), 'type-row-zoom.ps1');
fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src}')
$r = New-Object System.Drawing.Rectangle ${left}, ${top}, ${right - left}, ${bot - top}
$b = $src.Clone($r, $src.PixelFormat)
$big = New-Object System.Drawing.Bitmap ($b.Width * 3), ($b.Height * 3)
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = 'NearestNeighbor'
$g.Clear([System.Drawing.Color]::White)
$g.DrawImage($b, 0, 0, $big.Width, $big.Height)
$font = New-Object System.Drawing.Font 'Consolas', 10
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Blue)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 1
for ($x = 60; $x -le 520; $x += 10) {
  $lx = [int](($x - 55) * ${W} / ${Wpdf} * 3)
  $g.DrawLine($pen, $lx, 0, $lx, 12)
  if ($x % 20 -eq 0) { $g.DrawString([string]$x, $font, $brush, $lx + 1, 14) }
}
$big.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $big.Dispose(); $b.Dispose(); $src.Dispose()
Write-Output 'ok'
`);
console.log(execFileSync('powershell', ['-NoProfile', '-File', ps], { encoding: 'utf8' }).trim());
