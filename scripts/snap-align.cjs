'use strict';

/**
 * Snap stamp map checks to detected hollow boxes; nudge text onto ruling lines.
 * Writes suggested coordinates + verification overlays.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractEmbeddedJpegs, pageImageNeeds180 } = require('../src/lib/incident-investigation-pdf.cjs');
const map = require('../src/lib/incident-investigation-pdf-map.cjs');

const root = path.join(__dirname, '..');
const calib = path.join(root, '_calib');
const Wpdf = 612;
const Hpdf = 792;

function ensurePages() {
    const jpegs = extractEmbeddedJpegs(fs.readFileSync(path.join(root, 'assets/safety/tgp-incident-investigation-appendix-b.pdf')));
    for (let i = 0; i < 5; i += 1) {
        const upright = path.join(calib, `page-${i}.jpg`);
        if (fs.existsSync(upright) && fs.statSync(upright).size > 1000) continue;
        const raw = path.join(calib, `raw-${i}.jpg`);
        fs.writeFileSync(raw, jpegs[i]);
        const ps = path.join(os.tmpdir(), `snap-up-${i}.ps1`);
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
    return jpeg.decode(fs.readFileSync(path.join(calib, `page-${page}.jpg`)), { useTArray: true });
}

function toPdf(W, H, x, y) {
    return {
        x: Math.round((x * Wpdf) / W * 10) / 10,
        y: Math.round((Hpdf - (y * Hpdf) / H) * 10) / 10,
    };
}
function toPix(W, H, x, y) {
    return {
        x: Math.round((x * W) / Wpdf),
        y: Math.round(((Hpdf - y) * H) / Hpdf),
    };
}

function findHollow(page, pdfX1, pdfY1, pdfX2, pdfY2, { minSize = 10, maxSize = 14, step = 1 } = {}) {
    const { width: W, height: H, data } = load(page);
    const gray = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 255;
        return data[(y * W + x) * 4];
    };
    const dark = (x, y) => gray(x, y) < 115;
    const light = (x, y) => gray(x, y) > 165;
    const left = Math.min(toPix(W, H, pdfX1, 0).x, toPix(W, H, pdfX2, 0).x);
    const right = Math.max(toPix(W, H, pdfX1, 0).x, toPix(W, H, pdfX2, 0).x);
    const top = Math.min(toPix(W, H, 0, pdfY1).y, toPix(W, H, 0, pdfY2).y);
    const bot = Math.max(toPix(W, H, 0, pdfY1).y, toPix(W, H, 0, pdfY2).y);
    const found = [];
    for (let size = minSize; size <= maxSize; size += 1) {
        const need = Math.floor(size * 0.72);
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
                if (n === 0 || inn / n < 0.6) continue;
                const cx = x + Math.floor(size / 2);
                const cy = y + Math.floor(size / 2);
                found.push({ ...toPdf(W, H, cx, cy), size, cx, cy });
            }
        }
    }
    const dedup = [];
    for (const box of found.sort((a, b) => b.y - a.y || a.x - b.x)) {
        if (dedup.some((d) => Math.abs(d.x - box.x) < 2.2 && Math.abs(d.y - box.y) < 2.2)) continue;
        dedup.push(box);
    }
    return dedup;
}

/** Find darkest horizontal ruling near a text baseline (search downward in image = lower PDF y). */
function snapTextToLine(page, field, searchDownPdf = 14) {
    const { width: W, height: H, data } = load(page);
    const gray = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 255;
        return data[(y * W + x) * 4];
    };
    const start = toPix(W, H, field.x, field.y);
    const x0 = Math.max(0, start.x);
    const x1 = Math.min(W - 1, start.x + Math.round(((field.maxWidth || 80) * W) / Wpdf));
    const yStart = start.y;
    const yEnd = Math.min(H - 1, start.y + Math.round((searchDownPdf * H) / Hpdf));
    let bestY = null;
    let bestScore = 0;
    for (let y = yStart; y <= yEnd; y += 1) {
        let dark = 0;
        let n = 0;
        for (let x = x0; x <= x1; x += 2) {
            n += 1;
            if (gray(x, y) < 140) dark += 1;
        }
        const score = dark / Math.max(n, 1);
        if (score > bestScore && score > 0.35) {
            bestScore = score;
            bestY = y;
        }
    }
    if (bestY == null) return null;
    // Baseline sits ~2–3px above the ink line in image space.
    const baselinePix = bestY - 3;
    return toPdf(W, H, start.x, baselinePix).y;
}

function nearest(boxes, x, y, maxDist = 22) {
    let best = null;
    let bestD = maxDist;
    for (const b of boxes) {
        const d = Math.hypot(b.x - x, b.y - y);
        if (d < bestD) {
            bestD = d;
            best = b;
        }
    }
    return best ? { box: best, dist: bestD } : null;
}

function pickColumn(boxes, targetX, tol = 18) {
    return boxes.filter((b) => Math.abs(b.x - targetX) <= tol).sort((a, b) => b.y - a.y);
}

