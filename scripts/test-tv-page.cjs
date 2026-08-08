'use strict';
const express = require('express');
const path = require('path');
const root = path.join(__dirname, '..');

const app = express();
app.use('/public', express.static(path.join(root, 'public')));
app.use('/assets', express.static(path.join(root, 'dist/assets')));
app.use(express.static(path.join(root, 'dist'), { index: false }));
app.get(['/tv', '/tv/', '/TV', '/TV/'], (req, res) => res.sendFile(path.join(root, 'dist/index.html')));
app.get('/api/sync', (req, res) => res.json({
    tasks: [{ task_id: 'T1', task_detail: 'HELLO TASK', status: 'Open', priority: 'Routine', zone: 'A1', assigned_to: 'Bob' }],
    kill_dates: [], kill_warnings: [],
    oos: [], orders: [], expected: [], ticker: [],
    settings: { TV_Scale: '1', Zone_Ownership: '{}', Zone_Mapping: '{"Zone 1":[]}' },
    kpis: { g: 10, f: 20, h: 5, staff: 2, g_hrs: '1.0', f_hrs: '2.0', h_hrs: '0.5', shift_active: false },
    storeDate: '2026-05-19', storeWeekday: 'TUESDAY', storeDateLabel: 'MAY 19, 2026', storeTime: '1:00 PM',
}));
app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"type":"REFRESH"}\n\n');
});

(async () => {
    const { chromium } = require('playwright');
    const server = app.listen(0);
    const port = server.address().port;
    const browser = await chromium.launch();
    for (const urlPath of ['/tv/', '/tv']) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${port}${urlPath}`, { waitUntil: 'load', timeout: 15000 });
        await page.waitForTimeout(5000);
        const text = await page.locator('#root').innerText().catch(() => '');
        console.log(urlPath, '->', page.url(), 'rootLen', text.length, 'errors', errors);
    }
    await browser.close();
    server.close();
})();
