'use strict';

/** Interactive region dumps: save zooms + scan for dark square rings with empty interiors. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');

const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612;
const Hpdf = 792;

function load(page) {
    return jpeg.decode(fs.readFileSync(path.join(calib, `page-${page}.jpg`)), { useTArray: true });
}
function toPix(W, H, x, y) {
    return { x: Math.round((x * W) / Wpdf), y: Math.round(((Hpdf - y) * H) / Hpdf) };
}
function toPdf(W, H, x, y) {
    return {
        x: Math.round((x * Wpdf) / W * 10) / 10,
        y: Math.round((Hpdf - (y * Hpdf) / H) * 10) / 10,
    };
}

function scoreBox(gray, W, H, x, y, size) {
    const g = (xx, yy) => {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) return 255;
        return gray[yy * W + xx];
    };
    let edge = 0; let edgeN = 0; let inn = 0; let innN = 0;
    for (let i = 0; i < size; i += 1) {
        edgeN += 4;
        if (g(x + i, y) < 100) edge += 1;
        if (g(x + i, y + size - 1) < 100) edge += 1;
        if (g(x, y + i) < 100) edge += 1;
        if (g(x + size - 1, y + i) < 100) edge += 1;
    }
    const pad = Math.max(2, Math.floor(size * 0.25));
    for (let iy = pad; iy < size - pad; iy += 1) {
        for (let ix = pad; ix < size - pad; ix += 1) {
            innN += 1;
            if (g(x + ix, y + iy) > 180) inn += 1;
        }
    }
    const edgeRatio = edge / edgeN;
    const innRatio = inn / Math.max(innN, 1);
    // Penalize if interior has dark strokes (letters)
    let darkInn = 0;
    for (let iy = pad; iy < size - pad; iy += 1) {
        for (let ix = pad; ix < size - pad; ix += 1) {
            if (g(x + ix, y + iy) < 120) darkInn += 1;
        }
    }
    const darkInnRatio = darkInn / Math.max(innN, 1);
    return edgeRatio * 0.55 + innRatio * 0.45 - darkInnRatio * 0.8;
}

function findBestBoxes(page, pdfX1, pdfY1, pdfX2, pdfY2, { sizes = [12, 13, 14, 15, 16], step = 1, topN = 40 } = {}) {
    const { width: W, height: H, data } = load(page);
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) gray[i] = data[i * 4];
    const left = Math.min(toPix(W, H, pdfX1, 0).x, toPix(W, H, pdfX2, 0).x);
    const right = Math.max(toPix(W, H, pdfX1, 0).x, toPix(W, H, pdfX2, 0).x);
    const top = Math.min(toPix(W, H, 0, pdfY1).y, toPix(W, H, 0, pdfY2).y);
    const bot = Math.max(toPix(W, H, 0, pdfY1).y, toPix(W, H, 0, pdfY2).y);
    const scored = [];
    for (const size of sizes) {
        for (let y = top; y <= bot - size; y += step) {
            for (let x = left; x <= right - size; x += step) {
                const s = scoreBox(gray, W, H, x, y, size);
                if (s < 0.72) continue;
                const cx = x + Math.floor(size / 2);
                const cy = y + Math.floor(size / 2);
                scored.push({ score: +s.toFixed(3), size, ...toPdf(W, H, cx, cy), cx, cy });
            }
        }
    }
    scored.sort((a, b) => b.score - a.score);
    const dedup = [];
    for (const b of scored) {
        if (dedup.some((d) => Math.abs(d.cx - b.cx) < 10 && Math.abs(d.cy - b.cy) < 10)) continue;
        dedup.push(b);
        if (dedup.length >= topN) break;
    }
    return dedup;
}

function markBoxes(page, boxes, outName) {
    const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
    const dst = path.join(calib, outName).replace(/\\/g, '/');
    const marks = boxes.map((b) => `B,${b.cx},${b.cy},${b.size}`).join('\n');
    const mf = path.join(calib, `measure-marks-${outName}.txt`).replace(/\\/g, '/');
    fs.writeFileSync(mf, marks);
    const ps = path.join(os.tmpdir(), `measure-${outName}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 2
$font = New-Object System.Drawing.Font 'Consolas', 14
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Red)
$i=0
foreach ($line in Get-Content '${mf}') {
  $p=$line.Split(','); $cx=[int]$p[1]; $cy=[int]$p[2]; $sz=[int]$p[3]
  $g.DrawRectangle($pen, $cx-[int]($sz/2), $cy-[int]($sz/2), $sz, $sz)
  $g.DrawString("$i", $font, $brush, $cx+8, $cy-8)
  $i++
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
}

function cropPdf(page, outName, pdfX1, pdfY1, pdfX2, pdfY2) {
    const { width: W, height: H } = load(page);
    const a = toPix(W, H, pdfX1, pdfY1);
    const b = toPix(W, H, pdfX2, pdfY2);
    const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y); const bot = Math.max(a.y, b.y);
    const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
    const dst = path.join(calib, outName).replace(/\\/g, '/');
    const ps = path.join(os.tmpdir(), `mcrop-${outName}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${src}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$b=$src.Clone($r,$src.PixelFormat)
$b.Save('${dst}',[System.Drawing.Imaging.ImageFormat]::Jpeg)
$b.Dispose();$src.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
}

const person = findBestBoxes(0, 40, 535, 540, 570, { sizes: [14, 15, 16, 17, 18], step: 1, topN: 12 });
const incident = findBestBoxes(0, 55, 310, 520, 420, { sizes: [13, 14, 15, 16], step: 1, topN: 30 });
const processBoxes = findBestBoxes(1, 360, 590, 520, 670, { sizes: [14, 15, 16, 17], step: 1, topN: 20 });
const acts = findBestBoxes(1, 55, 90, 110, 400, { sizes: [13, 14, 15, 16], step: 1, topN: 25 });
const conds = findBestBoxes(1, 300, 90, 360, 400, { sizes: [13, 14, 15, 16], step: 1, topN: 25 });
const events = findBestBoxes(1, 90, 430, 490, 535, { sizes: [13, 14, 15, 16], step: 1, topN: 25 });
const ca = findBestBoxes(3, 50, 450, 400, 660, { sizes: [13, 14, 15, 16], step: 1, topN: 30 });
const docs = findBestBoxes(4, 80, 430, 530, 600, { sizes: [13, 14, 15, 16], step: 1, topN: 40 });
const ampm = findBestBoxes(0, 485, 510, 545, 640, { sizes: [10, 11, 12, 13, 14], step: 1, topN: 12 });

const out = { person, incident, process: processBoxes, acts, conds, events, ca, docs, ampm };
fs.writeFileSync(path.join(calib, 'measure-boxes.json'), JSON.stringify(out, null, 2));

markBoxes(0, person, 'meas-person.jpg');
markBoxes(0, incident, 'meas-incident.jpg');
markBoxes(1, processBoxes, 'meas-process.jpg');
markBoxes(1, acts, 'meas-acts.jpg');
markBoxes(1, conds, 'meas-conds.jpg');
markBoxes(3, ca, 'meas-ca.jpg');
markBoxes(4, docs, 'meas-docs.jpg');
markBoxes(0, ampm, 'meas-ampm.jpg');

cropPdf(0, 'meas-person-crop.jpg', 40, 530, 540, 575);
cropPdf(0, 'meas-incident-crop.jpg', 50, 300, 530, 430);
cropPdf(1, 'meas-process-crop.jpg', 350, 580, 530, 680);
cropPdf(1, 'meas-acts-crop.jpg', 50, 90, 360, 420);

console.log('PERSON', person.map((b) => `${b.x},${b.y} s${b.size} sc${b.score}`).join(' | '));
console.log('AMPM', ampm.map((b) => `${b.x},${b.y} s${b.size}`).join(' | '));
console.log('INC', incident.slice(0, 20).map((b) => `${b.x},${b.y}`).join(' | '));
console.log('PROC', processBoxes.map((b) => `${b.x},${b.y}`).join(' | '));
console.log('ACTS n', acts.length, acts[0], acts[acts.length - 1]);
console.log('CONDS n', conds.length, conds[0]);
console.log('CA n', ca.length, ca.slice(0, 6));
console.log('DOCS n', docs.length, docs.slice(0, 12));
