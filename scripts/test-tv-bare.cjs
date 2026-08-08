'use strict';
const express = require('express');
const path = require('path');
const root = path.join(__dirname, '..');
const app = express();
app.use('/assets', express.static(path.join(root, 'dist/assets')));
app.get('/bare', (req, res) => {
    res.type('html').send(`<!doctype html><html><body><div id="root"></div>
<script type="module" src="/assets/index-BmeQI9hM.js"></script></body></html>`);
});
app.get('/api/sync', (req, res) => res.json({
    tasks: [], kill_dates: [], kill_warnings: [],
    settings: { TV_Scale: '1' },
    kpis: { g: 1, f: 2, h: 3, staff: 1 },
    storeDate: '2026-05-19', ticker: [],
}));

(async () => {
    const { chromium } = require('playwright');
    const server = app.listen(0);
    const port = server.address().port;
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('response', (r) => {
        if (r.url().includes('.js') && r.status() !== 200) console.log('JS FAIL', r.status(), r.url());
    });
    page.on('console', (m) => { if (m.type() === 'error') console.log('CON', m.text()); });
    await page.goto(`http://127.0.0.1:${port}/bare`, { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(5000);
    console.log('root', (await page.locator('#root').innerText()).slice(0, 80));
    await browser.close();
    server.close();
})();
