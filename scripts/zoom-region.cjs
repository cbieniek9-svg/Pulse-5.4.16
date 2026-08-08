'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const page = Number(process.argv[2]);
const name = process.argv[3];
const x1 = Number(process.argv[4]);
const y1 = Number(process.argv[5]);
const x2 = Number(process.argv[6]);
const y2 = Number(process.argv[7]);
const scale = Number(process.argv[8] || 3);

const W = 1700; const H = 2200; const Wpdf = 612; const Hpdf = 792;
const px = (x) => Math.round((x * W) / Wpdf);
const py = (y) => Math.round(((Hpdf - y) * H) / Hpdf);
const left = Math.min(px(x1), px(x2));
const right = Math.max(px(x1), px(x2));
const top = Math.min(py(y1), py(y2));
const bot = Math.max(py(y1), py(y2));
const src = path.join(__dirname, '..', '_calib', `page-${page}.jpg`).replace(/\\/g, '/');
const dst = path.join(__dirname, '..', '_calib', `${name}.jpg`).replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), `zoom-${name}.ps1`);
fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src}')
$r = New-Object System.Drawing.Rectangle ${left}, ${top}, ${right - left}, ${bot - top}
$b = $src.Clone($r, $src.PixelFormat)
$big = New-Object System.Drawing.Bitmap ($b.Width * ${scale}), ($b.Height * ${scale})
$g = [System.Drawing.Graphics]::FromImage($big)
$g.InterpolationMode = 'NearestNeighbor'
$g.DrawImage($b, 0, 0, $big.Width, $big.Height)
$big.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose(); $big.Dispose(); $b.Dispose(); $src.Dispose()
Write-Output 'ok'
`);
console.log(execFileSync('powershell', ['-NoProfile', '-File', ps], { encoding: 'utf8' }).trim(), dst);
