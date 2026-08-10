'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');

const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612; const Hpdf = 792;
const { width: W, height: H, data } = jpeg.decode(fs.readFileSync(path.join(calib, 'page-0.jpg')), { useTArray: true });

// Crop Type row and draw PDF-x ruler + candidates
const y1 = 540; const y2 = 565;
const x1 = 60; const x2 = 520;
const top = Math.round(((Hpdf - y2) * H) / Hpdf);
const bot = Math.round(((Hpdf - y1) * H) / Hpdf);
const left = Math.round((x1 * W) / Wpdf);
const right = Math.round((x2 * W) / Wpdf);
const src = path.join(calib, 'page-0.jpg').replace(/\\/g, '/');
const dst = path.join(calib, 'ruler-type.jpg').replace(/\\/g, '/');
const marks = [];
// tick every 10 pdf pts
for (let px = x1; px <= x2; px += 10) {
    const x = Math.round((px * W) / Wpdf) - left;
    marks.push(`T,${x},${px}`);
}
// known candidates
for (const [px, label] of [[119.2, 'FT'], [248.8, 'PT'], [330, 'A'], [340, 'B'], [350, 'C'], [360, 'D'], [370, 'E'], [380, 'F'], [387, 'G'], [398, 'H'], [478, 'CU']]) {
    const x = Math.round((px * W) / Wpdf) - left;
    marks.push(`C,${x},${label}`);
}
const mf = path.join(calib, 'ruler-marks.txt').replace(/\\/g, '/');
fs.writeFileSync(mf, marks.join('\n'));
const ps = path.join(os.tmpdir(), 'ruler-type.ps1');
fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${src}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$crop=$src.Clone($r,$src.PixelFormat)
$g=[System.Drawing.Graphics]::FromImage($crop)
$pen=New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 1
$penB=New-Object System.Drawing.Pen ([System.Drawing.Color]::Blue), 1
$font=New-Object System.Drawing.Font 'Consolas', 9
$brush=New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Blue)
$brushR=New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Red)
foreach ($line in Get-Content '${mf}') {
  $p=$line.Split(',')
  if ($p[0] -eq 'T') {
    $x=[int]$p[1]; $lab=$p[2]
    $g.DrawLine($pen, $x, 0, $x, 8)
    if ([int]$lab % 20 -eq 0) { $g.DrawString($lab, $font, $brushR, $x-8, 8) }
  } else {
    $x=[int]$p[1]; $lab=$p[2]
    $g.DrawLine($penB, $x, 12, $x, ${bot - top - 2})
    $g.DrawString($lab, $font, $brush, $x+1, 20)
  }
}
$g.Dispose(); $crop.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$crop.Dispose(); $src.Dispose()
`);
execFileSync('powershell', ['-NoProfile', '-File', ps]);
console.log('wrote', dst);

// Also score emptiness at each candidate using stricter interior
function gray(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 255;
    return data[(y * W + x) * 4];
}
function boxStats(pdfX, pdfY, sizePx = 18) {
    const cx = Math.round((pdfX * W) / Wpdf);
    const cy = Math.round(((Hpdf - pdfY) * H) / Hpdf);
    const x0 = cx - Math.floor(sizePx / 2);
    const y0 = cy - Math.floor(sizePx / 2);
    let edge = 0; let light = 0; let dark = 0; let n = 0;
    for (let i = 0; i < sizePx; i += 1) {
        if (gray(x0 + i, y0) < 100) edge += 1;
        if (gray(x0 + i, y0 + sizePx - 1) < 100) edge += 1;
        if (gray(x0, y0 + i) < 100) edge += 1;
        if (gray(x0 + sizePx - 1, y0 + i) < 100) edge += 1;
    }
    for (let iy = 4; iy < sizePx - 4; iy += 1) {
        for (let ix = 4; ix < sizePx - 4; ix += 1) {
            n += 1;
            const v = gray(x0 + ix, y0 + iy);
            if (v > 190) light += 1;
            if (v < 110) dark += 1;
        }
    }
    return {
        pdfX, edge: edge / (sizePx * 4), light: light / n, dark: dark / n,
        ok: edge / (sizePx * 4) > 0.7 && light / n > 0.75 && dark / n < 0.08,
    };
}
for (const x of [119.2, 248.8, 320, 330, 340, 348, 355, 362, 370, 378, 387, 398, 478]) {
    console.log(x, boxStats(x, 551));
}
