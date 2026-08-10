'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const map = require('../src/lib/incident-investigation-pdf-map.cjs');
const { jpegSize, pdfToPix } = require('./lib/calib-crop.cjs');

const calib = path.join(__dirname, '..', '_calib');
for (let page = 0; page < 5; page += 1) {
    const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
    const { width: W, height: H } = jpegSize(src);
    const marks = [];
    for (const field of map.checks.filter((c) => c.page === page)) {
        const p = pdfToPix(W, H, field.x, field.y);
        marks.push(`C,${p.x},${p.y}`);
    }
    for (const field of map.texts.filter((t) => t.page === page)) {
        const p = pdfToPix(W, H, field.x, field.y);
        marks.push(`T,${p.x},${p.y}`);
    }
    const marksFile = path.join(calib, `mapmarks-${page}.txt`).replace(/\\/g, '/');
    const dst = path.join(calib, `map-overlay-${page}.jpg`).replace(/\\/g, '/');
    fs.writeFileSync(marksFile, marks.join('\n'));
    const ps = path.join(os.tmpdir(), `tgp-mapov-${page}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::DeepSkyBlue)
foreach ($line in Get-Content '${marksFile}') {
  $p = $line.Split(','); $x=[int]$p[1]; $y=[int]$p[2]
  if ($p[0] -eq 'C') {
    $g.DrawLine($pen, $x-7, $y-7, $x+7, $y+7)
    $g.DrawLine($pen, $x-7, $y+7, $x+7, $y-7)
  } else {
    $g.FillEllipse($brush, $x-5, $y-5, 10, 10)
  }
}
$g.Dispose()
$bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
Write-Output 'ok'
`);
    console.log(page, execFileSync('powershell', ['-NoProfile', '-File', ps], { encoding: 'utf8' }).trim());
}
