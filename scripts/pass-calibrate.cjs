'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');
const { extractEmbeddedJpegs, pageImageNeeds180 } = require('../src/lib/incident-investigation-pdf.cjs');
const map = require('../src/lib/incident-investigation-pdf-map.cjs');
const { pdfToPix, pixToPdf, cropPdfRect } = require('./lib/calib-crop.cjs');

const root = path.join(__dirname, '..');
const calib = path.join(root, '_calib');
fs.mkdirSync(calib, { recursive: true });

function ensurePages() {
    const need = [0, 1, 2, 3, 4].some((i) => !fs.existsSync(path.join(calib, `page-${i}.jpg`)));
    if (!need) return;
    const jpegs = extractEmbeddedJpegs(fs.readFileSync(path.join(root, 'assets/safety/tgp-incident-investigation-appendix-b.pdf')));
    for (let i = 0; i < 5; i += 1) {
        const raw = path.join(calib, `raw-${i}.jpg`);
        const upright = path.join(calib, `page-${i}.jpg`);
        fs.writeFileSync(raw, jpegs[i]);
        const ps = path.join(os.tmpdir(), `pass-up-${i}.ps1`);
        fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('${raw.replace(/\\/g, '/').replace(/'/g, "''")}')
${pageImageNeeds180(i) ? '$img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone)' : ''}
$img.Save('${upright.replace(/\\/g, '/').replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$img.Dispose()
`);
        execFileSync('powershell', ['-NoProfile', '-File', ps]);
    }
}

function load(page) {
    const decoded = jpeg.decode(fs.readFileSync(path.join(calib, `page-${page}.jpg`)), { useTArray: true });
    return decoded;
}

function toPdf(W, H, x, y) {
    return pixToPdf(W, H, x, y);
}
function toPix(W, H, x, y) {
    return pdfToPix(W, H, x, y);
}

function pageFromSrcName(srcName) {
    const m = srcName.match(/(?:pass-overlay|map-overlay|overlay|page)-(\d+)/);
    return m ? Number(m[1]) : null;
}

function findHollow(page, pdfX1, pdfY1, pdfX2, pdfY2, { minSize = 11, maxSize = 20, step = 1 } = {}) {
    const { width: W, height: H, data } = load(page);
    const gray = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 255;
        return data[(y * W + x) * 4];
    };
    const dark = (x, y) => gray(x, y) < 120;
    const light = (x, y) => gray(x, y) > 160;
    const left = Math.min(toPix(W, H, pdfX1, 0).x, toPix(W, H, pdfX2, 0).x);
    const right = Math.max(toPix(W, H, pdfX1, 0).x, toPix(W, H, pdfX2, 0).x);
    const top = Math.min(toPix(W, H, 0, pdfY1).y, toPix(W, H, 0, pdfY2).y);
    const bot = Math.max(toPix(W, H, 0, pdfY1).y, toPix(W, H, 0, pdfY2).y);
    const found = [];
    for (let size = minSize; size <= maxSize; size += 1) {
        const need = Math.floor(size * 0.7);
        for (let y = top; y <= bot - size; y += step) {
            for (let x = left; x <= right - size; x += step) {
                let t = 0; let b = 0; let l = 0; let r = 0;
                for (let i = 0; i < size; i += 1) {
                    if (dark(x + i, y)) t += 1;
                    if (dark(x + i, y + size - 1)) b += 1;
                    if (dark(x, y + i)) l += 1;
                    if (dark(x + size - 1, y + i)) r += 1;
                }
                if (t < need || b < need || l < need || r < need) continue;
                let inn = 0; let n = 0;
                for (let iy = 3; iy < size - 3; iy += 1) {
                    for (let ix = 3; ix < size - 3; ix += 1) {
                        n += 1;
                        if (light(x + ix, y + iy)) inn += 1;
                    }
                }
                if (n === 0 || inn / n < 0.55) continue;
                const cx = x + Math.floor(size / 2);
                const cy = y + Math.floor(size / 2);
                found.push({ ...toPdf(W, H, cx, cy), size });
            }
        }
    }
    const dedup = [];
    for (const box of found.sort((a, b) => b.y - a.y || a.x - b.x)) {
        if (dedup.some((d) => Math.abs(d.x - box.x) < 2.5 && Math.abs(d.y - box.y) < 2.5)) continue;
        dedup.push(box);
    }
    return dedup;
}

function overlay(page, extras = []) {
    const { width: W, height: H } = load(page);
    const marks = [];
    for (const field of map.checks.filter((c) => c.page === page)) {
        const p = toPix(W, H, field.x, field.y);
        marks.push(`C,${p.x},${p.y}`);
    }
    for (const field of map.texts.filter((t) => t.page === page)) {
        const p = toPix(W, H, field.x, field.y);
        marks.push(`T,${p.x},${p.y}`);
    }
    for (const e of extras) {
        const p = toPix(W, H, e.x, e.y);
        marks.push(`D,${p.x},${p.y}`);
    }
    const marksFile = path.join(calib, `pass-marks-${page}.txt`).replace(/\\/g, '/');
    const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
    const dst = path.join(calib, `pass-overlay-${page}.jpg`).replace(/\\/g, '/');
    fs.writeFileSync(marksFile, marks.join('\n'));
    const ps = path.join(os.tmpdir(), `pass-ov-${page}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$penR = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
$penL = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 2
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::DeepSkyBlue)
foreach ($line in Get-Content '${marksFile}') {
  $p=$line.Split(','); $x=[int]$p[1]; $y=[int]$p[2]
  if ($p[0] -eq 'C') { $g.DrawLine($penR,$x-7,$y-7,$x+7,$y+7); $g.DrawLine($penR,$x-7,$y+7,$x+7,$y-7) }
  elseif ($p[0] -eq 'D') { $g.DrawRectangle($penL,$x-8,$y-8,16,16) }
  else { $g.FillEllipse($brush,$x-4,$y-4,8,8) }
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
    return dst;
}

function crop(srcName, outName, pdfX1, pdfY1, pdfX2, pdfY2, pageArg) {
    const page = pageArg != null ? pageArg : pageFromSrcName(srcName);
    if (page == null) {
        throw new Error(`crop: cannot derive page from ${srcName}; pass page explicitly`);
    }
    const { width: W, height: H } = load(page);
    const { left, top, right, bottom: bot } = cropPdfRect(W, H, pdfX1, pdfY1, pdfX2, pdfY2);
    const src = path.join(calib, srcName).replace(/\\/g, '/');
    const dst = path.join(calib, outName).replace(/\\/g, '/');
    const ps = path.join(os.tmpdir(), `pass-crop-${outName}.ps1`);
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

ensurePages();

const person = findHollow(0, 40, 535, 520, 570, { minSize: 10, maxSize: 18, step: 1 });
const ampm = findHollow(0, 450, 500, 560, 670, { minSize: 8, maxSize: 16, step: 1 });
const docs = findHollow(4, 50, 460, 560, 660, { minSize: 10, maxSize: 18, step: 1 });
const events = findHollow(1, 60, 450, 540, 560, { minSize: 10, maxSize: 16, step: 1 });
const roots = findHollow(2, 60, 300, 520, 500, { minSize: 10, maxSize: 18, step: 1 });

console.log('PERSON', JSON.stringify(person, null, 0));
console.log('AMPM', JSON.stringify(ampm, null, 0));
console.log('DOCS left', JSON.stringify(docs.filter((d) => d.x < 200), null, 0));
console.log('DOCS right', JSON.stringify(docs.filter((d) => d.x > 350 && d.size >= 14), null, 0));
console.log('EVENTS', JSON.stringify(events, null, 0));
console.log('ROOTS L', JSON.stringify(roots.filter((d) => d.x < 200 && d.size >= 14), null, 0));
console.log('ROOTS R', JSON.stringify(roots.filter((d) => d.x > 300 && d.size >= 12).slice(0, 40), null, 0));

fs.writeFileSync(path.join(calib, 'pass-detect.json'), JSON.stringify({ person, ampm, docs, events, roots }, null, 2));

overlay(0, person.concat(ampm));
overlay(1, events);
overlay(4, docs);
crop('pass-overlay-0.jpg', 'pass-p0-type.jpg', 40, 500, 560, 680);
crop('pass-overlay-0.jpg', 'pass-p0-inc.jpg', 40, 300, 560, 520);
crop('pass-overlay-4.jpg', 'pass-p4-docs.jpg', 40, 450, 560, 680);
console.log('overlays ready');
