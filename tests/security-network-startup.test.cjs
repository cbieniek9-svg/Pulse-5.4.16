'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const appRoot = path.join(__dirname, '..');

function reserveFreePort(host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.on('error', reject);
        probe.listen(0, host, () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

function runIsolated(script) {
    const wrapped = `'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const appRoot = ${JSON.stringify(appRoot)};
(async () => {
${script}
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
`;
    const res = spawnSync(process.execPath, ['-e', wrapped], {
        cwd: appRoot,
        encoding: 'utf8',
        timeout: 90000,
        env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            TGP_TEST_MODE: '1',
            TGP_HEADLESS_TEST: '1',
        },
    });
    if (res.status !== 0) {
        const out = `${res.stdout || ''}\n${res.stderr || ''}`;
        throw new Error(`isolated boot failed (status=${res.status}):\n${out}`);
    }
    return res.stdout || '';
}

test('HTTP binds loopback only; HTTPS binds LAN when enabled', async () => {
    const httpPort = await reserveFreePort('127.0.0.1');
    const httpsPort = await reserveFreePort('127.0.0.1');
    runIsolated(`
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-sec-net-ok-'));
  process.env.TGP_DATA_DIR = dataDir;
  process.env.TGP_PORT = ${JSON.stringify(String(httpPort))};
  process.env.TGP_HTTPS_PORT = ${JSON.stringify(String(httpsPort))};
  process.env.TGP_HTTPS = '1';
  process.env.TGP_ALLOW_LAN_CLIENTS = '1';
  process.env.TGP_BIND_HOST = '0.0.0.0';

  const { startAppServer } = require(path.join(appRoot, 'src/lib/app-boot.cjs'));
  const boot = await startAppServer({ appRoot });
  try {
    assert.equal(boot.networkConfig.http_bind_host, '127.0.0.1');
    assert.equal(boot.networkConfig.https_bind_host, '0.0.0.0');
    assert.equal(boot.listener.address().address, '127.0.0.1');
    assert.equal(boot.listener.address().port, ${httpPort});
    assert.ok(boot.httpsListener, 'HTTPS listener should start when certs can be created');
    assert.equal(boot.networkConfig.https_active, true);
    const expectLanReady = !!(
      boot.networkConfig.https_active
      && boot.networkConfig.allow_lan_clients
      && (boot.networkConfig.lan_addresses || []).length > 0
    );
    assert.equal(boot.networkConfig.lan_ready, expectLanReady);
    const httpsAddr = boot.httpsListener.address();
    assert.ok(
      httpsAddr.address === '0.0.0.0' || httpsAddr.address === '::',
      'expected LAN HTTPS bind, got ' + httpsAddr.address,
    );
    assert.equal(httpsAddr.port, ${httpsPort});

    const ready = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: ${httpPort}, path: '/api/ready' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(ready.status, 200);
    const readyJson = JSON.parse(ready.body);
    assert.equal(readyJson.https.active, true);
    assert.match(readyJson.https.public_base_url || '', /^https:/);

    const httpsReady = await new Promise((resolve, reject) => {
      https.get({
        host: '127.0.0.1',
        port: ${httpsPort},
        path: '/api/ready',
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(httpsReady.status, 200);
  } finally {
    await boot.close();
  }
`);
});

test('HTTPS startup failure keeps loopback HTTP and records HTTPS_STARTUP_FAILED', async () => {
    const httpPort = await reserveFreePort('127.0.0.1');
    const httpsPort = await reserveFreePort('127.0.0.1');
    runIsolated(`
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-sec-net-fail-'));
  process.env.TGP_DATA_DIR = dataDir;
  process.env.TGP_PORT = ${JSON.stringify(String(httpPort))};
  process.env.TGP_HTTPS_PORT = ${JSON.stringify(String(httpsPort))};
  process.env.TGP_HTTPS = '1';
  process.env.TGP_ALLOW_LAN_CLIENTS = '1';
  process.env.TGP_BIND_HOST = '0.0.0.0';

  const blocker = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(${httpsPort}, '0.0.0.0', () => resolve(s));
  });

  const { startAppServer } = require(path.join(appRoot, 'src/lib/app-boot.cjs'));
  const boot = await startAppServer({ appRoot });
  try {
    assert.equal(boot.listener.address().address, '127.0.0.1');
    assert.equal(boot.httpsListener, null);
    assert.equal(boot.networkConfig.https_active, false);
    assert.equal(boot.networkConfig.lan_ready, false);
    assert.equal(boot.networkConfig.public_https_base_url, '');

    const health = boot.getBootHealth();
    assert.ok(health);
    assert.equal(health.ok, false);
    assert.ok(
      (health.errors || []).some((e) => String(e).includes('HTTPS_STARTUP_FAILED')),
      'expected HTTPS_STARTUP_FAILED in ' + JSON.stringify(health.errors),
    );

    const ready = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: ${httpPort}, path: '/api/ready' }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    assert.equal(ready.status, 200);
    const readyJson = JSON.parse(ready.body);
    assert.equal(readyJson.https.public_base_url, '');
    assert.equal(readyJson.https.active, false);
  } finally {
    await boot.close();
    await new Promise((resolve) => blocker.close(() => resolve()));
  }
`);
});

function mockRes() {
    return {
        statusCode: 0,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

test('non-loopback peer on HTTP path receives 426 HTTPS_REQUIRED before credentials', () => {
    const { requireHttpsForNonLoopback, canAttachUiOnly } = require('../src/lib/app-boot.cjs');
    assert.equal(typeof requireHttpsForNonLoopback, 'function');

    let nextCalled = false;
    const res = mockRes();
    requireHttpsForNonLoopback(
        {
            secure: false,
            socket: { encrypted: false, remoteAddress: '192.168.0.50' },
            headers: {},
            body: { pin: '9999', token: 'should-not-be-read' },
        },
        res,
        () => { nextCalled = true; },
    );
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 426);
    assert.equal(res.body.code, 'HTTPS_REQUIRED');
    assert.match(res.body.error, /HTTPS is required/i);

    // Loopback HTTP continues.
    nextCalled = false;
    const loopRes = mockRes();
    requireHttpsForNonLoopback(
        {
            socket: { encrypted: false, remoteAddress: '127.0.0.1' },
            headers: {},
        },
        loopRes,
        () => { nextCalled = true; },
    );
    assert.equal(nextCalled, true);
    assert.equal(loopRes.statusCode, 0);

    // TLS is detected only via socket.encrypted — not req.secure.
    nextCalled = false;
    requireHttpsForNonLoopback(
        {
            secure: false,
            socket: { encrypted: true, remoteAddress: '192.168.0.50' },
            headers: {},
        },
        loopRes,
        () => { nextCalled = true; },
    );
    assert.equal(nextCalled, true);

    // Forged trust-proxy style signals must not bypass the gate.
    nextCalled = false;
    const forged = mockRes();
    requireHttpsForNonLoopback(
        {
            secure: true,
            ip: '127.0.0.1',
            socket: { encrypted: false, remoteAddress: '192.168.0.50' },
            headers: {
                'x-forwarded-proto': 'https',
                'x-forwarded-for': '127.0.0.1',
            },
        },
        forged,
        () => { nextCalled = true; },
    );
    assert.equal(nextCalled, false);
    assert.equal(forged.statusCode, 426);
    assert.equal(forged.body.code, 'HTTPS_REQUIRED');

    assert.deepEqual(canAttachUiOnly({ ok: true, restart_required: false }), { attach: true, reason: 'ok' });
    assert.deepEqual(canAttachUiOnly({ ok: true, restart_required: true }), {
        attach: false,
        reason: 'restart_required',
    });
    assert.deepEqual(canAttachUiOnly({ ok: false }), { attach: false, reason: 'not_ready' });
});

test('boot keeps trust proxy disabled and sets lan_ready only with LAN addresses', async () => {
    const httpPort = await reserveFreePort('127.0.0.1');
    const httpsPort = await reserveFreePort('127.0.0.1');
    runIsolated(`
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-sec-net-trust-'));
  process.env.TGP_DATA_DIR = dataDir;
  process.env.TGP_PORT = ${JSON.stringify(String(httpPort))};
  process.env.TGP_HTTPS_PORT = ${JSON.stringify(String(httpsPort))};
  process.env.TGP_HTTPS = '1';
  process.env.TGP_ALLOW_LAN_CLIENTS = '1';
  process.env.TGP_BIND_HOST = '0.0.0.0';

  const { startAppServer } = require(path.join(appRoot, 'src/lib/app-boot.cjs'));
  const boot = await startAppServer({ appRoot });
  try {
    assert.equal(boot.trustProxy, false);
    assert.equal(boot.networkConfig.https_active, true);
    const expectLanReady = !!(
      boot.networkConfig.https_active
      && boot.networkConfig.allow_lan_clients
      && (boot.networkConfig.lan_addresses || []).length > 0
    );
    assert.equal(boot.networkConfig.lan_ready, expectLanReady);
    if (!expectLanReady) {
      assert.equal(
        boot.networkConfig.public_https_base_url,
        'https://127.0.0.1:' + boot.networkConfig.https_port,
      );
    } else {
      assert.match(boot.networkConfig.public_https_base_url, /^https:\\/\\//);
      assert.ok(!boot.networkConfig.public_https_base_url.includes('127.0.0.1'));
    }
  } finally {
    await boot.close();
  }
`);
});

test('adapter enumeration throw during config does not crash startup path', () => {
    const { buildNetworkConfig } = require('../src/lib/network-config.cjs');
    assert.doesNotThrow(() => {
        const cfg = buildNetworkConfig({ Allow_LAN_Clients: '1' }, {}, {
            networkInterfaces: () => { throw new Error('enum fail'); },
        });
        assert.deepEqual(cfg.lan_addresses, []);
        assert.equal(cfg.http_bind_host, '127.0.0.1');
        assert.ok(cfg.warnings.some((w) => /enumeration failed/i.test(w)));
    });
});

test('desktop boot gate blocks createWindow when attach/serve did not succeed', () => {
    const { shouldOpenDesktopUi } = require('../src/lib/desktop-boot-gate.cjs');
    assert.equal(shouldOpenDesktopUi({ openUi: true }), true);
    assert.equal(shouldOpenDesktopUi({ openUi: false }), false);
    assert.equal(shouldOpenDesktopUi({ startedServer: true, openUi: false }), false);
    assert.equal(shouldOpenDesktopUi({ uiOnlyMode: true, openUi: false }), false);
    assert.equal(shouldOpenDesktopUi({ startedServer: true }), true);
    assert.equal(shouldOpenDesktopUi({ uiOnlyMode: true }), true);
    assert.equal(shouldOpenDesktopUi({ startedServer: false, uiOnlyMode: false }), false);

    // Source contract: main must gate createWindow on the openUi decision (no Electron GUI).
    const mainSrc = fs.readFileSync(path.join(appRoot, 'main.cjs'), 'utf8');
    assert.match(mainSrc, /shouldOpenDesktopUi/);
    assert.match(mainSrc, /openUi:\s*false/);
    assert.match(mainSrc, /const processLock = acquireProcessLock\(\)/);
    assert.match(mainSrc, /processLock\.ok[\s\S]*?tryAttachUiOnly/);
    assert.match(mainSrc, /if \(ownsProcessLock\) releaseProcessLock\(\)/);
    assert.match(
        mainSrc,
        /if\s*\(\s*!openUi\s*\)\s*return;[\s\S]*?createWindow\s*\(\s*\)\s*;/,
        'createWindow call must follow the openUi gate in whenReady',
    );
});
