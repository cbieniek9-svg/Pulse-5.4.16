'use strict';
const fs = require('fs');
const express = require('express');
const path = require('path');
const root = path.join(__dirname, '..');

function resolveViteModuleSrc() {
    const indexHtml = path.join(root, 'dist', 'index.html');
    if (!fs.existsSync(indexHtml)) {
        throw new Error('dist/index.html missing — build the TV bundle first');
    }
    const html = fs.readFileSync(indexHtml, 'utf8');
    const m = html.match(/src="(\/assets\/[^"]+\.js)"/);
    if (!m) throw new Error('No /assets/*.js module script found in dist/index.html');
    return m[1];
}

const moduleSrc = resolveViteModuleSrc();
const app = express();
app.use('/assets', express.static(path.join(root, 'dist/assets')));
app.get('/bare', (req, res) => {
    res.type('html').send(`<!doctype html><html><body><div id="root"></div>
<script type="module" src="${moduleSrc}"></script></body></html>`);
});
app.get('/api/sync', (req, res) => res.json({
    tasks: [], kill_dates: [], kill_warnings: [],
    settings: { TV_Scale: '1' },
    kpis: { g: 1, f: 2, h: 3, staff: 1 },
    storeDate: '2026-05-19', ticker: [],
}));

(async () => {
    const failures = [];
    const { chromium } = require('playwright');
    const server = app.listen(0);
    const port = server.address().port;
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('response', (r) => {
        if (r.url().includes('.js') && r.status() !== 200) {
            const msg = `JS FAIL ${r.status()} ${r.url()}`;
            console.log(msg);
            failures.push(msg);
        }
    });
    page.on('pageerror', (e) => {
        console.log('PAGE', e.message);
        failures.push(`pageerror: ${e.message}`);
    });
    page.on('console', (m) => {
        if (m.type() === 'error') {
            console.log('CON', m.text());
            failures.push(`console: ${m.text()}`);
        }
    });
    await page.goto(`http://127.0.0.1:${port}/bare`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(5000);
    const rootText = await page.locator('#root').innerText().catch(() => '');
    console.log('root', rootText.slice(0, 80));
    if (!String(rootText || '').trim()) failures.push('empty #root');
    await browser.close();
    server.close();
    if (failures.length) {
        console.error('FAIL', failures.length, 'issue(s)');
        process.exit(1);
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
