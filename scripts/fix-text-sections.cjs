'use strict';

/**
 * Measure ruling lines + checkbox columns for the still-misaligned sections:
 * header texts, event types, root causes, immediate/root link tables, action log.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');
const { createCanvas, loadImage } = require('canvas');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { buildInvestigationPdf } = require('../src/lib/incident-investigation-pdf.cjs');
const {
    EVENT_TYPES, ROOT_PERSONAL, ROOT_JOB,
} = require('../src/lib/incident-investigation-catalog.cjs');

const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612;
const Hpdf = 792;
const std = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}/`;

function loadPage(page) {
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

/** Darkest horizontal ruling in a band; return PDF y just above the ink. */
function findLineY(page, pdfX, pdfYGuess, pdfW = 200, search = 18) {
    const { width: W, height: H, data } = loadPage(page);
    const gray = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 255;
        return data[(y * W + x) * 4];
    };
    const start = toPix(W, H, pdfX, pdfYGuess);
    const x1 = Math.min(W - 1, start.x + Math.round((pdfW * W) / Wpdf));
    const y0 = Math.max(0, start.y - Math.round((search * H) / Hpdf));
    const y1 = Math.min(H - 1, start.y + Math.round((search * H) / Hpdf));
    let bestY = start.y;
    let best = 0;
    for (let y = y0; y <= y1; y += 1) {
        let dark = 0;
        let n = 0;
        for (let x = start.x; x <= x1; x += 2) {
            n += 1;
            if (gray(x, y) < 130) dark += 1;
        }
        const sc = dark / Math.max(n, 1);
        if (sc > best) {
            best = sc;
            bestY = y;
        }
    }
    // Baseline ~3px above ink line in image space
    return { y: toPdf(W, H, start.x, bestY - 3).y, score: +best.toFixed(3), inkY: toPdf(W, H, start.x, bestY).y };
}

function scoreBox(gray, W, H, x, y, size) {
    const g = (xx, yy) => {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) return 255;
        return gray[yy * W + xx];
    };
    let edge = 0;
    let edgeN = 0;
    let light = 0;
    let dark = 0;
    let n = 0;
    for (let i = 0; i < size; i += 1) {
        edgeN += 4;
        if (g(x + i, y) < 110) edge += 1;
        if (g(x + i, y + size - 1) < 110) edge += 1;
        if (g(x, y + i) < 110) edge += 1;
        if (g(x + size - 1, y + i) < 110) edge += 1;
    }
    const pad = Math.max(2, Math.floor(size * 0.28));
    for (let iy = pad; iy < size - pad; iy += 1) {
        for (let ix = pad; ix < size - pad; ix += 1) {
            n += 1;
            const v = g(x + ix, y + iy);
            if (v > 175) light += 1;
            if (v < 130) dark += 1;
        }
    }
    const er = edge / edgeN;
    const lr = light / Math.max(n, 1);
    const dr = dark / Math.max(n, 1);
    if (er < 0.65 || lr < 0.55 || dr > 0.25) return 0;
    return er * 0.5 + lr * 0.5 - dr;
}

function findBoxes(page, pdfX1, pdfY1, pdfX2, pdfY2, { sizes = [14, 15, 16, 17, 18], step = 1, topN = 40 } = {}) {
    const { width: W, height: H, data } = loadPage(page);
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
                if (s < 0.75) continue;
                const cx = x + Math.floor(size / 2);
                const cy = y + Math.floor(size / 2);
                scored.push({ score: +s.toFixed(3), size, ...toPdf(W, H, cx, cy) });
            }
        }
    }
    scored.sort((a, b) => b.score - a.score);
    const dedup = [];
    for (const b of scored) {
        if (dedup.some((d) => Math.abs(d.x - b.x) < 3 && Math.abs(d.y - b.y) < 3)) continue;
        dedup.push(b);
        if (dedup.length >= topN) break;
    }
    return dedup;
}

