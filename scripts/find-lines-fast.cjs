'use strict';

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const pageIndex = Number(process.argv[2] || 0);
const pdfY1 = Number(process.argv[3] || 0);
const pdfY2 = Number(process.argv[4] || 792);
const Wpdf = 612; const Hpdf = 792;
const src = path.join(__dirname, '..', '_calib', `page-${pageIndex}.jpg`);
const { width: W, height: H, data } = jpeg.decode(fs.readFileSync(src), { useTArray: true });
function pixY(y) { return Math.round(((Hpdf - y) * H) / Hpdf); }
function gray(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 255;
    return data[(y * W + x) * 4];
}
const top = Math.min(pixY(pdfY1), pixY(pdfY2));
const bot = Math.max(pixY(pdfY1), pixY(pdfY2));
const lines = [];
for (let y = top; y <= bot; y += 1) {
    let dark = 0;
    for (let x = 80; x < W - 80; x += 3) if (gray(x, y) < 90) dark += 1;
    if (dark > 90) {
        const pdfY = Math.round((Hpdf - (y * Hpdf) / H) * 10) / 10;
        if (!lines.length || lines[lines.length - 1].pixY < y - 3) lines.push({ pixY: y, pdfY, dark });
    }
}
for (const l of lines) console.log(`pdfY=${l.pdfY} dark=${l.dark}`);
