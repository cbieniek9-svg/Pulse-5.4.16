'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');

const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612; const Hpdf = 792;
const { width: W, height: H, data } = jpeg.decode(fs.readFileSync(path.join(calib, 'page-0.jpg')), { useTArray: true });
const gray = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return 255;
    return data[(y * W + x) * 4];
};

// Find all strong horizontal rules from pdf y 500..720
const x0 = Math.round((120 * W) / Wpdf);
const x1 = Math.round((520 * W) / Wpdf);
const yTop = Math.round(((Hpdf - 720) * H) / Hpdf);
const yBot = Math.round(((Hpdf - 500) * H) / Hpdf);
const lines = [];
for (let y = Math.min(yTop, yBot); y <= Math.max(yTop, yBot); y += 1) {
    let dark = 0; let n = 0;
    for (let x = x0; x <= x1; x += 2) {
        n += 1;
        if (gray(x, y) < 120) dark += 1;
    }
    if (dark / n > 0.4) lines.push(y);
}
const collapsed = [];
let run = null;
for (const y of lines) {
    if (!run) run = [y, y];
    else if (y <= run[1] + 2) run[1] = y;
    else { collapsed.push(Math.round((run[0] + run[1]) / 2)); run = [y, y]; }
}
if (run) collapsed.push(Math.round((run[0] + run[1]) / 2));

const pdfLines = collapsed.map((y) => ({
    pixY: y,
    pdfY: Math.round((Hpdf - (y * Hpdf) / H) * 10) / 10,
}));
console.log('HEADER LINES', pdfLines);

// Overlay ruler on blank head
const marks = pdfLines.map((l, i) => `L,${Math.round((140 * W) / Wpdf)},${l.pixY},${l.pdfY}`).join('\n');
fs.writeFileSync(path.join(calib, 'header-lines.txt'), marks);
const src = path.join(calib, 'page-0.jpg').replace(/\\/g, '/');
const dst = path.join(calib, 'header-lines.jpg').replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), 'header-lines.ps1');
fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
$font = New-Object System.Drawing.Font 'Consolas', 16
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Blue)
foreach ($line in Get-Content '${path.join(calib, 'header-lines.txt').replace(/\\/g, '/')}') {
  $p=$line.Split(','); $x=[int]$p[1]; $y=[int]$p[2]; $lab=$p[3]
  $g.DrawLine($pen, 50, $y, 1600, $y)
  $g.DrawString($lab, $font, $brush, 50, $y-18)
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
execFileSync('powershell', ['-NoProfile', '-File', ps]);

// crop
const left = Math.round((40 * W) / Wpdf);
const right = Math.round((560 * W) / Wpdf);
const top = Math.round(((Hpdf - 740) * H) / Hpdf);
const bot = Math.round(((Hpdf - 500) * H) / Hpdf);
const ps2 = path.join(os.tmpdir(), 'header-crop.ps1');
fs.writeFileSync(ps2, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${dst}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$b=$src.Clone($r,$src.PixelFormat)
$b.Save('${path.join(calib, 'header-lines-crop.jpg').replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$b.Dispose();$src.Dispose()
`);
execFileSync('powershell', ['-NoProfile', '-File', ps2]);
console.log('wrote header-lines-crop.jpg');
