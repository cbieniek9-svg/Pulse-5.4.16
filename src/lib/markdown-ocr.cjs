'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseMarkdownOcrText } = require('./markdown-parse.cjs');

/**
 * Image-only PDFs (JPEG pages) need high-DPI rasterize before Tesseract; optional PyMuPDF script.
 * @param {string} pdfPath
 * @param {string} outDir
 * @returns {string[]} PNG paths (one per page), sorted
 */
function rasterizePdfForOcr(pdfPath, outDir) {
    const script = path.join(__dirname, '..', '..', 'scripts', 'rasterize-pdf-for-ocr.py');
    if (!fs.existsSync(script)) return [];
    const run = spawnSync('python', [script, pdfPath, outDir], {
        encoding: 'utf8',
        timeout: 300000,
        windowsHide: true,
    });
    if (run.status !== 0) return [];
    const fromStdout = String(run.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /\.png$/i.test(l) && fs.existsSync(l));
    if (fromStdout.length) return fromStdout.sort();
    try {
        return fs.readdirSync(outDir)
            .filter((f) => /^scan-page-\d+\.png$/i.test(f))
            .sort()
            .map((f) => path.join(outDir, f))
            .filter((p) => fs.existsSync(p));
    } catch (_) {
        return [];
    }
}

async function extractMarkdownScanText(filename, contentBase64) {
    const safeName = String(filename || '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120) || 'markdown-scan.pdf';
    if (!/\.(pdf|png|jpe?g|tiff?|webp)$/i.test(safeName)) {
        const err = new Error('Upload must be a scanned PDF or image file.');
        err.status = 400;
        throw err;
    }
    const buf = Buffer.from(String(contentBase64 || ''), 'base64');
    if (!buf.length) {
        const err = new Error('Empty upload.');
        err.status = 400;
        throw err;
    }
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-markdown-ocr-'));
    const tempPath = path.join(tempDir, safeName);
    fs.writeFileSync(tempPath, buf);
    try {
        const mod = await import('scribe.js-ocr');
        const scribe = mod.default || mod;
        const isPdf = /\.pdf$/i.test(safeName);
        let ocrInputs = [tempPath];
        if (isPdf) {
            const rasterPages = rasterizePdfForOcr(tempPath, tempDir);
            if (rasterPages.length) ocrInputs = rasterPages;
        }
        const useNativePdf = isPdf && ocrInputs.length === 1 && ocrInputs[0] === tempPath;
        const text = await scribe.extractText(ocrInputs, ['eng'], 'txt', {
            usePDFText: useNativePdf ? { native: false, ocr: true } : { native: true, ocr: true },
            mode: 'quality',
        });
        if (scribe.clear) await scribe.clear();
        if (scribe.terminate) await scribe.terminate();
        return String(text || '').trim();
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
}

module.exports = { parseMarkdownOcrText, extractMarkdownScanText, rasterizePdfForOcr };