function findTableRowYs(page, pdfX, pdfYTop, pdfYBot, pdfW = 400) {
    const { width: W, height: H, data } = loadPage(page);
    const gray = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 255;
        return data[(y * W + x) * 4];
    };
    const x0 = toPix(W, H, pdfX, 0).x;
    const x1 = Math.min(W - 1, x0 + Math.round((pdfW * W) / Wpdf));
    const yTop = toPix(W, H, 0, pdfYTop).y;
    const yBot = toPix(W, H, 0, pdfYBot).y;
    const top = Math.min(yTop, yBot);
    const bot = Math.max(yTop, yBot);
    const rows = [];
    for (let y = top; y <= bot; y += 1) {
        let dark = 0;
        let n = 0;
        for (let x = x0; x <= x1; x += 2) {
            n += 1;
            if (gray(x, y) < 120) dark += 1;
        }
        if (dark / Math.max(n, 1) > 0.45) rows.push(y);
    }
    // Collapse contiguous ink into single line centers
    const lines = [];
    let run = null;
    for (const y of rows) {
        if (!run) run = [y, y];
        else if (y === run[1] + 1) run[1] = y;
        else {
            lines.push(Math.round((run[0] + run[1]) / 2));
            run = [y, y];
        }
    }
    if (run) lines.push(Math.round((run[0] + run[1]) / 2));
    return lines.map((y) => toPdf(W, H, x0, y - 3).y);
}

