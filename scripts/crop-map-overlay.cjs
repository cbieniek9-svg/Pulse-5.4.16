'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { jpegSize, cropPdfRect } = require('./lib/calib-crop.cjs');

const page = Number(process.argv[2]);
const name = process.argv[3];
const x1 = Number(process.argv[4]);
const y1 = Number(process.argv[5]);
const x2 = Number(process.argv[6]);
const y2 = Number(process.argv[7]);
const src = path.join(__dirname, '..', '_calib', `map-overlay-${page}.jpg`).replace(/\\/g, '/');
const { width: W, height: H } = jpegSize(src);
const { left, top, right, bottom: bot } = cropPdfRect(W, H, x1, y1, x2, y2);
const dst = path.join(__dirname, '..', '_calib', `${name}.jpg`).replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), `crop-${name}.ps1`);
fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src}')
$r = New-Object System.Drawing.Rectangle ${left}, ${top}, ${right - left}, ${bot - top}
$b = $src.Clone($r, $src.PixelFormat)
$b.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$b.Dispose(); $src.Dispose()
Write-Output 'ok'
`);
console.log(execFileSync('powershell', ['-NoProfile', '-File', ps], { encoding: 'utf8' }).trim(), dst);
