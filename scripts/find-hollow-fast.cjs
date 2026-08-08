'use strict';

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const Wpdf = 612;
const Hpdf = 792;

const pageIndex = Number(process.argv[2] || 0);
const label = process.argv[3] || `p${pageIndex}`;
const pdfX1 = process.argv[4] != null ? Number(process.argv[4]) : 0;
const pdfY1 = process.argv[5] != null ? Number(process.argv[5]) : 0;
const pdfX2 = process.argv[6] != null ? Number(process.argv[6]) : Wpdf;
const pdfY2 = process.argv[7] != null ? Number(process.argv[7]) : Hpdf;

const calib = path.join(__dirname, '..', '_calib');
const src = path.join(calib, `page-${pageIndex}.jpg`);
const raw = jpeg.decode(fs.readFileSync(src), { useTArray: true });
const { width: W, height: H, data } = raw;

function pixX(x) { return Math.round((x * W) / Wpdf); }
function pixY(y) { return Math.round(((Hpdf - y) * H) / Hpdf); }
function toPdf(x, y) {
    return {
        x: Math.round((x * Wpdf) / W * 10) / 10,
        y: Math.round((Hpdf - (y * Hpdf) / H) * 10) / 10,
    };
}
function gray(x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return 255;
    const i = (y * W + x) * 4;
    return data[i]; // R ~= gray for B&W form
}
function dark(x, y) { return gray(x, y) < 115; }
function light(x, y) { return gray(x, y) > 165; }

const left = Math.min(pixX(pdfX1), pixX(pdfX2));
const right = Math.max(pixX(pdfX1), pixX(pdfX2));
const top = Math.min(pixY(pdfY1), pixY(pdfY2));
const bottom = Math.max(pixY(pdfY1), pixY(pdfY2));

const found = [];
for (let size = 12; size <= 18; size += 1) {
    const need = Math.floor(size * 0.72);
    for (let y = top; y <= bottom - size; y += 1) {
        for (let x = left; x <= right - size; x += 1) {
            let topE = 0; let botE = 0; let leftE = 0; let rightE = 0;
            for (let i = 0; i < size; i += 1) {
                if (dark(x + i, y)) topE += 1;
                if (dark(x + i, y + size - 1)) botE += 1;
                if (dark(x, y + i)) leftE += 1;
                if (dark(x + size - 1, y + i)) rightE += 1;
            }
            if (topE < need || botE < need || leftE < need || rightE < need) continue;
            let inner = 0; let innerN = 0;
            for (let iy = 3; iy < size - 3; iy += 1) {
                for (let ix = 3; ix < size - 3; ix += 1) {
                    innerN += 1;
                    if (light(x + ix, y + iy)) inner += 1;
                }
            }
            if (innerN === 0 || inner / innerN < 0.6) continue;
            const cx = x + Math.floor(size / 2);
            const cy = y + Math.floor(size / 2);
            const pdf = toPdf(cx, cy);
            found.push({ ...pdf, size, cx, cy });
        }
    }
}

const dedup = [];
for (const b of found.sort((a, b) => b.y - a.y || a.x - b.x)) {
    if (dedup.some((d) => Math.abs(d.x - b.x) < 3 && Math.abs(d.y - b.y) < 3)) continue;
    dedup.push(b);
}

const outPath = path.join(calib, `hollow-${label}.json`);
fs.writeFileSync(outPath, JSON.stringify(dedup, null, 2));
console.log(`${label}: ${dedup.length} boxes -> ${outPath}`);
for (const b of dedup) console.log(`  ${b.x}, ${b.y} (size ${b.size})`);