async function glyphOffset() {
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const size = 12;
    const w = bold.widthOfTextAtSize('X', size);
    return { w, size };
}

function overlay(page, checks, texts, label) {
    const { width: W, height: H } = load(page);
    const marks = [];
    for (const c of checks.filter((f) => f.page === page)) {
        const p = toPix(W, H, c.x, c.y);
        marks.push(`C,${p.x},${p.y}`);
    }
    for (const t of texts.filter((f) => f.page === page)) {
        const p = toPix(W, H, t.x, t.y);
        marks.push(`T,${p.x},${p.y}`);
    }
    const marksFile = path.join(calib, `snap-marks-${page}.txt`).replace(/\\/g, '/');
    const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
    const dst = path.join(calib, `${label}-${page}.jpg`).replace(/\\/g, '/');
    fs.writeFileSync(marksFile, marks.join('\n'));
    const ps = path.join(os.tmpdir(), `snap-ov-${page}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$penR = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::DeepSkyBlue)
foreach ($line in Get-Content '${marksFile}') {
  $p=$line.Split(','); $x=[int]$p[1]; $y=[int]$p[2]
  if ($p[0] -eq 'C') { $g.DrawLine($penR,$x-8,$y-8,$x+8,$y+8); $g.DrawLine($penR,$x-8,$y+8,$x+8,$y-8) }
  else { $g.FillEllipse($brush,$x-4,$y-4,8,8) }
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
}

function crop(srcName, outName, page, pdfX1, pdfY1, pdfX2, pdfY2) {
    const { width: W, height: H } = load(page);
    const a = toPix(W, H, pdfX1, pdfY1);
    const b = toPix(W, H, pdfX2, pdfY2);
    const left = Math.min(a.x, b.x);
    const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const bot = Math.max(a.y, b.y);
    const src = path.join(calib, srcName).replace(/\\/g, '/');
    const dst = path.join(calib, outName).replace(/\\/g, '/');
    const ps = path.join(os.tmpdir(), `snap-crop-${outName}.ps1`);
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

// --- Detect regions ---
const personBoxes = findHollow(0, 50, 540, 540, 565, { minSize: 10, maxSize: 13, step: 1 })
    .filter((b) => b.size <= 12)
    .sort((a, b) => a.x - b.x);
const ampmBoxes = findHollow(0, 480, 510, 545, 640, { minSize: 9, maxSize: 13, step: 1 });
const incidentBoxes = findHollow(0, 55, 310, 520, 420, { minSize: 10, maxSize: 13, step: 1 })
    .filter((b) => b.size <= 12);
const processBoxes = findHollow(1, 370, 590, 510, 670, { minSize: 10, maxSize: 13, step: 1 });
const eventBoxes = findHollow(1, 90, 430, 480, 535, { minSize: 10, maxSize: 13, step: 1 });
const actBoxes = findHollow(1, 55, 90, 100, 400, { minSize: 10, maxSize: 13, step: 1 });
const condBoxes = findHollow(1, 300, 90, 360, 400, { minSize: 10, maxSize: 13, step: 1 });
const rootL = findHollow(2, 55, 300, 120, 480, { minSize: 10, maxSize: 13, step: 1 });
const rootR = findHollow(2, 300, 300, 430, 480, { minSize: 10, maxSize: 13, step: 1 });
const caL = findHollow(3, 55, 460, 120, 660, { minSize: 10, maxSize: 13, step: 1 });
const caR = findHollow(3, 300, 460, 380, 660, { minSize: 10, maxSize: 13, step: 1 });
const docBoxes = findHollow(4, 80, 430, 520, 600, { minSize: 10, maxSize: 13, step: 1 });

// Person types: 4 leftmost clean boxes spaced across the row
const personRow = personBoxes.filter((b) => b.y > 545 && b.y < 558);
// Prefer boxes near expected label starts
const personPicks = [];
for (const target of [80, 185, 320, 430]) {
    const hit = nearest(personRow, target, 551, 30);
    if (hit) personPicks.push(hit.box);
}

const amReport = ampmBoxes.filter((b) => b.y > 615 && b.y < 635 && b.size >= 10).sort((a, b) => a.x - b.x);
const amInc = ampmBoxes.filter((b) => b.y > 515 && b.y < 535 && b.size >= 10).sort((a, b) => a.x - b.x);

// Incident type grid: cluster into 3 columns
const incCols = [[], [], []];
for (const b of incidentBoxes) {
    if (b.x < 150) incCols[0].push(b);
    else if (b.x < 320) incCols[1].push(b);
    else incCols[2].push(b);
}
for (const col of incCols) col.sort((a, b) => b.y - a.y);

const suggestions = {
    person_types: personPicks.map((b, i) => ({ i, x: b.x, y: b.y, size: b.size })),
    report_ampm: amReport.slice(0, 2),
    incident_ampm: amInc.slice(0, 2),
    incidentCols: incCols.map((c) => c.slice(0, 5).map((b) => ({ x: b.x, y: b.y }))),
    process: processBoxes.sort((a, b) => b.y - a.y || a.x - b.x).slice(0, 20),
    events: eventBoxes.sort((a, b) => b.y - a.y || a.x - b.x).slice(0, 30),
    acts: pickColumn(actBoxes, 74, 20).slice(0, 22),
    conds: pickColumn(condBoxes, 325, 25).slice(0, 22),
    rootsL: pickColumn(rootL, 75, 25).slice(0, 12),
    rootsR: pickColumn(rootR, 400, 40).slice(0, 12),
    caL: pickColumn(caL, 74, 25).slice(0, 12),
    caR: pickColumn(caR, 334, 30).slice(0, 12),
    docs: docBoxes.sort((a, b) => b.y - a.y || a.x - b.x).slice(0, 40),
};

// Snap every mapped check to nearest region box
const allRegionBoxes = {
    0: [...personRow, ...ampmBoxes, ...incidentBoxes],
    1: [...processBoxes, ...eventBoxes, ...actBoxes, ...condBoxes],
    2: [...rootL, ...rootR],
    3: [...caL, ...caR],
    4: [...docBoxes],
};

const snappedChecks = map.checks.map((field) => {
    const boxes = allRegionBoxes[field.page] || [];
    const hit = nearest(boxes, field.x, field.y, 28);
    if (!hit) return { ...field, snapped: false };
    return {
        ...field,
        x: hit.box.x,
        y: hit.box.y,
        snapped: true,
        dist: +hit.dist.toFixed(1),
        oldX: field.x,
        oldY: field.y,
    };
});

const snappedTexts = map.texts.map((field) => {
    const y = snapTextToLine(field.page, field, 16);
    if (y == null) return { ...field, snapped: false };
    // Only accept small nudges (avoid snapping to wrong lines)
    if (Math.abs(y - field.y) > 12) return { ...field, snapped: false };
    return { ...field, y: +y.toFixed(1), snapped: true, oldY: field.y, dy: +(y - field.y).toFixed(1) };
});

fs.writeFileSync(path.join(calib, 'snap-suggestions.json'), JSON.stringify({
    suggestions,
    checkSnaps: snappedChecks.filter((c) => c.snapped).map((c) => ({
        key: c.key, page: c.page, equals: c.equals,
        from: [c.oldX, c.oldY], to: [c.x, c.y], dist: c.dist,
    })),
    textSnaps: snappedTexts.filter((t) => t.snapped).map((t) => ({
        key: t.key, page: t.page, from: t.oldY, to: t.y, dy: t.dy,
    })),
    unsappedChecks: snappedChecks.filter((c) => !c.snapped).map((c) => ({ key: c.key, page: c.page, x: c.x, y: c.y })),
}, null, 2));

console.log('PERSON picks', suggestions.person_types);
console.log('AMPM report', suggestions.report_ampm);
console.log('AMPM incident', suggestions.incident_ampm);
console.log('INC col0', suggestions.incidentCols[0]);
console.log('INC col1', suggestions.incidentCols[1]);
console.log('INC col2', suggestions.incidentCols[2]);
console.log('PROCESS sample', suggestions.process.slice(0, 12));
console.log('ACTS first/last', suggestions.acts[0], suggestions.acts[suggestions.acts.length - 1], 'n=', suggestions.acts.length);
console.log('CONDS n=', suggestions.conds.length, suggestions.conds[0], suggestions.conds[suggestions.conds.length - 1]);
console.log('CA L/R n=', suggestions.caL.length, suggestions.caR.length, suggestions.caL[0], suggestions.caR[0]);
console.log('DOCS sample', suggestions.docs.slice(0, 16));
console.log('snapped checks', snappedChecks.filter((c) => c.snapped).length, '/', snappedChecks.length);
console.log('snapped texts', snappedTexts.filter((t) => t.snapped).length, '/', snappedTexts.length);

overlay(0, snappedChecks, snappedTexts, 'snap-overlay');
overlay(1, snappedChecks, snappedTexts, 'snap-overlay');
overlay(2, snappedChecks, snappedTexts, 'snap-overlay');
overlay(3, snappedChecks, snappedTexts, 'snap-overlay');
overlay(4, snappedChecks, snappedTexts, 'snap-overlay');
crop('snap-overlay-0.jpg', 'snap-p0-head.jpg', 0, 40, 500, 560, 700);
crop('snap-overlay-0.jpg', 'snap-p0-types.jpg', 0, 40, 300, 560, 520);
crop('snap-overlay-1.jpg', 'snap-p1-proc.jpg', 1, 350, 580, 530, 680);
crop('snap-overlay-1.jpg', 'snap-p1-acts.jpg', 1, 50, 80, 380, 420);
crop('snap-overlay-3.jpg', 'snap-p3-ca.jpg', 3, 50, 450, 400, 670);
crop('snap-overlay-4.jpg', 'snap-p4-docs.jpg', 4, 70, 430, 530, 610);
console.log('done — see _calib/snap-suggestions.json and snap-*.jpg');
