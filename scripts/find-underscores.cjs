'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const jpeg = require('jpeg-js');

const calib = path.join(__dirname, '..', '_calib');
const Wpdf = 612; const Hpdf = 792;

function load(page) {
    return jpeg.decode(fs.readFileSync(path.join(calib, `page-${page}.jpg`)), { useTArray: true });
}

/** Find thin long horizontal underscores in a PDF region. */
function findUnderscores(page, pdfX1, pdfY1, pdfX2, pdfY2, { minRunFrac = 0.55 } = {}) {
    const { width: W, height: H, data } = load(page);
    const gray = (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return 255;
        return data[(y * W + x) * 4];
    };
    const left = Math.round((Math.min(pdfX1, pdfX2) * W) / Wpdf);
    const right = Math.round((Math.max(pdfX1, pdfX2) * W) / Wpdf);
    const top = Math.round(((Hpdf - Math.max(pdfY1, pdfY2)) * H) / Hpdf);
    const bot = Math.round(((Hpdf - Math.min(pdfY1, pdfY2)) * H) / Hpdf);
    const width = right - left;
    const hits = [];
    for (let y = top; y <= bot; y += 1) {
        let dark = 0;
        let maxRun = 0;
        let run = 0;
        for (let x = left; x <= right; x += 1) {
            const d = gray(x, y) < 100;
            // thin line: this row dark, neighbors lighter
            const thin = d && gray(x, y - 2) > 160 && gray(x, y + 2) > 160;
            if (thin) {
                dark += 1;
                run += 1;
                if (run > maxRun) maxRun = run;
            } else run = 0;
        }
        if (maxRun / width >= minRunFrac) {
            const pdfY = Math.round((Hpdf - (y * Hpdf) / H) * 10) / 10;
            hits.push({ pixY: y, pdfY, maxRun, frac: +(maxRun / width).toFixed(2) });
        }
    }
    // collapse
    const out = [];
    for (const h of hits) {
        if (out.some((o) => Math.abs(o.pixY - h.pixY) < 4)) continue;
        out.push(h);
    }
    return out.sort((a, b) => b.pdfY - a.pdfY);
}

const p0 = {
    // value areas to the right of labels
    incident: findUnderscores(0, 140, 650, 360, 700),
    reportDate: findUnderscores(0, 140, 620, 300, 670),
    reportTime: findUnderscores(0, 390, 620, 490, 670),
    retail: findUnderscores(0, 140, 570, 520, 620),
    person: findUnderscores(0, 200, 545, 520, 590),
    incidentDate: findUnderscores(0, 140, 500, 300, 560),
    incidentTime: findUnderscores(0, 390, 500, 490, 560),
    fullHead: findUnderscores(0, 130, 500, 520, 720, { minRunFrac: 0.35 }),
};

const p2imm = findUnderscores(2, 140, 520, 560, 650, { minRunFrac: 0.4 });
const p2links = findUnderscores(2, 180, 150, 560, 280, { minRunFrac: 0.35 });
const p3action = findUnderscores(3, 70, 100, 300, 230, { minRunFrac: 0.35 });
const p3actionPerson = findUnderscores(3, 300, 100, 450, 230, { minRunFrac: 0.3 });

console.log(JSON.stringify({ p0, p2imm, p2links, p3action, p3actionPerson }, null, 2));

// Draw fullHead lines on page 0
const { width: W, height: H } = load(0);
const marks = p0.fullHead.map((h) => `L,${h.pixY},${h.pdfY}`).join('\n');
fs.writeFileSync(path.join(calib, 'uscores.txt'), marks);
const src = path.join(calib, 'page-0.jpg').replace(/\\/g, '/');
const dst = path.join(calib, 'uscores-0.jpg').replace(/\\/g, '/');
const ps = path.join(os.tmpdir(), 'uscores.ps1');
fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Lime), 2
$font = New-Object System.Drawing.Font 'Consolas', 14
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Red)
foreach ($line in Get-Content '${path.join(calib, 'uscores.txt').replace(/\\/g, '/')}') {
  $p=$line.Split(','); $y=[int]$p[1]; $lab=$p[2]
  $g.DrawLine($pen, 40, $y, 1650, $y)
  $g.DrawString($lab, $font, $brush, 40, $y-16)
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
execFileSync('powershell', ['-NoProfile', '-File', ps]);

// crop head
const left = Math.round((40 * W) / Wpdf);
const right = Math.round((560 * W) / Wpdf);
const top = Math.round(((Hpdf - 740) * H) / Hpdf);
const bot = Math.round(((Hpdf - 500) * H) / Hpdf);
const ps2 = path.join(os.tmpdir(), 'uscore-crop.ps1');
fs.writeFileSync(ps2, `
Add-Type -AssemblyName System.Drawing
$src=[System.Drawing.Image]::FromFile('${dst}')
$r=New-Object System.Drawing.Rectangle ${left},${top},${right - left},${bot - top}
$b=$src.Clone($r,$src.PixelFormat)
$b.Save('${path.join(calib, 'uscores-head.jpg').replace(/\\/g, '/')}', [System.Drawing.Imaging.ImageFormat]::Jpeg)
$b.Dispose();$src.Dispose()
`);
execFileSync('powershell', ['-NoProfile', '-File', ps2]);
console.log('wrote uscores-head.jpg');