async function renderCrops() {
    const inv = {
        incident_number: 'INC-2026-001',
        report_date: '18-07-26',
        report_time: '2:30',
        report_ampm: 'PM',
        retail_name: 'TGP Demo Store',
        person_involved: 'Jane Sample',
        person_types: { full_time: true },
        incident_date: '17-07-26',
        incident_time: '11:15',
        incident_ampm: 'AM',
        witnesses: [{ name: 'Witness One' }, { name: 'Witness Two' }, { name: 'Witness Three' }],
        payload: {
            descriptionLines: ['Desc 1', 'Desc 2', 'Desc 3', 'Desc 4', 'Desc 5', 'Desc 6', 'Desc 7', 'Desc 8', 'Desc 9', 'Desc 10'],
            eventTypes: Object.fromEntries(EVENT_TYPES.map((e) => [e.key, true])),
            rootPersonal: Object.fromEntries(ROOT_PERSONAL.filter((e) => e.key !== 'other').map((e) => [e.key, true])),
            rootJob: Object.fromEntries(ROOT_JOB.filter((e) => e.key !== 'other').map((e) => [e.key, true])),
            immediateContributions: [
                { idNum: '1', explanation: 'Immediate cause one explanation' },
                { idNum: '2', explanation: 'Immediate cause two' },
                { idNum: '3', explanation: 'Three' },
                { idNum: '4', explanation: 'Four' },
                { idNum: '5', explanation: 'Five' },
            ],
            rootLinks: [
                { idNum: '1', brNum: '2', explanation: 'Root link one' },
                { idNum: '3', brNum: '4', explanation: 'Root link two' },
                { idNum: '5', brNum: '6', explanation: 'Three' },
                { idNum: '7', brNum: '8', explanation: 'Four' },
                { idNum: '9', brNum: '10', explanation: 'Five' },
            ],
            actionLog: [
                { action: 'Corrective action one', person: 'Lead A', dueDate: '01-08-26' },
                { action: 'Corrective action two', person: 'Lead B', dueDate: '02-08-26' },
                { action: 'Action three', person: 'Lead C', dueDate: '03-08-26' },
                { action: 'Action four', person: 'Lead D', dueDate: '04-08-26' },
                { action: 'Action five', person: 'Lead E', dueDate: '05-08-26' },
            ],
        },
        signoffs: {
            lead: { name: 'Lead Name', date: '18-07-26' },
            safety_committee: { name: 'Safety', date: '18-07-26' },
            senior_management: { name: 'Senior', date: '18-07-26' },
        },
    };
    const bytes = await buildInvestigationPdf({ investigation: inv });
    fs.writeFileSync(path.join(calib, 'fix-filled.pdf'), bytes);
    const src = await PDFDocument.load(bytes);
    for (const i of [0, 1, 2, 3]) {
        const d = await PDFDocument.create();
        d.addPage((await d.copyPages(src, [i]))[0]);
        const doc = await pdfjs.getDocument({
            data: await d.save(), disableWorker: true, standardFontDataUrl: std,
        }).promise;
        const page = await doc.getPage(1);
        const vp = page.getViewport({ scale: 2 });
        const canvas = createCanvas(vp.width, vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        fs.writeFileSync(path.join(calib, `fix-real-${i}.png`), canvas.toBuffer('image/png'));
    }
}

function cropPng(srcName, outName, x1, y1, x2, y2) {
    const W = 1224; const H = 1584;
    const toP = (x, y) => ({
        x: Math.round((x * W) / Wpdf),
        y: Math.round(((Hpdf - y) * H) / Hpdf),
    });
    const a = toP(x1, y1); const b = toP(x2, y2);
    const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y); const bot = Math.max(a.y, b.y);
    const src = path.join(calib, srcName).replace(/\\/g, '/');
    const dst = path.join(calib, outName).replace(/\\/g, '/');
    const ps = path.join(os.tmpdir(), `fix-crop-${outName}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${src}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$b=$src.Clone($r,$src.PixelFormat)
$b.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Png)
$b.Dispose();$src.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
}

// --- Measure ---
const header = {
    incident_number: findLineY(0, 145, 682, 280),
    report_date: findLineY(0, 145, 647, 180),
    report_time: findLineY(0, 400, 647, 80),
    retail_name: findLineY(0, 145, 593, 350),
    person_involved: findLineY(0, 200, 571, 300),
    incident_date: findLineY(0, 145, 535, 180),
    incident_time: findLineY(0, 400, 535, 80),
    witness0: findLineY(0, 72, 510, 140),
};

const events = findBoxes(1, 90, 430, 500, 540, { topN: 30 });
const rootsL = findBoxes(2, 55, 300, 120, 480, { topN: 20 });
const rootsR = findBoxes(2, 300, 300, 450, 480, { topN: 20 });
const immRows = findTableRowYs(2, 80, 640, 520, 450);
const rootLinkRows = findTableRowYs(2, 80, 270, 150, 450);
const actionRows = findTableRowYs(3, 70, 240, 100, 480);
const corrLinkRows = findTableRowYs(3, 70, 440, 300, 480);

const out = {
    header,
    events: events.sort((a, b) => b.y - a.y || a.x - b.x),
    rootsL: rootsL.sort((a, b) => b.y - a.y || a.x - b.x),
    rootsR: rootsR.sort((a, b) => b.y - a.y || a.x - b.x),
    immRows,
    rootLinkRows,
    actionRows,
    corrLinkRows,
};
fs.writeFileSync(path.join(calib, 'fix-measure.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

(async () => {
    await renderCrops();
    cropPng('fix-real-0.png', 'fix-p0-head.png', 40, 500, 560, 720);
    cropPng('fix-real-1.png', 'fix-p1-events.png', 60, 420, 540, 550);
    cropPng('fix-real-2.png', 'fix-p2-imm.png', 50, 500, 560, 660);
    cropPng('fix-real-2.png', 'fix-p2-roots.png', 50, 290, 540, 490);
    cropPng('fix-real-2.png', 'fix-p2-links.png', 50, 140, 560, 280);
    cropPng('fix-real-3.png', 'fix-p3-action.png', 50, 90, 560, 250);
    cropPng('fix-real-3.png', 'fix-p3-links.png', 50, 300, 560, 460);
    console.log('crops ready');
})().catch((e) => { console.error(e); process.exit(1); });
