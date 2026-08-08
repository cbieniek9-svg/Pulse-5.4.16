'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const pageIndex = Number(process.argv[2] || 0);
const calib = path.join(__dirname, '..', '_calib');
const src = path.join(calib, `page-${pageIndex}.jpg`).replace(/\\/g, '/');
const out = path.join(calib, `hollow-${pageIndex}.json`).replace(/\\/g, '/');
const mark = path.join(calib, `hollow-${pageIndex}.jpg`).replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), `tgp-hollow-${pageIndex}.ps1`);

const W = 1700; const H = 2200; const PDF_W = 612; const PDF_H = 792;

fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$w=$bmp.Width; $h=$bmp.Height
function Dark($x,$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { return $false }
  return ($bmp.GetPixel($x,$y).R -lt 110)
}
function Light($x,$y) {
  if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { return $false }
  return ($bmp.GetPixel($x,$y).R -gt 170)
}
$found = New-Object System.Collections.Generic.List[string]
for ($size = 11; $size -le 20; $size++) {
  for ($y = 80; $y -lt ($h - 40); $y += 2) {
    for ($x = 40; $x -lt ($w - 40); $x += 2) {
      # score hollow square of this size with top-left at x,y
      $top=0; $bot=0; $left=0; $right=0; $inner=0; $innerN=0
      for ($i=0; $i -lt $size; $i++) {
        if (Dark ($x+$i) $y) { $top++ }
        if (Dark ($x+$i) ($y+$size-1)) { $bot++ }
        if (Dark $x ($y+$i)) { $left++ }
        if (Dark ($x+$size-1) ($y+$i)) { $right++ }
      }
      $need = [math]::Floor($size * 0.65)
      if ($top -lt $need -or $bot -lt $need -or $left -lt $need -or $right -lt $need) { continue }
      for ($iy=2; $iy -lt ($size-2); $iy++) {
        for ($ix=2; $ix -lt ($size-2); $ix++) {
          $innerN++
          if (Light ($x+$ix) ($y+$iy)) { $inner++ }
        }
      }
      if ($innerN -lt 1) { continue }
      if (($inner * 1.0 / $innerN) -lt 0.55) { continue }
      $cx = $x + [int]($size/2)
      $cy = $y + [int]($size/2)
      $pdfX = [math]::Round($cx * ${PDF_W} / $w, 1)
      $pdfY = [math]::Round(${PDF_H} - ($cy * ${PDF_H} / $h), 1)
      $found.Add("$pdfX,$pdfY,$cx,$cy,$size")
    }
  }
}
# dedupe
$dedup = New-Object System.Collections.Generic.List[string]
$pts = @()
foreach ($line in $found) {
  $p = $line.Split(','); $px=[double]$p[2]; $py=[double]$p[3]
  $dup=$false
  foreach ($q in $pts) {
    if ([math]::Abs($q[0]-$px) -lt 10 -and [math]::Abs($q[1]-$py) -lt 10) { $dup=$true; break }
  }
  if (-not $dup) { $pts += ,@($px,$py); $dedup.Add($line) }
}
$dedup | Sort-Object { [double]($_ -split ',')[1] } -Descending | Set-Content -Encoding utf8 '${out}'
# mark
$g=[System.Drawing.Graphics]::FromImage($bmp)
$pen=New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 2
foreach ($line in $dedup) {
  $p=$line.Split(','); $cx=[int]$p[2]; $cy=[int]$p[3]; $s=[int]$p[4]
  $g.DrawRectangle($pen, ($cx-[int]($s/2)), ($cy-[int]($s/2)), $s, $s)
}
$g.Dispose()
$bmp.Save('${mark}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Output ('count=' + $dedup.Count)
`);

console.log(execFileSync('powershell', ['-NoProfile', '-File', ps], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
}).trim());
const lines = fs.readFileSync(path.join(calib, `hollow-${pageIndex}.json`), 'utf8').split(/\r?\n/).filter(Boolean);
console.log(lines.slice(0, 80).join('\n'));
if (lines.length > 80) console.log(`... ${lines.length} total`);
