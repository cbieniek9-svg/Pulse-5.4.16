'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    openReportsTarget,
    assembleReportsPayload,
    resolveReportWindow,
} = require('../src/dal/reports-payload.cjs');
const { registerReportsRoutes } = require('../src/routes/reports.cjs');
const { resolveBackupPath, ensureBackupsDir } = require('../src/paths.cjs');

function tempDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-backup-reports-'));
}

function withDataDir(dir, fn) {
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = dir;
    try {
        return fn();
    } finally {
        if (prev === undefined) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = prev;
    }
}

function requireBetterSqlite3(t) {
    let Database;
    try {
        Database = require('better-sqlite3');
        const probeFile = path.join(tempDataDir(), 'probe.db');
        const probe = new Database(probeFile);
        probe.close();
    } catch (e) {
        t.skip(`better-sqlite3 is not loadable in this environment: ${e.message || e}`);
        return null;
    }
    return Database;
}

function createVerifiedBackup(Database, filePath) {
    const sqlite = new Database(filePath);
    try {
        sqlite.exec(`
            CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
            INSERT INTO settings (setting_name, setting_value) VALUES ('Cases_Per_Hour', '55');
            CREATE TABLE counts (
                id INTEGER PRIMARY KEY,
                grocery REAL, frozen REAL, hardware REAL, staff REAL
            );
            INSERT INTO counts (id, grocery, frozen, hardware, staff) VALUES (1, 10, 0, 0, 1);
        `);
    } finally {
        sqlite.close();
    }
}

/** Lightweight reports DB for assemble meta checks (avoids full ops schema). */
function makeAssembleDb() {
    return {
        getSettings: () => ({ Cases_Per_Hour: '55' }),
        get(sql) {
            if (String(sql).includes('FROM counts')) {
                return { id: 1, grocery: 10, frozen: 0, hardware: 0, staff: 1 };
            }
            if (String(sql).includes('COUNT(*)')) return { c: 0 };
            if (String(sql).includes('SUM(')) return { t: 0 };
            if (String(sql).includes("date(?, '-1 day')")) return { d: '2026-06-30' };
            return {};
        },
        all() {
            return [];
        },
    };
}

function reportsRouteHarness(liveDb) {
    const routes = new Map();
    const server = {
        get(p, handler) { routes.set(`GET ${p}`, handler); },
        post(p, handler) { routes.set(`POST ${p}`, handler); },
    };
    const ctx = {
        wrap: (handler) => handler,
        fail(res, status, message, code = null) {
            res.status(status).json({ error: message, ...(code ? { code } : {}) });
        },
        requireSession() {
            return { name: 'Manager', role: 'Manager' };
        },
        db: liveDb,
        auth: {},
        getStoreDateStamp: () => '2026-08-04',
        APP_VERSION: '5.4.12',
        getStoreClockPayload: () => ({ storeWeekday: 'TUESDAY', storeTime: '10:00' }),
        getHeatMap: () => ({}),
        broadcastUpdate() {},
    };
    registerReportsRoutes(server, ctx);
    return routes;
}

function mockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test('missing backup file does not open live DB as BACKUP', () => {
    const dir = tempDataDir();
    const liveDb = { marker: 'live-db' };
    withDataDir(dir, () => {
        ensureBackupsDir();
        const opened = openReportsTarget(liveDb, 'tgp_ops_backup_2026-07-01.db');
        assert.equal(opened.ok, false);
        assert.equal(opened.code, 'BACKUP_SOURCE_UNAVAILABLE');
        assert.notEqual(opened.targetDb, liveDb);
        assert.equal(opened.targetDb, null);
        assert.notEqual(opened.reportSource, 'backup');
    });
});

test('route returns 404/400 with BACKUP_SOURCE_UNAVAILABLE', async () => {
    const dir = tempDataDir();
    const liveDb = { marker: 'live-db' };
    await withDataDir(dir, async () => {
        ensureBackupsDir();
        const routes = reportsRouteHarness(liveDb);
        const handler = routes.get('GET /api/reports');
        assert.ok(handler, 'GET /api/reports registered');
        const res = mockResponse();
        await handler(
            { query: { backup: 'tgp_ops_backup_2026-07-01.db' }, headers: {} },
            res,
        );
        assert.ok(res.statusCode === 404 || res.statusCode === 400);
        assert.equal(res.body.code, 'BACKUP_SOURCE_UNAVAILABLE');
        assert.ok(res.body.error);
    });
});

test('successful backup open sets reportSource backup only after open', (t) => {
    const Database = requireBetterSqlite3(t);
    if (!Database) return;

    const dir = tempDataDir();
    const liveDb = { marker: 'live-db' };
    withDataDir(dir, () => {
        ensureBackupsDir();
        const name = 'tgp_ops_backup_2026-07-01.db';
        createVerifiedBackup(Database, resolveBackupPath(name));

        // Filename alone must not claim BACKUP before open succeeds.
        const premature = resolveReportWindow({
            liveStoreDate: '2026-08-04',
            backupFile: name,
            reportSource: 'live',
        });
        assert.equal(premature.reportSource, 'live');

        const opened = openReportsTarget(liveDb, name);
        assert.equal(opened.ok, true);
        assert.equal(opened.reportSource, 'backup');
        assert.equal(opened.backupFile, name);
        assert.notEqual(opened.targetDb, liveDb);
        assert.ok(opened.targetDb);
        assert.equal(opened.targetDb.getSettings().Cases_Per_Hour, '55');
        opened.close();

        // Assemble chrome uses the open result — not the query string alone.
        const payload = assembleReportsPayload({
            targetDb: makeAssembleDb(),
            APP_VERSION: '5.4.12',
            liveStoreDate: '2026-08-04',
            backupFile: opened.backupFile,
            reportSource: opened.reportSource,
        });
        assert.equal(payload.meta.reportSource, 'backup');
        assert.equal(payload.meta.backupFile, name);
        assert.equal(payload.meta.reportDate, '2026-07-01');

        // Weekly naming resolves the stamp honestly once open is confirmed.
        const weekly = resolveReportWindow({
            liveStoreDate: '2026-08-04',
            backupFile: 'tgp_ops_weekly_2026-06-21.db',
            reportSource: 'backup',
        });
        assert.equal(weekly.reportSource, 'backup');
        assert.equal(weekly.reportDate, '2026-06-21');
        assert.equal(weekly.backupFile, 'tgp_ops_weekly_2026-06-21.db');
    });
});
