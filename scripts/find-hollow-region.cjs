'use strict';

/** Fast hollow-box finder for a PDF-coord region on an upright page JPEG. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const pageIndex = Number(process.argv[2] || 0);
const pdfX1 = Number(process.argv[3]);
const pdfY1 = Number(process.argv[4]);
const pdfX2 = Number(process.argv[5]);
const pdfY2 = Number(process.argv[6]);
const label = process.argv[7] || 'region';

const W = 1700; const H = 2200; const PDF_W = 612; const PDF_H = 792;
function pixX(x) { return Math.round((x * W) / PDF_W); }
function pixY(y) { return Math.round(((PDF_H - y) * H) / PDF_H); }

const left = Math.min(pixX(pdfX1), pixX(pdfX2));
const right = Math.max(pixX(pdfX1), pixX(pdfX2));
const top = Math.min(pixY(pdfY1), pixY(pdfY2));
const bottom = Math.max(pixY(pdfY1), pixY(pdfY2));

const calib = path.join(__dirname, '..', '_calib');
const src = path.join(calib, `page-${pageIndex}.jpg`).replace(/\\/g, '/');
const out = path.join(calib, `hollow-${label}.txt`).replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), `tgp-hollow-reg-${label}.ps1`);

fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$w=$bmp.Width; $h=$bmp.Height
function IsDark($x,$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { return $false }
  return ($bmp.GetPixel([int]$x,[int]$y).R -lt 115)
}
function IsLight($x,$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { return $false }
  return ($bmp.GetPixel([int]$x,[int]$y).R -gt 165)
}
$found = New-Object System.Collections.Generic.List[string]
for ($size = 12; $size -le 18; $size++) {
  for ($y = ${top}; $y -le (${bottom} - $size); $y += 1) {
    for ($x = ${left}; $x -le (${right} - $size); $x += 1) {
      $topE=0; $botE=0; $leftE=0; $rightE=0
      for ($i=0; $i -lt $size; $i++) {
        if (IsDark ($x+$i) $y) { $topE++ }
        if (IsDark ($x+$i) ($y+$size-1)) { $botE++ }
        if (IsDark $x ($y+$i)) { $leftE++ }
        if (IsDark ($x+$size-1) ($y+$i)) { $rightE++ }
      }
      $need = [math]::Floor($size * 0.7)
      if ($topE -lt $need -or $botE -lt $need -or $leftE -lt $need -or $rightE -lt $need) { continue }
      $inner=0; $innerN=0
      for ($iy=3; $iy -lt ($size-3); $iy++) {
        for ($ix=3; $ix -lt ($size-3); $ix++) {
          $innerN++
          if (IsLight ($x+$ix) ($y+$iy)) { $inner++ }
        }
      }
      if ($innerN -eq 0) { continue }
      if (($inner * 1.0 / $innerN) -lt 0.6) { continue }
      $cx = $x + [int]($size/2.0)
      $cy = $y + [int]($size/2.0)
      $pdfX = [math]::Round($cx * ${PDF_W} / ${W}, 1)
      $pdfY = [math]::Round(${PDF_H} - ($cy * ${PDF_H} / ${H}), 1)
      $found.Add("$pdfX,$pdfY,size=$size")
    }
  }
}
$dedup = New-Object System.Collections.Generic.List[string]
$pts = @()
foreach ($line in $found) {
  $p = $line.Split(','); $px=[double]$p[0]; $py=[double]$p[1]
  $dup=$false
  foreach ($q in $pts) {
    if ([math]::Abs($q[0]-$px) -lt 3 -and [math]::Abs($q[1]-$py) -lt 3) { $dup=$true; break }
  }
  if (-not $dup) { $pts += ,@($px,$py); $dedup.Add($line) }
}
$sorted = $dedup | Sort-Object { -[double](($_ -split ',')[1]) }, { [double](($_ -split ',')[0]) }
$sorted | Set-Content -Encoding utf8 '${out}'
$bmp.Dispose()
Write-Output ('count=' + $dedup.Count)
`);

console.log(execFileSync('powershell', ['-NoProfile', '-File', ps], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
}).trim());
console.log(fs.readFileSync(path.join(calib, `hollow-${label}.txt`), 'utf8'));
