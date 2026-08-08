#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'docs', 'TGP_Board_Toolbox_Meeting.md');
const OUT = path.join(ROOT, 'docs', 'TGP_Board_Toolbox_Meeting.pdf');
const TMP_HTML = path.join(ROOT, 'docs', '.TGP_Board_Toolbox_Meeting.tmp.html');

function pdfCss() {
    return `
        body { font-family: Segoe UI, Arial, sans-serif; font-size: 11pt; line-height: 1.45; color: #111; max-width: 7.5in; margin: 0 auto; padding: 0.4in; }
        h1 { font-size: 20pt; border-bottom: 3px solid #f90; padding-bottom: 8px; color: #0b1a2e; }
        h2 { font-size: 13pt; margin-top: 1.3em; color: #064; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
        h3 { font-size: 11pt; margin-top: 1em; color: #333; }
        table { border-collapse: collapse; width: 100%; margin: 0.6em 0; font-size: 10pt; page-break-inside: avoid; }
        th, td { border: 1px solid #bbb; padding: 6px 8px; text-align: left; vertical-align: top; }
        th { background: #fff8e8; font-weight: 700; }
        blockquote { border-left: 4px solid #f90; margin: 0.8em 0; padding: 0.4em 1em; background: #fafafa; font-style: italic; color: #333; }
        code { background: #f4f4f4; padding: 1px 5px; font-size: 9pt; font-family: Consolas, monospace; }
        pre { background: #0b1a2e; color: #8cf; padding: 14px 16px; font-size: 9.5pt; line-height: 1.5; border-radius: 6px; white-space: pre-wrap; }
        hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
        ul { padding-left: 1.3em; }
        li { margin-bottom: 0.25em; }
        em { color: #555; }
        strong { color: #000; }
        .page-break { page-break-before: always; }
    `;
}

function mdToHtml(md) {
    let html = md
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    html = html.replace(/^---$/gm, '<hr/>');
    html = html.replace(/<div style="page-break-before: always;"><\/div>/g, '<div class="page-break"></div>');

    const lines = html.split('\n');
    const out = [];
    let inPre = false;
    let inUl = false;
    let tableRows = [];

    function flushTable() {
        if (!tableRows.length) return;
        const [head, ...body] = tableRows;
        const headCells = head.split('|').slice(1, -1).map((c) => c.trim());
        out.push('<table><thead><tr>' + headCells.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
        body.forEach((row) => {
            if (/^\|[\s\-:|]+\|$/.test(row)) return;
            const cells = row.split('|').slice(1, -1).map((c) => c.trim());
            if (cells.length) out.push('<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>');
        });
        out.push('</tbody></table>');
        tableRows = [];
    }

    for (const line of lines) {
        if (line.startsWith('```')) {
            if (!inPre) {
                flushTable();
                if (inUl) { out.push('</ul>'); inUl = false; }
                out.push('<pre>');
                inPre = true;
            } else {
                out.push('</pre>');
                inPre = false;
            }
            continue;
        }
        if (inPre) {
            out.push(line);
            continue;
        }
        if (line.trim().startsWith('|')) {
            if (inUl) { out.push('</ul>'); inUl = false; }
            tableRows.push(line.trim());
            continue;
        }
        flushTable();
        if (/^- \[ \] /.test(line)) {
            if (!inUl) { out.push('<ul>'); inUl = true; }
            out.push(`<li>${line.replace(/^- \[ \] /, '☐ ')}</li>`);
            continue;
        }
        if (/^- /.test(line)) {
            if (!inUl) { out.push('<ul>'); inUl = true; }
            out.push(`<li>${line.slice(2)}</li>`);
            continue;
        }
        if (inUl) { out.push('</ul>'); inUl = false; }
        if (line.trim()) out.push(line);
    }
    flushTable();
    if (inUl) out.push('</ul>');
    if (inPre) out.push('</pre>');

    return out.join('\n');
}

async function main() {
    if (!fs.existsSync(SRC)) {
        console.error('Missing source:', SRC);
        process.exit(1);
    }
    const md = fs.readFileSync(SRC, 'utf8');
    const body = mdToHtml(md);
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${pdfCss()}</style></head><body>${body}</body></html>`;
    fs.writeFileSync(TMP_HTML, html, 'utf8');

    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(pathToFileURL(TMP_HTML).href, { waitUntil: 'load' });
    await page.pdf({
        path: OUT,
        format: 'Letter',
        margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' },
        printBackground: true,
    });
    await browser.close();
    try { fs.unlinkSync(TMP_HTML); } catch (_) { /* ignore */ }
    console.log('Built', OUT);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
