#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', 'Doc', 'standards-pdf');
const SOURCES = path.join(ROOT, 'sources');
const OUT_DIR = path.join(ROOT, 'output');
const SNAPSHOT_PATH = path.join(ROOT, 'zone-snapshot.json');
const { formatZoneBlockMarkdown } = require('./lib/zone-snapshot-format.cjs');

const SOURCE_FILES = [
    '00_TGP_Local_Operating_Standards_Alignment_Review_v3.md',
    '01_TGP_Center_Store_5S_HomeBase_Aisle_Ownership_Standards_v3.md',
    '02_TGP_Front_End_Customer_Service_5S_SOP_v3.md',
    '03_TGP_Receiving_5S_SOP_v3.md',
];

function loadSnapshot() {
    if (!fs.existsSync(SNAPSHOT_PATH)) {
        console.error('Missing zone-snapshot.json');
        console.error('Run first: node scripts/export-zone-snapshot.cjs [path/to/tgp_ops.db]');
        console.error('Or on store PC with TGP running, pass the live database path.');
        process.exit(1);
    }
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

function injectZoneBlock(md, snapshot) {
    const block = formatZoneBlockMarkdown(snapshot);
    if (!md.includes('{{ZONE_MAP_BLOCK}}')) return md;
    return md.replace('{{ZONE_MAP_BLOCK}}', block);
}

function pdfCss() {
    return `
        body { font-family: Segoe UI, Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; max-width: 7.5in; margin: 0 auto; padding: 0.5in; }
        h1 { font-size: 18pt; border-bottom: 2px solid #0a6; padding-bottom: 6px; }
        h2 { font-size: 13pt; margin-top: 1.2em; color: #064; }
        h3 { font-size: 11pt; margin-top: 1em; }
        table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 10pt; }
        th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
        th { background: #f0f7f4; }
        code { background: #f4f4f4; padding: 1px 4px; font-size: 9pt; }
        em { color: #444; }
        hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
        ul { padding-left: 1.2em; }
    `;
}

async function buildOne(mdToPdf, srcName, snapshot) {
    const srcPath = path.join(SOURCES, srcName);
    const outName = srcName.replace(/\.md$/, '.pdf');
    const outPath = path.join(OUT_DIR, outName);
    let md = fs.readFileSync(srcPath, 'utf8');
    md = injectZoneBlock(md, snapshot);

    await mdToPdf(
        { content: md },
        {
            dest: outPath,
            css: pdfCss(),
            pdf_options: {
                format: 'Letter',
                margin: '18mm 16mm',
                printBackground: true,
            },
        },
    );
    console.log('Built', outPath);
}

async function main() {
    let mdToPdf;
    try {
        ({ mdToPdf } = require('md-to-pdf'));
    } catch {
        console.error('Install md-to-pdf first: npm install md-to-pdf --save-dev');
        process.exit(1);
    }

    const snapshot = loadSnapshot();
    fs.mkdirSync(OUT_DIR, { recursive: true });

    for (const file of SOURCE_FILES) {
        await buildOne(mdToPdf, file, snapshot);
    }

    // Also copy v3 PDFs to resources/ for easy access (same names as legacy package)
    const resourcesDir = path.join(ROOT, '..');
    for (const file of SOURCE_FILES) {
        const pdf = file.replace(/\.md$/, '.pdf');
        const from = path.join(OUT_DIR, pdf);
        const to = path.join(resourcesDir, pdf);
        if (fs.existsSync(from)) {
            fs.copyFileSync(from, to);
            console.log('Copied', to);
        }
    }
    console.log('Done.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
