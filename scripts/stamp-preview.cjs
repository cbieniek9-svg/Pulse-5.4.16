'use strict';

/** Stamp real Helvetica-metric X origins onto page JPEGs using updated engine math. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const map = require('../src/lib/incident-investigation-pdf-map.cjs');

const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612; const Hpdf = 792;

async function main() {
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const regular = await pdf.embedFont(StandardFonts.Helvetica);

    for (let page = 0; page < 5; page += 1) {
        const { width: W, height: H } = jpeg.decode(fs.readFileSync(path.join(calib, `page-${page}.jpg`)), { useTArray: true });
        const marks = [];
        for (const field of map.checks.filter((c) => c.page === page)) {
            const size = field.size || 12;
            const gw = bold.widthOfTextAtSize('X', size);
            const gh = bold.heightAtSize(size, { descender: false });
            const x = field.x - (gw / 2);
            const y = field.y - (gh / 2);
            // Draw position in pixels (GDI top-left of glyph ≈ PDF baseline converted)
            const px = Math.round((x * W) / Wpdf);
            const py = Math.round(((Hpdf - y - gh) * H) / Hpdf);
            const fontPx = Math.round((size * H) / Hpdf);
            marks.push(`X,${px},${py},${fontPx}`);
            // Also mark intended center
            const cx = Math.round((field.x * W) / Wpdf);
            const cy = Math.round(((Hpdf - field.y) * H) / Hpdf);
            marks.push(`C,${cx},${cy},0`);
        }
        for (const field of map.texts.filter((t) => t.page === page)) {
            const size = field.size || 11;
            const px = Math.round((field.x * W) / Wpdf);
            const py = Math.round(((Hpdf - field.y - size * 0.8) * H) / Hpdf);
            const fontPx = Math.round((size * H) / Hpdf);
            marks.push(`T,${px},${py},${fontPx}`);
        }
        const mf = path.join(calib, `stamp-prev-marks-${page}.txt`).replace(/\\/g, '/');
        fs.writeFileSync(mf, marks.join('\n'));
        const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
        const dst = path.join(calib, `stamp-prev-${page}.jpg`).replace(/\\/g, '/');
        const ps = path.join(os.tmpdir(), `stamp-prev-${page}.ps1`);
        fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220,220,0,0))
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 1
foreach ($line in Get-Content '${mf}') {
  $p=$line.Split(','); $kind=$p[0]; $x=[int]$p[1]; $y=[int]$p[2]; $sz=[int]$p[3]
  if ($kind -eq 'C') { $g.DrawEllipse($pen,$x-2,$y-2,4,4) }
  elseif ($kind -eq 'X') {
    $font = New-Object System.Drawing.Font 'Arial', ([math]::Max(8,$sz)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('X', $font, $brush, [float]$x, [float]$y)
    $font.Dispose()
  } else {
    $font = New-Object System.Drawing.Font 'Arial', ([math]::Max(8,$sz)), ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
    $g.DrawString('Abc', $font, $brush, [float]$x, [float]$y)
    $font.Dispose()
  }
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
        execFileSync('powershell', ['-NoProfile', '-File', ps]);
        console.log('wrote', dst);
    }

    // Crops
    const crops = [
        [0, 'final-p0-head.jpg', 40, 500, 560, 720],
        [0, 'final-p0-inc.jpg', 50, 300, 540, 430],
        [1, 'final-p1-proc.jpg', 350, 580, 530, 680],
        [1, 'final-p1-acts.jpg', 50, 90, 380, 420],
        [4, 'final-p4-docs.jpg', 70, 430, 530, 620],
    ];
    for (const [page, out, x1, y1, x2, y2] of crops) {
        const src = path.join(calib, `stamp-prev-${page}.jpg`);
        const { width: W, height: H } = jpeg.decode(fs.readFileSync(src), { useTArray: true });
        const toPix = (x, y) => ({
            x: Math.round((x * W) / Wpdf),
            y: Math.round(((Hpdf - y) * H) / Hpdf),
        });
        const a = toPix(x1, y1); const b = toPix(x2, y2);
        const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
        const top = Math.min(a.y, b.y); const bot = Math.max(a.y, b.y);
        const ps = path.join(os.tmpdir(), `final-${out}.ps1`);
        fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${src.replace(/\\/g, '/')}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$b=$src.Clone($r,$src.PixelFormat)
$b.Save('${path.join(calib, out).replace(/\\/g, '/')}',[System.Drawing.Imaging.ImageFormat]::Jpeg)
$b.Dispose();$src.Dispose()
`);
        execFileSync('powershell', ['-NoProfile', '-File', ps]);
        console.log('crop', out);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
