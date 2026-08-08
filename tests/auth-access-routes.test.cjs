'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const authFactory = require('../src/auth.cjs');
const registerApi = require('../src/api.cjs');
const { registerMaintenanceRoutes } = require('../src/routes/manager/maintenance.cjs');

function requireSqlite(t) {
    try {
        return require('better-sqlite3');
    } catch (error) {
        t.skip(`better-sqlite3 is not loadable in this runtime: ${error.message || error}`);
        return null;
    }
}

function makeFixture(t, role) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    const conn = new Database(':memory:');
    conn.exec(`
        CREATE TABLE staff (
            id INTEGER PRIMARY KEY, name TEXT UNIQUE, role TEXT, pin TEXT,
            pin_hashed INTEGER DEFAULT 0, permissions TEXT DEFAULT '',
            active INTEGER DEFAULT 1, app_access INTEGER DEFAULT 1
        );
        CREATE TABLE auth_attempts (
            staff_name TEXT PRIMARY KEY, fail_count INTEGER DEFAULT 0,
            first_fail_at TEXT, locked_until TEXT
        );
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        CREATE TABLE homebase_audits (
            id INTEGER PRIMARY KEY, zone_name TEXT, timestamp TEXT, audit_data TEXT
        );
        CREATE TABLE audit_ledger (
            id TEXT PRIMARY KEY, timestamp TEXT, user TEXT,
            action_type TEXT, target_table TEXT, details TEXT
        );
    `);
    conn.prepare(`
        INSERT INTO staff (id, name, role, pin, pin_hashed, active, app_access)
        VALUES (1, ?, ?, ?, 1, 1, 0)
    `).run(role.toUpperCase(), role, bcrypt.hashSync('2468', 4));
    conn.prepare("INSERT INTO settings VALUES ('Critical_Alert', '0')").run();

    const db = {
        all: (sql, ...params) => conn.prepare(sql).all(...params),
        get: (sql, ...params) => conn.prepare(sql).get(...params),
        run: (sql, ...params) => conn.prepare(sql).run(...params),
        exec: (sql) => conn.exec(sql),
        transaction: (fn) => conn.transaction(fn),
        findStaffByName: (name) => conn.prepare('SELECT * FROM staff WHERE name = ?').get(name),
        upsertAudit: () => {},
    };
    t.after(() => conn.close());
    return { db, name: role.toUpperCase() };
}

function makeServer() {
    const routes = new Map();
    const server = { use() {} };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        server[method] = (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler);
    }
    return { server, routes };
}

function makeResponse() {
    return {
        statusCode: 200,
        body: null,
        headersSent: false,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; this.headersSent = true; return this; },
        send(body) { this.body = body; this.headersSent = true; return this; },
        setHeader() {},
    };
}

