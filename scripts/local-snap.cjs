'use strict';

/**
 * For each mapped check, search a small window for the best empty square.
 * Update incident-investigation-pdf-map.cjs constants from results.
 * Render a filled sample PDF and rasterize page crops for verification.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { buildInvestigationPdf, extractEmbeddedJpegs, pageImageNeeds180 } = require('../src/lib/incident-investigation-pdf.cjs');
const map = require('../src/lib/incident-investigation-pdf-map.cjs');

const root = path.join(__dirname, '..');
const calib = path.join(root, '_calib');
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

function scoreAt(gray, W, H, x, y, size) {
    const g = (xx, yy) => {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) return 255;
        return gray[yy * W + xx];
    };
    let edge = 0; let edgeN = 0;
    for (let i = 0; i < size; i += 1) {
        edgeN += 4;
        if (g(x + i, y) < 110) edge += 1;
        if (g(x + i, y + size - 1) < 110) edge += 1;
        if (g(x, y + i) < 110) edge += 1;
        if (g(x + size - 1, y + i) < 110) edge += 1;
    }
    const pad = Math.max(2, Math.floor(size * 0.28));
    let light = 0; let dark = 0; let n = 0;
    for (let iy = pad; iy < size - pad; iy += 1) {
        for (let ix = pad; ix < size - pad; ix += 1) {
            n += 1;
            const v = g(x + ix, y + iy);
            if (v > 175) light += 1;
            if (v < 130) dark += 1;
        }
    }
    const edgeR = edge / edgeN;
    const lightR = light / Math.max(n, 1);
    const darkR = dark / Math.max(n, 1);
    if (edgeR < 0.65 || lightR < 0.55 || darkR > 0.25) return 0;
    return edgeR * 0.5 + lightR * 0.5 - darkR;
}

function localBest(page, pdfX, pdfY, { radius = 10, sizes = [13, 14, 15, 16, 17] } = {}) {
    const { width: W, height: H, data } = load(page);
    const gray = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 1) gray[i] = data[i * 4];
    const c = toPix(W, H, pdfX, pdfY);
    const r = Math.round((radius * W) / Wpdf);
    let best = null;
    for (const size of sizes) {
        for (let y = c.y - r; y <= c.y + r; y += 1) {
            for (let x = c.x - r; x <= c.x + r; x += 1) {
                const s = scoreAt(gray, W, H, x - Math.floor(size / 2), y - Math.floor(size / 2), size);
                if (s <= 0) continue;
                if (!best || s > best.score) {
                    best = { score: s, size, ...toPdf(W, H, x, y) };
                }
            }
        }
    }
    return best;
}

function snapText(page, field) {
    const { width: W, height: H, data } = load(page);
    const gray = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 255;
        return data[(y * W + x) * 4];
    };
    const start = toPix(W, H, field.x, field.y);
    const x1 = Math.min(W - 1, start.x + Math.round(((field.maxWidth || 100) * W) / Wpdf));
    const yEnd = Math.min(H - 1, start.y + Math.round((14 * H) / Hpdf));
    let bestY = null; let best = 0;
    for (let y = start.y; y <= yEnd; y += 1) {
        let dark = 0; let n = 0;
        for (let x = start.x; x <= x1; x += 2) {
            n += 1;
            if (gray(x, y) < 135) dark += 1;
        }
        const sc = dark / Math.max(n, 1);
        if (sc > best && sc > 0.4) { best = sc; bestY = y; }
    }
    if (bestY == null) return field.y;
    const y = toPdf(W, H, start.x, bestY - 2).y;
    if (Math.abs(y - field.y) > 10) return field.y;
    return +y.toFixed(1);
}

// --- Snap all checks ---
const checkResults = map.checks.map((field) => {
    // AM/PM circles are smaller / rounder — allow smaller sizes
    const isAmpm = field.key.includes('ampm');
    const best = localBest(field.page, field.x, field.y, {
        radius: isAmpm ? 8 : 12,
        sizes: isAmpm ? [10, 11, 12, 13, 14] : [13, 14, 15, 16, 17, 18],
    });
    if (!best || best.score < 0.7) {
        return { ...field, ok: false, dx: 0, dy: 0 };
    }
    return {
        ...field,
        ok: true,
        oldX: field.x,
        oldY: field.y,
        x: best.x,
        y: best.y,
        score: +best.score.toFixed(3),
        size: best.size,
        dx: +(best.x - field.x).toFixed(1),
        dy: +(best.y - field.y).toFixed(1),
    };
});

const textResults = map.texts.map((field) => {
    const y = snapText(field.page, field);
    return { ...field, oldY: field.y, y, dy: +(y - field.y).toFixed(1), ok: y !== field.y };
});

fs.writeFileSync(path.join(calib, 'local-snap.json'), JSON.stringify({
    checks: checkResults.map((c) => ({
        key: c.key, page: c.page, equals: c.equals, ok: c.ok,
        from: [c.oldX ?? c.x, c.oldY ?? c.y], to: [c.x, c.y], dx: c.dx, dy: c.dy, score: c.score, size: c.size,
    })),
    texts: textResults.filter((t) => t.ok).map((t) => ({ key: t.key, page: t.page, from: t.oldY, to: t.y, dy: t.dy })),
}, null, 2));

const ok = checkResults.filter((c) => c.ok);
console.log(`snapped ${ok.length}/${checkResults.length} checks`);
console.log('biggest moves:', ok.sort((a, b) => Math.hypot(b.dx, b.dy) - Math.hypot(a.dx, a.dy)).slice(0, 25).map((c) => `${c.key}@${c.page} (${c.oldX},${c.oldY})→(${c.x},${c.y}) d=${c.dx},${c.dy}`).join('\n'));
console.log('failed:', checkResults.filter((c) => !c.ok).map((c) => `${c.key}@${c.page} (${c.x},${c.y})`).join(' | '));

// Derive column constants from snapped groups
function colStats(pred) {
    const rows = checkResults.filter((c) => c.ok && pred(c));
    if (!rows.length) return null;
    const xs = rows.map((c) => c.x);
    const ys = rows.map((c) => c.y).sort((a, b) => b - a);
    const gaps = [];
    for (let i = 1; i < ys.length; i += 1) gaps.push(ys[i - 1] - ys[i]);
    const median = (arr) => {
        const a = [...arr].sort((x, y) => x - y);
        return a[Math.floor(a.length / 2)];
    };
    return {
        x: +median(xs).toFixed(1),
        startY: +ys[0].toFixed(1),
        rowH: gaps.length ? +median(gaps).toFixed(2) : null,
        n: rows.length,
        ys,
        sample: rows.slice(0, 3),
    };
}

const stats = {
    person: checkResults.filter((c) => c.key.startsWith('person_types') && c.ok),
    processYes: colStats((c) => c.key.includes('process.') && c.equals === 'yes'),
    processNo: colStats((c) => c.key.includes('process.') && c.equals === 'no'),
    processNa: colStats((c) => c.key.includes('process.') && c.equals === 'na'),
    acts: colStats((c) => c.key.includes('substandardActs.')),
    conds: colStats((c) => c.key.includes('substandardConditions.')),
    rootsP: colStats((c) => c.key.includes('rootPersonal.') && c.key !== 'payload.rootPersonal.other'),
    rootsJ: colStats((c) => c.key.includes('rootJob.') && c.key !== 'payload.rootJob.other'),
    caL: colStats((c) => c.key.includes('correctiveAreas.') && c.x < 200),
    caR: colStats((c) => c.key.includes('correctiveAreas.') && c.x >= 200),
    docsUtilY: colStats((c) => c.key.includes('supportingDocs.') && c.key.includes('utilized') && c.equals === 'yes'),
    docsUtilN: colStats((c) => c.key.includes('supportingDocs.') && c.key.includes('utilized') && c.equals === 'no'),
    docsCopyY: colStats((c) => c.key.includes('supportingDocs.') && c.key.includes('copyAttached') && c.equals === 'yes'),
    docsCopyN: colStats((c) => c.key.includes('supportingDocs.') && c.key.includes('copyAttached') && c.equals === 'no'),
    incident: checkResults.filter((c) => c.key.includes('incidentTypes.') && c.ok),
};
fs.writeFileSync(path.join(calib, 'local-snap-stats.json'), JSON.stringify(stats, null, 2));
console.log('STATS', JSON.stringify({
    person: stats.person.map((p) => ({ key: p.key, x: p.x, y: p.y })),
    process: { yes: stats.processYes, no: stats.processNo, na: stats.processNa },
    acts: stats.acts, conds: stats.conds,
    caL: stats.caL, caR: stats.caR,
    docs: { uy: stats.docsUtilY, un: stats.docsUtilN, cy: stats.docsCopyY, cn: stats.docsCopyN },
    incidentSample: stats.incident.slice(0, 15).map((i) => ({ key: i.key, x: i.x, y: i.y })),
}, null, 2));

// Overlay with ACTUAL glyph offsets
async function overlayGlyph(page, checks, texts) {
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const { width: W, height: H } = load(page);
    const marks = [];
    for (const field of checks.filter((c) => c.page === page)) {
        const size = field.size || 12;
        const gw = bold.widthOfTextAtSize('X', size);
        const pdfX = field.x - (gw / 2) + 0.5;
        const pdfY = field.y - (size * 0.22);
        const p = toPix(W, H, pdfX, pdfY);
        const c = toPix(W, H, field.x, field.y);
        marks.push(`X,${p.x},${p.y}`);
        marks.push(`C,${c.x},${c.y}`);
    }
    for (const field of texts.filter((t) => t.page === page)) {
        const p = toPix(W, H, field.x, field.y);
        marks.push(`T,${p.x},${p.y}`);
    }
    const mf = path.join(calib, `local-marks-${page}.txt`).replace(/\\/g, '/');
    fs.writeFileSync(mf, marks.join('\n'));
    const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
    const dst = path.join(calib, `local-overlay-${page}.jpg`).replace(/\\/g, '/');
    const ps = path.join(os.tmpdir(), `local-ov-${page}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$penR = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
$penG = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 1
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::DeepSkyBlue)
foreach ($line in Get-Content '${mf}') {
  $p=$line.Split(','); $x=[int]$p[1]; $y=[int]$p[2]
  if ($p[0] -eq 'X') { $g.DrawLine($penR,$x-7,$y-7,$x+7,$y+7); $g.DrawLine($penR,$x-7,$y+7,$x+7,$y-7) }
  elseif ($p[0] -eq 'C') { $g.DrawEllipse($penG,$x-3,$y-3,6,6) }
  else { $g.FillEllipse($brush,$x-3,$y-3,6,6) }
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
}

(async () => {
    await overlayGlyph(0, checkResults, textResults);
    await overlayGlyph(1, checkResults, textResults);
    await overlayGlyph(3, checkResults, textResults);
    await overlayGlyph(4, checkResults, textResults);
    // crops
    for (const [src, out, page, box] of [
        ['local-overlay-0.jpg', 'local-p0-head.jpg', 0, [40, 500, 560, 700]],
        ['local-overlay-0.jpg', 'local-p0-inc.jpg', 0, [50, 300, 540, 430]],
        ['local-overlay-1.jpg', 'local-p1-proc.jpg', 1, [350, 580, 530, 680]],
        ['local-overlay-1.jpg', 'local-p1-acts.jpg', 1, [50, 90, 380, 420]],
        ['local-overlay-4.jpg', 'local-p4-docs.jpg', 4, [70, 430, 530, 610]],
    ]) {
        const { width: W, height: H } = load(page);
        const a = toPix(W, H, box[0], box[1]);
        const b = toPix(W, H, box[2], box[3]);
        const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
        const top = Math.min(a.y, b.y); const bot = Math.max(a.y, b.y);
        const ps = path.join(os.tmpdir(), `lcrop-${out}.ps1`);
        fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${path.join(calib, src).replace(/\\/g, '/')}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$b=$src.Clone($r,$src.PixelFormat)
$b.Save('${path.join(calib, out).replace(/\\/g, '/')}',[System.Drawing.Imaging.ImageFormat]::Jpeg)
$b.Dispose();$src.Dispose()
`);
        execFileSync('powershell', ['-NoProfile', '-File', ps]);
    }
    console.log('overlays ready');
})();
