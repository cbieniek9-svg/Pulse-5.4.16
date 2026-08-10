'use strict';

/** Build a fully-checked sample PDF, rasterize pages, crop key regions. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
    EVENT_TYPES,
    SUBSTANDARD_ACTS,
    SUBSTANDARD_CONDITIONS,
    ROOT_PERSONAL,
    ROOT_JOB,
    CORRECTIVE_AREAS,
    SUPPORTING_DOCS,
} = require('../src/lib/incident-investigation-catalog.cjs');
const { buildInvestigationPdf } = require('../src/lib/incident-investigation-pdf.cjs');

const root = path.join(__dirname, '..');
const calib = path.join(root, '_calib');

function filledInvestigation() {
    const incidentTypes = {};
    for (const k of [
        'first_aid', 'motor_vehicle_incident', 'near_miss',
        'medical_aid_no_lost_time', 'contractor_recordable', 'third_party_incident',
        'restricted_work', 'property_damage', 'spill_or_release',
        'lost_time', 'fire_explosion_flood', 'work_refusal',
        'fatality', 'violence_or_harassment', 'other',
    ]) incidentTypes[k] = true;

    const substandardActs = {};
    for (const e of SUBSTANDARD_ACTS) substandardActs[e.key] = true;
    const substandardConditions = {};
    for (const e of SUBSTANDARD_CONDITIONS) substandardConditions[e.key] = true;
    const rootPersonal = {};
    for (const e of ROOT_PERSONAL) rootPersonal[e.key] = true;
    const rootJob = {};
    for (const e of ROOT_JOB) rootJob[e.key] = true;
    const correctiveAreas = {};
    for (const e of CORRECTIVE_AREAS) correctiveAreas[e.key] = true;
    const eventTypes = {};
    for (const e of EVENT_TYPES) eventTypes[e.key] = true;
    const supportingDocs = {};
    for (const e of SUPPORTING_DOCS) {
        supportingDocs[e.key] = { utilized: 'yes', copyAttached: 'yes' };
    }

    return {
        incident_number: 'INC-2026-001',
        report_date: '18-07-26',
        report_time: '2:30',
        report_ampm: 'PM',
        retail_name: 'TGP Demo Store',
        person_involved: 'Jane Sample',
        person_types: { full_time: true, part_time: true, contractor: true, customer: true },
        incident_date: '17-07-26',
        incident_time: '11:15',
        incident_ampm: 'AM',
        witnesses: [
            { name: 'Witness One' },
            { name: 'Witness Two' },
            { name: 'Witness Three' },
        ],
        payload: {
            descriptionLines: [
                'Line one description of the incident for calibration.',
                'Line two continues the narrative on the ruling.',
                'Line three.',
                'Line four.',
                'Line five.',
                'Line six.',
                'Line seven.',
                'Line eight.',
                'Line nine.',
                'Line ten.',
            ],
            incidentTypes,
            process: {
                hazardAssessment: 'yes',
                controlsImplemented: 'no',
                jhaExists: 'na',
                jhaFollowed: 'yes',
                equipmentMaterials: 'Pallet jack / wet floor',
            },
            eventTypes,
            substandardActs,
            substandardConditions,
            substandardActsOther: 'Other act note',
            substandardConditionsOther: 'Other cond note',
            immediateContributions: [
                { idNum: '1', explanation: 'Immediate cause explanation one' },
                { idNum: '2', explanation: 'Immediate cause explanation two' },
                { idNum: '3', explanation: 'Three' },
                { idNum: '4', explanation: 'Four' },
                { idNum: '5', explanation: 'Five' },
            ],
            rootPersonal,
            rootJob,
            rootPersonalOther: 'Other personal',
            rootJobOther: 'Other job',
            rootLinks: [
                { idNum: '1', brNum: '2', explanation: 'Root link one' },
                { idNum: '3', brNum: '4', explanation: 'Root link two' },
                { idNum: '5', brNum: '6', explanation: 'Three' },
                { idNum: '7', brNum: '8', explanation: 'Four' },
                { idNum: '9', brNum: '10', explanation: 'Five' },
            ],
            correctiveAreas,
            correctiveOther: 'Other CA',
            correctiveLinks: [
                { idNum: '1', brNum: '2', caNum: '3', explanation: 'CA link one' },
                { idNum: '4', brNum: '5', caNum: '6', explanation: 'Two' },
                { idNum: '7', brNum: '8', caNum: '9', explanation: 'Three' },
                { idNum: '10', brNum: '11', caNum: '12', explanation: 'Four' },
                { idNum: '13', brNum: '14', caNum: '15', explanation: 'Five' },
            ],
            actionLog: [
                { action: 'Action one', person: 'Lead A', dueDate: '01-08-26' },
                { action: 'Action two', person: 'Lead B', dueDate: '02-08-26' },
                { action: 'Action three', person: 'Lead C', dueDate: '03-08-26' },
                { action: 'Action four', person: 'Lead D', dueDate: '04-08-26' },
                { action: 'Action five', person: 'Lead E', dueDate: '05-08-26' },
            ],
            supportingDocs,
        },
        signoffs: {
            lead: { name: 'Lead Name', date: '18-07-26' },
            safety_committee: { name: 'Safety Name', date: '18-07-26' },
            senior_management: { name: 'Senior Name', date: '18-07-26' },
        },
    };
}

(async () => {
    const bytes = await buildInvestigationPdf({ investigation: filledInvestigation() });
    const pdfPath = path.join(calib, 'verify-filled.pdf');
    fs.writeFileSync(pdfPath, bytes);
    console.log('wrote', pdfPath, bytes.length);

    // Rasterize with PowerShell + Pdfium if available, else try magick, else use pdf-lib page images N/A.
    // Prefer: Windows.Data.Pdf or ghostscript. Try magick / gswin64c.
    const outPattern = path.join(calib, 'verify-page-%d.jpg');
    let rasterized = false;
    for (const cmd of [
        ['magick', ['-density', '150', pdfPath, outPattern.replace('%d', '%d')]],
        ['gswin64c', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=jpeg', '-r150', `-sOutputFile=${path.join(calib, 'verify-page-%d.jpg')}`, pdfPath]],
        ['gswin32c', ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-sDEVICE=jpeg', '-r150', `-sOutputFile=${path.join(calib, 'verify-page-%d.jpg')}`, pdfPath]],
    ]) {
        try {
            execFileSync(cmd[0], cmd[1], { stdio: 'pipe' });
            rasterized = true;
            console.log('rasterized via', cmd[0]);
            break;
        } catch {
            // try next
        }
    }

    if (!rasterized) {
        // Fallback: use pdf.js-less approach — draw stamps onto page JPEGs with System.Drawing text
        console.log('no magick/gs — stamping onto page JPEGs with GDI+ Helvetica-like font');
        const map = require('../src/lib/incident-investigation-pdf-map.cjs');
        const { StandardFonts } = require('pdf-lib');
        const { PDFDocument } = require('pdf-lib');
        const pdf = await PDFDocument.create();
        const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
        const regular = await pdf.embedFont(StandardFonts.Helvetica);
        // We can't easily blit pdf font to GDI. Use Arial Bold as approximation and apply SAME offsets.
        for (let page = 0; page < 5; page += 1) {
            const marks = [];
            for (const field of map.checks.filter((c) => c.page === page)) {
                const size = field.size || 12;
                const gw = bold.widthOfTextAtSize('X', size);
                // Same as stamp engine
                const x = field.x - (gw / 2) + 0.5;
                const y = field.y - (size * 0.28);
                marks.push(`X,${x},${y},${size}`);
            }
            for (const field of map.texts.filter((t) => t.page === page)) {
                marks.push(`T,${field.x},${field.y},${field.size || 11}`);
            }
            const mf = path.join(calib, `verify-gdi-marks-${page}.txt`);
            fs.writeFileSync(mf, marks.join('\n'));
            const src = path.join(calib, `page-${page}.jpg`).replace(/\\/g, '/');
            const dst = path.join(calib, `verify-gdi-${page}.jpg`).replace(/\\/g, '/');
            const ps = path.join(os.tmpdir(), `verify-gdi-${page}.ps1`);
            // PDF pts → pixels on 1700x2200
            fs.writeFileSync(ps, `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap '${src}'
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
$W=$bmp.Width; $H=$bmp.Height; $Wpdf=612.0; $Hpdf=792.0
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::Red)
foreach ($line in Get-Content '${mf.replace(/\\/g, '/')}') {
  $p=$line.Split(',')
  $kind=$p[0]; $px=[double]$p[1]; $py=[double]$p[2]; $sz=[double]$p[3]
  $x = ($px / $Wpdf) * $W
  $y = (($Hpdf - $py - $sz) / $Hpdf) * $H   # GDI draws from top; approximate cap height
  $fontSz = ($sz / $Hpdf) * $H * 0.95
  $font = New-Object System.Drawing.Font 'Arial', $fontSz, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  if ($kind -eq 'X') { $g.DrawString('X', $font, $brush, [float]$x, [float]$y) }
  else { $g.DrawString('Sample', $font, $brush, [float]$x, [float]$y) }
  $font.Dispose()
}
$g.Dispose(); $bmp.Save('${dst}', [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
`);
            execFileSync('powershell', ['-NoProfile', '-File', ps]);
            console.log('wrote', dst);
        }
    }

    // Crop from this run's raster output (not a stale verify-gdi-0.jpg from a prior attempt).
    const base = rasterized ? 'verify-page' : 'verify-gdi';
    const crops = [
        [0, 'vfill-p0-head.jpg', 40, 500, 560, 720],
        [0, 'vfill-p0-inc.jpg', 50, 300, 540, 430],
        [1, 'vfill-p1-proc.jpg', 350, 580, 530, 680],
        [1, 'vfill-p1-acts.jpg', 50, 90, 380, 420],
        [4, 'vfill-p4-docs.jpg', 70, 430, 530, 620],
        [4, 'vfill-p4-sign.jpg', 150, 250, 560, 400],
    ];
    for (const [page, out, x1, y1, x2, y2] of crops) {
        const srcName = base === 'verify-gdi' ? `verify-gdi-${page}.jpg` : `verify-page-${page}.jpg`;
        // also try 1-based ghostscript
        let src = path.join(calib, srcName);
        if (!fs.existsSync(src) && base !== 'verify-gdi') {
            src = path.join(calib, `verify-page-${page + 1}.jpg`);
        }
        if (!fs.existsSync(src)) { console.log('missing', src); continue; }
        const Wpdf = 612; const Hpdf = 792;
        // get dims
        const jpeg = require('jpeg-js');
        const { width: W, height: H } = jpeg.decode(fs.readFileSync(src), { useTArray: true });
        const toPix = (x, y) => ({
            x: Math.round((x * W) / Wpdf),
            y: Math.round(((Hpdf - y) * H) / Hpdf),
        });
        const a = toPix(x1, y1); const b = toPix(x2, y2);
        const left = Math.min(a.x, b.x); const right = Math.max(a.x, b.x);
        const top = Math.min(a.y, b.y); const bot = Math.max(a.y, b.y);
        const ps = path.join(os.tmpdir(), `vfill-${out}.ps1`);
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
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