async function request(routes, key, body) {
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

test('mobile auth makes unknown account and wrong PIN responses indistinguishable', async (t) => {
    const fixture = makeFixture(t, 'Manager');
    if (!fixture) return;
    const { db, name } = fixture;
    db.run('UPDATE staff SET app_access = 1 WHERE name = ?', name);
    const auth = authFactory(db);
    const { server, routes } = makeServer();
    registerApi(
        server,
        db,
        auth,
        () => {},
        () => '2026-08-03',
        () => 'Monday',
        () => ({ storeTimezone: 'America/Edmonton' }),
    );

    const unknown = await request(routes, 'POST /api/mobile-auth', {
        name: 'DOES NOT EXIST',
        pin: '9999',
    });
    const wrongPin = await request(routes, 'POST /api/mobile-auth', {
        name,
        pin: '9999',
    });

    assert.equal(unknown.statusCode, 403);
    assert.equal(wrongPin.statusCode, 403);
    assert.deepEqual(
        { error: unknown.body.error, code: unknown.body.code },
        { error: 'Invalid credentials.', code: 'INVALID_CREDENTIALS' },
    );
    assert.deepEqual(
        { error: wrongPin.body.error, code: wrongPin.body.code },
        { error: unknown.body.error, code: unknown.body.code },
    );
    assert.deepEqual(Object.keys(wrongPin.body).sort(), Object.keys(unknown.body).sort());
});

test('mobile auth rejects a malformed active training identity even when its setting is enabled', async (t) => {
    const fixture = makeFixture(t, 'Manager');
    if (!fixture) return;
    const { db, name } = fixture;
    db.run('DELETE FROM staff WHERE name = ?', name);
    db.run(
        `INSERT INTO staff (id, name, role, pin, pin_hashed, active, app_access)
         VALUES (9, '  training mode  ', ' manager ', '2468', 0, 1, 1)`,
    );
    db.run(
        `INSERT INTO settings (setting_name, setting_value) VALUES ('Training_Mode_Enabled', '1')
         ON CONFLICT(setting_name) DO UPDATE SET setting_value='1'`,
    );
    const auth = authFactory(db);
    const { server, routes } = makeServer();
    registerApi(
        server,
        db,
        auth,
        () => {},
        () => '2026-08-03',
        () => 'Monday',
        () => ({ storeTimezone: 'America/Edmonton' }),
    );

    const res = await request(routes, 'POST /api/mobile-auth', {
        name: '  training mode  ',
        pin: '2468',
    });

    assert.equal(res.statusCode, 403);
    assert.equal(Object.hasOwn(res.body, 'token'), false);
});

test('unknown and wrong-hash mobile auth both perform bcrypt work', async (t) => {
    const fixture = makeFixture(t, 'Manager');
    if (!fixture) return;
    const { db, name } = fixture;
    db.run('UPDATE staff SET app_access = 1 WHERE name = ?', name);
    const auth = authFactory(db);
    const { server, routes } = makeServer();
    registerApi(
        server,
        db,
        auth,
        () => {},
        () => '2026-08-03',
        () => 'Monday',
        () => ({ storeTimezone: 'America/Edmonton' }),
    );
    const originalCompare = bcrypt.compare;
    const compared = [];
    bcrypt.compare = async (input, hash) => {
        compared.push({ input, hash });
        return false;
    };
    t.after(() => { bcrypt.compare = originalCompare; });

    await request(routes, 'POST /api/mobile-auth', { name: 'UNKNOWN', pin: '9999' });
    const unknownCalls = compared.length;
    await request(routes, 'POST /api/mobile-auth', { name, pin: '9999' });
    const wrongHashCalls = compared.length - unknownCalls;

    assert.equal(unknownCalls, 1);
    assert.equal(wrongHashCalls, 1);
});

test('mobile auth rechecks access after asynchronous bcrypt comparison', async (t) => {
    const fixture = makeFixture(t, 'Manager');
    if (!fixture) return;
    const { db, name } = fixture;
    db.run('UPDATE staff SET app_access = 1 WHERE name = ?', name);
    const auth = authFactory(db);
    const { server, routes } = makeServer();
    registerApi(
        server,
        db,
        auth,
        () => {},
        () => '2026-08-03',
        () => 'Monday',
        () => ({ storeTimezone: 'America/Edmonton' }),
    );
    const originalCompare = bcrypt.compare;
    bcrypt.compare = async () => {
        db.run('UPDATE staff SET app_access = 0 WHERE name = ?', name);
        return true;
    };
    t.after(() => { bcrypt.compare = originalCompare; });

    const response = await request(routes, 'POST /api/mobile-auth', { name, pin: '2468' });
    assert.equal(response.statusCode, 403);
    assert.equal(response.body.code, 'ACCOUNT_ACCESS_REVOKED');
    assert.equal(db.get('SELECT COUNT(*) AS count FROM sessions').count, 0);
});

for (const role of ['Manager', 'Store Manager']) {
    test(`${role} with revoked app access is denied by auth and PIN-only routes without mutation`, async (t) => {
        const fixture = makeFixture(t, role);
        if (!fixture) return;
        const { db, name } = fixture;
        const auth = authFactory(db);
        const { server, routes } = makeServer();

        registerApi(
            server,
            db,
            auth,
            () => {},
            () => '2026-08-03',
            () => 'Monday',
            () => ({ storeTimezone: 'America/Edmonton' }),
        );

        const credentials = { name, pin: '2468' };
        const mobile = await request(routes, 'POST /api/mobile-auth', credentials);
        assert.equal(mobile.statusCode, 403);
        assert.equal(mobile.body.code, 'ACCOUNT_ACCESS_REVOKED');

        const setting = await request(routes, 'POST /api/action', {
            table: 'settings',
            action: 'update',
            id_col: 'setting_name',
            id_val: 'Critical_Alert',
            data: { setting_value: '1' },
            userContext: credentials,
        });
        assert.equal(setting.statusCode, 403);
        assert.equal(setting.body.code, 'ACCOUNT_ACCESS_REVOKED');
        assert.equal(db.get("SELECT setting_value FROM settings WHERE setting_name='Critical_Alert'").setting_value, '0');

        const maintenance = makeServer();
        let rhythmRuns = 0;
        registerMaintenanceRoutes(maintenance.server, {
            db,
            auth,
            broadcastUpdate: () => {},
            executeEODSweep: () => {},
            executeDailyRhythm: () => {
                rhythmRuns += 1;
                return { success: true };
            },
            requireSession: () => null,
            fail: (res, status, error, code = null) => res.status(status).json({
                error,
                ...(code ? { code } : {}),
            }),
            wrap: (fn) => async (req, res) => fn(req, res),
        });
        const daily = await request(maintenance.routes, 'POST /api/daily-rhythm', { userContext: credentials });
        assert.equal(daily.statusCode, 403);
        assert.equal(daily.body.code, 'ACCOUNT_ACCESS_REVOKED');
        assert.equal(rhythmRuns, 0);
    });
}
