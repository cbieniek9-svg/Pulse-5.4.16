'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.join(__dirname, '..');

/** A port the OS hands back as free, so this never collides with a running store. */
function reserveFreePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function httpGet(port, urlPath) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
    });
}

test('React UI source files exist', () => {
    assert.ok(fs.existsSync(path.join(appRoot, 'client/vite.config.js')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/components/floor/FloorApp.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/providers/SyncProvider.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/pages/ReportsPage.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/pages/CsPage.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/pages/SafePage.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/pages/CountPage.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/settings/SettingsApp.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/safe/SafeApp.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/cs/CsApp.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/count/CountApp.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/reports/ReportsApp.jsx')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/reports/hooks/useReportsData.js')));
    assert.ok(fs.existsSync(path.join(appRoot, 'client/src/reports/sections/TodayPanel.jsx')));
});

test('React UI build serves from Express when present', async (t) => {
    const uiIndex = path.join(appRoot, 'dist/ui/index.html');
    if (!fs.existsSync(uiIndex)) {
        t.skip('dist/ui not built — run npm run build:ui');
        return;
    }

    try {
        const Database = require('better-sqlite3');
        const probe = new Database(':memory:');
        probe.close();
    } catch (e) {
        t.skip(`better-sqlite3 not loadable under system Node (${e.message})`);
        return;
    }

    // Boot a throwaway store: its own empty data dir, a free loopback port and no
    // HTTPS listener. Without this the test races the real Command Center on 3001 —
    // it would either fail on EADDRINUSE or, worse, mutate live store data.
    process.env.TGP_TEST_MODE = '1';
    process.env.TGP_HEADLESS_TEST = '1';
    process.env.TGP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-ui-shell-'));
    process.env.TGP_PORT = String(await reserveFreePort());
    process.env.TGP_HTTPS = '0';
    process.env.TGP_ALLOW_LAN_CLIENTS = '0';

    const { startAppServer } = require('../src/lib/app-boot.cjs');
    const boot = await startAppServer({ appRoot });
    t.after(async () => boot.close());

    const home = await httpGet(boot.networkConfig.port, '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /id="root"/);

    const reports = await httpGet(boot.networkConfig.port, '/reports');
    assert.equal(reports.status, 200);
    assert.match(reports.body, /id="root"/);

    const cs = await httpGet(boot.networkConfig.port, '/cs');
    assert.equal(cs.status, 200);
    assert.match(cs.body, /id="root"/);

    const legacyMobile = await httpGet(boot.networkConfig.port, '/mobile.html');
    assert.equal(legacyMobile.status, 301);
});
