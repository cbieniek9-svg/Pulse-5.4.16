'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const calib = path.join(__dirname, '..', '_calib');
const page = Number(process.argv[2] || 0);
const name = process.argv[3] || 'crop';
// args: page name pdfX1 pdfY1 pdfX2 pdfY2  (pdf coords, y from bottom)
const x1 = Number(process.argv[4]);
const y1 = Number(process.argv[5]);
const x2 = Number(process.argv[6]);
const y2 = Number(process.argv[7]);
const W = 1700; const H = 2200; const PDF_W = 612; const PDF_H = 792;
function pixX(x) { return Math.round((x * W) / PDF_W); }
function pixY(y) { return Math.round(((PDF_H - y) * H) / PDF_H); }
const left = Math.min(pixX(x1), pixX(x2));
const right = Math.max(pixX(x1), pixX(x2));
const top = Math.min(pixY(y1), pixY(y2));
const bottom = Math.max(pixY(y1), pixY(y2));
const src = path.join(calib, `grid-${page}.jpg`).replace(/\\/g, '/');
const dst = path.join(calib, `${name}.jpg`).replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), `tgp-crop-${name}.ps1`);
fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src}')
$rect = New-Object System.Drawing.Rectangle ${left}, ${top}, ${right - left}, ${bottom - top}
$bmp = $src.Clone($rect, $src.PixelFormat)
$bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose(); $src.Dispose()
Write-Output 'ok'
`);
console.log(execFileSync('powershell', ['-NoProfile', '-File', ps], { encoding: 'utf8' }).trim(), dst);
