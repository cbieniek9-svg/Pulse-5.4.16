'use strict';

/**
 * One more alignment pass:
 * 1) Detect content bounds of upright page images (letterbox / margins)
 * 2) Overlay ACTUAL stamp positions (same glyph offsets as pdf-lib)
 * 3) Write cropped verify images for key regions
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { extractEmbeddedJpegs, pageImageNeeds180, buildInvestigationPdf } = require('../src/lib/incident-investigation-pdf.cjs');
const map = require('../src/lib/incident-investigation-pdf-map.cjs');

const root = path.join(__dirname, '..');
const calib = path.join(root, '_calib');
fs.mkdirSync(calib, { recursive: true });
const Wpdf = 612; const Hpdf = 792;

function ensurePages() {
    const jpegs = extractEmbeddedJpegs(fs.readFileSync(path.join(root, 'assets/safety/tgp-incident-investigation-appendix-b.pdf')));
    for (let i = 0; i < 5; i += 1) {
        const upright = path.join(calib, `page-${i}.jpg`);
        if (fs.existsSync(upright) && fs.statSync(upright).size > 1000) continue;
        const raw = path.join(calib, `raw-${i}.jpg`);
        fs.writeFileSync(raw, jpegs[i]);
        const ps = path.join(os.tmpdir(), `align-up-${i}.ps1`);
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

function contentBounds(page) {
    const { width: W, height: H, data } = jpeg.decode(fs.readFileSync(path.join(calib, `page-${page}.jpg`)), { useTArray: true });
    const dark = (x, y) => data[(y * W + x) * 4] < 200;
    let minX = W; let maxX = 0; let minY = H; let maxY = 0;
    for (let y = 0; y < H; y += 2) {
        for (let x = 0; x < W; x += 2) {
            if (!dark(x, y)) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    return {
        W, H, minX, maxX, minY, maxY,
        // Map content pixel → PDF assuming content fills the letter page.
        // If margins exist, linear map content box → full page.
        contentW: maxX - minX + 1,
        contentH: maxY - minY + 1,
    };
}

async function glyphMetrics() {
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const regular = await pdf.embedFont(StandardFonts.Helvetica);
    return { bold, regular };
}

function overlayActual(page, bounds, fonts) {
    const W = bounds.W; const H = bounds.H;
    // If we stretch full JPEG to page, pdf→pix is simple. Also compute content-aware mapping.
    const simple = (x, y) => ({
        x: Math.round((x * W) / Wpdf),
        y: Math.round(((Hpdf - y) * H) / Hpdf),
    });
    const contentAware = (x, y) => {
        // Map PDF coords onto the ink bounding box (removes letterboxing skew).
        const px = bounds.minX + (x / Wpdf) * bounds.contentW;
        const py = bounds.minY + ((Hpdf - y) / Hpdf) * bounds.contentH;
        return { x: Math.round(px), y: Math.round(py) };
    };
    // Use content-aware for overlay preview of "corrected" mapping
    const toPix = contentAware;

    const marks = [];
    for (const field of map.checks.filter((c) => c.page === page)) {
        const size = field.size || 12;
        const glyphWidth = fonts.bold.widthOfTextAtSize('X', size);
        // Same offsets as stampTextAndChecks
        const pdfX = field.x - (glyphWidth / 2) + 0.5;
        const pdfY = field.y - (size * 0.28);
        const p = toPix(pdfX, pdfY);
        // Also mark intended center
        const c = toPix(field.x, field.y);
        marks.push(`X,${p.x},${p.y}`);
        marks.push(`C,${c.x},${c.y}`);
    }
    for (const field of map.texts.filter((t) => t.page === page)) {
        const p = toPix(field.x, field.y);
        marks.push(`T,${p.x},${p.y}`);
    }
    // Compare simple vs content for a few anchors
    const aS = simple(80, 551); const aC = contentAware(80, 551);
    console.log(`page ${page} bounds`, {
        minX: bounds.minX, maxX: bounds.maxX, minY: bounds.minY, maxY: bounds.maxY,
        marginL: bounds.minX, marginR: W - 1 - bounds.maxX,
        marginT: bounds.minY, marginB: H - 1 - bounds.maxY,
        deltaAtPerson: { simple: aS, content: aC, dX: aC.x - aS.x, dY: aC.y - aS.y },
    });

    const marksFile = path.join(calib, `align-marks-${page}.txt`).replace(/\\/g, '/');
    const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
    const dst = path.join(calib, `align-overlay-${page}.jpg`).replace(/\\/g, '/');
    fs.writeFileSync(marksFile, marks.join('\n'));
    const ps = path.join(os.tmpdir(), `align-ov-${page}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$penX = New-Object System.Drawing.Pen ([System.Drawing.Color]::Red), 2
$penC = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 1
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::DeepSkyBlue)
foreach ($line in Get-Content '${marksFile}') {
  $p = $line.Split(','); $kind=$p[0]; $x=[int]$p[1]; $y=[int]$p[2]
  if ($kind -eq 'X') {
    $g.DrawLine($penX, $x-6, $y-6, $x+6, $y+6)
    $g.DrawLine($penX, $x-6, $y+6, $x+6, $y-6)
  } elseif ($kind -eq 'C') {
    $g.DrawEllipse($penC, $x-3, $y-3, 6, 6)
  } else {
    $g.FillEllipse($brush, $x-4, $y-4, 8, 8)
  }
}
$g.Dispose()
$bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$bmp.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
}

function crop(srcName, outName, pdfX1, pdfY1, pdfX2, pdfY2, bounds) {
    const toPix = (x, y) => ({
        x: Math.round(bounds.minX + (x / Wpdf) * bounds.contentW),
        y: Math.round(bounds.minY + ((Hpdf - y) / Hpdf) * bounds.contentH),
    });
    const a = toPix(pdfX1, pdfY1); const b = toPix(pdfX2, pdfY2);
    const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
    const top = Math.min(a.y, b.y); const bot = Math.max(a.y, b.y);
    const src = path.join(calib, srcName).replace(/\\/g, '/');
    const dst = path.join(calib, outName).replace(/\\/g, '/');
    const ps = path.join(os.tmpdir(), `align-crop-${outName}.ps1`);
    fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${src}')
$r = New-Object System.Drawing.Rectangle ${left}, ${top}, ${Math.max(1, right - left)}, ${Math.max(1, bot - top)}
$b = $src.Clone($r, $src.PixelFormat)
$b.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$b.Dispose(); $src.Dispose()
`);
    execFileSync('powershell', ['-NoProfile', '-File', ps]);
}

(async () => {
    ensurePages();
    const fonts = await glyphMetrics();
    const allBounds = [];
    for (let i = 0; i < 5; i += 1) {
        const b = contentBounds(i);
        allBounds.push(b);
        overlayActual(i, b, fonts);
    }
    const b0 = allBounds[0];
    const b1 = allBounds[1];
    const b4 = allBounds[4];
    crop('align-overlay-0.jpg', 'a0-head.jpg', 40, 500, 580, 760, b0);
    crop('align-overlay-0.jpg', 'a0-types.jpg', 40, 300, 580, 520, b0);
    crop('align-overlay-0.jpg', 'a0-desc.jpg', 40, 80, 580, 320, b0);
    crop('align-overlay-1.jpg', 'a1-proc.jpg', 40, 560, 580, 740, b1);
    crop('align-overlay-1.jpg', 'a1-acts.jpg', 40, 90, 580, 430, b1);
    crop('align-overlay-4.jpg', 'a4-docs.jpg', 40, 430, 580, 680, b4);
    crop('align-overlay-4.jpg', 'a4-sign.jpg', 40, 240, 580, 420, b4);
    fs.writeFileSync(path.join(calib, 'bounds.json'), JSON.stringify(allBounds.map((b, i) => ({
        page: i, ...b,
        marginL: b.minX, marginR: b.W - 1 - b.maxX, marginT: b.minY, marginB: b.H - 1 - b.maxY,
    })), null, 2));
    console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
