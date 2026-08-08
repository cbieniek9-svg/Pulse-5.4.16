'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { crc32, makeZip, buildHistoryExportZip } = require('../src/lib/history-export.cjs');
const { registerMaintenanceRoutes } = require('../src/routes/manager/maintenance.cjs');
const { getDbPath } = require('../src/paths.cjs');

function tempDir(prefix = 'tgp-history-export-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stubDb() {
    return {
        all: () => [],
        get: () => null,
        exec: () => {},
    };
}

function makeServer() {
    const routes = new Map();
    const server = { use() {} };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        server[method] = (routePath, handler) => routes.set(`${method.toUpperCase()} ${routePath}`, handler);
    }
    return { server, routes };
}

function makeResponse() {
    return {
        statusCode: 200,
        body: null,
        headersSent: false,
        downloadPath: null,
        downloadName: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
        setHeader(k, v) { this.headers[k] = v; },
        download(filePath, filename) {
            this.downloadPath = filePath;
            this.downloadName = filename;
            this.headersSent = true;
            return this;
        },
    };
}

async function invoke(routes, key, body = {}) {
    const res = makeResponse();
    await routes.get(key)({
        body,
        headers: {},
        method: key.split(' ')[0],
        url: key.split(' ')[1],
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
    }, res);
    return res;
}

test('crc32 matches known value', () => {
    assert.equal(crc32(Buffer.from('hello')), 0x3610a686);
});

test('makeZip creates a readable ZIP-shaped buffer', () => {
    const zip = makeZip([{ name: 'hello.txt', data: 'hello' }]);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.ok(zip.includes(Buffer.from('hello.txt')));
    assert.ok(zip.includes(Buffer.from('hello')));
});

test('history export fails when ops artifact cannot be verified', async () => {
    await assert.rejects(
        () => buildHistoryExportZip(stubDb(), {
            createBackupPackage: async () => ({
                ok: false,
                error: 'ops database verification failed',
                code: 'BACKUP_VERIFICATION_FAILED',
            }),
        }),
        /BACKUP_VERIFICATION_FAILED/,
    );
});

test('history export includes verified package ops and sidecars', async () => {
    const root = tempDir();
    const dir = path.join(root, 'pkg_history_export');
    fs.mkdirSync(dir, { recursive: true });
    const opsBytes = Buffer.from('VERIFIED_OPS_BYTES_UNIQUE');
    const invBytes = Buffer.from('VERIFIED_INV_BYTES_UNIQUE');
    const opsPath = path.join(dir, 'tgp_ops.db');
    const invPath = path.join(dir, 'pulse_inventory.db');
    fs.writeFileSync(opsPath, opsBytes);
    fs.writeFileSync(invPath, invBytes);
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ packageId: 'pkg_test' }, null, 2)}\n`);

    const livePath = path.join(root, 'live-should-not-appear.db');
    fs.writeFileSync(livePath, Buffer.from('LIVE_DB_SHOULD_NOT_APPEAR'));

    const result = await buildHistoryExportZip(stubDb(), {
        dbPath: livePath,
        now: new Date('2026-08-04T12:00:00.000Z'),
        createBackupPackage: async () => ({
            ok: true,
            opsDbPath: opsPath,
            directory: dir,
            labelDate: '2026-08-04',
            manifest: {
                artifacts: [
                    { role: 'ops_db', path: 'tgp_ops.db' },
                    { role: 'inventory_db', path: 'pulse_inventory.db' },
                ],
            },
        }),
    });

    assert.ok(result.entries.includes('database/tgp_ops.db'));
    assert.ok(result.buffer.includes(opsBytes));
    assert.ok(
        result.entries.includes('database/pulse_inventory.db')
        || result.entries.includes('package/pulse_inventory.db'),
    );
    assert.ok(result.buffer.includes(invBytes));
    assert.equal(result.buffer.includes(Buffer.from('LIVE_DB_SHOULD_NOT_APPEAR')), false);
});

test('backup-db route serves verified package ops copy not live path', async () => {
    const dir = tempDir();
    const opsPath = path.join(dir, 'pkg_manual', 'tgp_ops.db');
    fs.mkdirSync(path.dirname(opsPath), { recursive: true });
    fs.writeFileSync(opsPath, Buffer.from('verified-package-ops'));

    const { server, routes } = makeServer();
    let createArgs = null;
    registerMaintenanceRoutes(server, {
        db: {
            all: () => [],
            get: () => null,
            run: () => {},
            upsertAudit: () => {},
        },
        broadcastUpdate: () => {},
        executeEODSweep: () => {},
        executeDailyRhythm: () => ({ success: true }),
        requireSession: () => ({ name: 'MANAGER', role: 'Manager' }),
        fail: (res, status, error, code = null) => res.status(status).json({
            error,
            ...(code ? { code } : {}),
        }),
        wrap: (fn) => async (req, res) => fn(req, res),
        getDataRoot: () => dir,
        createBackupPackage: async (args) => {
            createArgs = args;
            return {
                ok: true,
                opsDbPath: opsPath,
                directory: path.dirname(opsPath),
                labelDate: '2026-08-04',
                manifest: { stage: 'manual' },
                error: null,
                code: null,
            };
        },
    });

    const res = await invoke(routes, 'POST /api/backup-db', { token: 't' });
    assert.equal(res.statusCode, 200);
    assert.equal(createArgs?.stage, 'manual');
    assert.ok(res.downloadPath);
    assert.notEqual(path.resolve(res.downloadPath), path.resolve(getDbPath()));
    assert.equal(path.resolve(res.downloadPath), path.resolve(opsPath));
    assert.match(String(res.downloadName || ''), /^TGP_Backup_2026-08-04\.db$/);
});

test('backup-db route fails closed when package verification fails', async () => {
    const { server, routes } = makeServer();
    registerMaintenanceRoutes(server, {
        db: {
            all: () => [],
            get: () => null,
            run: () => {},
            upsertAudit: () => {},
        },
        broadcastUpdate: () => {},
        executeEODSweep: () => {},
        executeDailyRhythm: () => ({ success: true }),
        requireSession: () => ({ name: 'MANAGER', role: 'Manager' }),
        fail: (res, status, error, code = null) => res.status(status).json({
            error,
            ...(code ? { code } : {}),
        }),
        wrap: (fn) => async (req, res) => fn(req, res),
        getDataRoot: () => tempDir(),
        createBackupPackage: async () => ({
            ok: false,
            error: 'ops database verification failed',
            code: 'BACKUP_VERIFICATION_FAILED',
        }),
    });

    const res = await invoke(routes, 'POST /api/backup-db', { token: 't' });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body?.code, 'BACKUP_VERIFICATION_FAILED');
    assert.equal(res.downloadPath, null);
});
