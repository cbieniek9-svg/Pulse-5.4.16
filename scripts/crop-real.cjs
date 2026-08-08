'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612;
const Hpdf = 792;
const W = 1224;
const H = 1584;

const crops = [
    ['real-0.png', 'view-p0-head.png', 40, 500, 560, 720],
    ['real-0.png', 'view-p0-inc.png', 50, 300, 540, 430],
    ['real-0.png', 'view-p0-type.png', 40, 530, 560, 575],
    ['real-1.png', 'view-p1-proc.png', 350, 580, 530, 680],
    ['real-1.png', 'view-p1-acts.png', 50, 90, 380, 420],
    ['real-4.png', 'view-p4-docs.png', 70, 430, 530, 620],
    ['real-4.png', 'view-p4-sign.png', 150, 250, 560, 400],
];

function toPix(x, y) {
    return {
        x: Math.round((x * W) / Wpdf),
        y: Math.round(((Hpdf - y) * H) / Hpdf),
    };
}

for (const [src, out, x1, y1, x2, y2] of crops) {
    const a = toPix(x1, y1);
    const b = toPix(x2, y2);
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bot = Math.max(a.y, b.y);
    const srcPath = path.join(calib, src).replace(/\\/g, '/');
    const outPath = path.join(calib, out).replace(/\\/g, '/');
    const ps = path.join(os.tmpdir(), `vcrop-${out}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${srcPath}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$b=$src.Clone($r,$src.PixelFormat)
$b.Save('${outPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose();$src.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
    console.log(out);
}
