'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { registerActionRoutes } = require('../src/routes/action.cjs');
const { createActionHandlers } = require('../src/actions/handlers.cjs');

function createSqliteDb() {
    const Database = require('better-sqlite3');
    const sqlite = new Database(':memory:');
    sqlite.exec(`
        CREATE TABLE staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            active INTEGER DEFAULT 1,
            pin TEXT DEFAULT '',
            app_access INTEGER DEFAULT 1,
            role TEXT DEFAULT 'Clerk',
            pin_hashed INTEGER DEFAULT 0,
            permissions TEXT DEFAULT '',
            shift_lead_eligible INTEGER DEFAULT 1
        );
        CREATE TABLE kill_dates (
            id TEXT PRIMARY KEY,
            item TEXT,
            status TEXT,
            logged_by TEXT,
            time_logged TEXT
        );
        CREATE TABLE audit_ledger (
            id TEXT PRIMARY KEY,
            user TEXT,
            action_type TEXT,
            target_table TEXT,
            details TEXT,
            timestamp TEXT
        );
        CREATE TABLE manager_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT,
            actor_staff_id INTEGER,
            actor_name TEXT,
            action TEXT,
            target_type TEXT,
            target_id TEXT,
            summary TEXT,
            metadata_json TEXT,
            ip_address TEXT,
            user_agent TEXT,
            source_event_id TEXT DEFAULT ''
        );
        CREATE UNIQUE INDEX idx_manager_audit_source_event
            ON manager_audit_log(source_event_id) WHERE source_event_id != '';
    `);
    const db = {
        sqlite,
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run: (sql, ...params) => sqlite.prepare(sql).run(...params),
        exec: (sql) => sqlite.exec(sql),
        transaction: (fn) => sqlite.transaction(fn),
        upsertAudit(id, timestamp, actor, action, table, detail) {
            sqlite.prepare(
                `INSERT INTO audit_ledger (id, user, action_type, target_table, details, timestamp)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(id, actor, action, table, detail, timestamp);
        },
    };
    return db;
}

async function createRouteServer({
    db,
    actionHandlers,
    sessions = new Map([['manager-session', {
        staff_id: 1,
        name: 'TEST MANAGER',
        role: 'Manager',
    }]]),
}) {
    const auth = {
        getSession(token) {
            return sessions.get(token) || null;
        },
        async resolveActionActor({ token }) {
            return sessions.get(token)?.name || null;
        },
        destroySessionsForStaff() {},
    };
    const fail = (res, status, message, code = null) => res.status(status).json({
        error: message,
        ...(code ? { code } : {}),
    });
    const wrap = (fn) => async (req, res) => {
        try {
            await fn(req, res);
        } catch (error) {
            if (!res.headersSent) fail(res, error.status || 500, error.message, error.code);
        }
    };
    const app = express();
    app.use(express.json());
    registerActionRoutes(app, {
        wrap,
        fail,
        db,
        auth,
        actionHandlers,
        checkSettingPermission: async () => true,
    });
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    return {
        async post(body, headers = {}) {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/api/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(body),
            });
            return { status: response.status, body: await response.json() };
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

function staffInsert(name, pin) {
    return {
        table: 'staff',
        action: 'insert',
        data: {
            name,
            pin,
            active: 1,
            app_access: 1,
            role: 'Clerk',
            permissions: 'tasks',
        },
    };
}

test('staff PINs and hashes stay out of broadcasts, audits, logs, and responses', async (t) => {
    const db = createSqliteDb();
    t.after(() => db.sqlite.close());
    const broadcasts = [];
    const eventOrder = [];
    const actionHandlers = createActionHandlers({
        db,
        broadcastUpdate(payload) {
            eventOrder.push('broadcast');
            broadcasts.push(payload);
        },
    });
    const originalUpsertAudit = db.upsertAudit;
    db.upsertAudit = (...args) => {
        eventOrder.push('audit');
        return originalUpsertAudit(...args);
    };
    const route = await createRouteServer({ db, actionHandlers });
    t.after(() => route.close());

    const rawInsertPin = 'DISTINCTIVE-INSERT-PIN-5.4.11';
    const rawUpdatePin = 'DISTINCTIVE-UPDATE-PIN-5.4.11';
    const logs = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args) => logs.push(args.map(String).join(' '));
    console.warn = (...args) => logs.push(args.map(String).join(' '));
    t.after(() => {
        console.error = originalError;
        console.warn = originalWarn;
    });

    const inserted = await route.post(
        staffInsert('PIN SAFETY CLERK', rawInsertPin),
        { 'x-session-token': 'manager-session' },
    );
    assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
    const staff = db.get("SELECT id, pin, pin_hashed FROM staff WHERE name='PIN SAFETY CLERK'");
    assert.equal(staff.pin_hashed, 1);
    assert.notEqual(staff.pin, rawInsertPin);
    const insertHash = staff.pin;

    const updated = await route.post({
        table: 'staff',
        action: 'update',
        id_col: 'id',
        id_val: staff.id,
        data: { pin: rawUpdatePin },
    }, { 'x-session-token': 'manager-session' });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    const updateHash = db.get('SELECT pin FROM staff WHERE id=?', staff.id).pin;
    assert.notEqual(updateHash, rawUpdatePin);
    assert.notEqual(updateHash, insertHash);

    const auditRows = {
        generic: db.all('SELECT details FROM audit_ledger ORDER BY timestamp'),
        manager: db.all('SELECT metadata_json, summary FROM manager_audit_log ORDER BY id'),
    };
    const externallyVisible = JSON.stringify({
        broadcasts,
        auditRows,
        responses: [inserted.body, updated.body],
        logs,
    });
    for (const secret of [rawInsertPin, rawUpdatePin, insertHash, updateHash]) {
        assert.equal(externallyVisible.includes(secret), false, `leaked ${secret}`);
    }
    for (const broadcast of broadcasts) {
        assert.equal(Object.hasOwn(broadcast.data || {}, 'pin'), false);
        assert.equal(Object.hasOwn(broadcast.data || {}, 'pin_hashed'), false);
    }
    assert.deepEqual(eventOrder, ['audit', 'broadcast', 'audit', 'broadcast']);
});

test('audit failure rolls back SQLite mutation and discards queued broadcast', async (t) => {
    const db = createSqliteDb();
    t.after(() => db.sqlite.close());
    const broadcasts = [];
    const actionHandlers = createActionHandlers({
        db,
        broadcastUpdate: (payload) => broadcasts.push(payload),
    });
    db.upsertAudit = () => {
        throw new Error('injected audit storage failure');
    };
    const route = await createRouteServer({ db, actionHandlers });
    t.after(() => route.close());

    const result = await route.post(
        staffInsert('ROLLBACK CLERK', 'ROLLBACK-PIN'),
        { 'x-session-token': 'manager-session' },
    );
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'ACTION_FAILED');
    assert.equal(result.body.error, 'Action failed.');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM staff WHERE name='ROLLBACK CLERK'").n, 0);
    assert.deepEqual(broadcasts, []);
});

test('Promise-returning handlers are rejected and their SQLite writes roll back', async (t) => {
    const db = createSqliteDb();
    t.after(() => db.sqlite.close());
    const actionHandlers = createActionHandlers({ db, broadcastUpdate() {} });
    actionHandlers.kill_dates_insert = ({ workingData }) => {
        db.run(
            'INSERT INTO kill_dates (id, item, status, logged_by, time_logged) VALUES (?, ?, ?, ?, ?)',
            workingData.id,
            workingData.item,
            workingData.status,
            workingData.logged_by,
            workingData.time_logged,
        );
        return Promise.resolve();
    };
    const route = await createRouteServer({ db, actionHandlers });
    t.after(() => route.close());

    const result = await route.post({
        table: 'kill_dates',
        action: 'insert',
        data: { id: 'ASYNC-1', item: 'ASYNC ITEM', status: 'Active' },
    }, { 'x-session-token': 'manager-session' });
    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'ACTION_FAILED');
    assert.equal(db.get("SELECT COUNT(*) AS n FROM kill_dates WHERE id='ASYNC-1'").n, 0);
});

test('session credentials are header-first and conflicts are rejected', async (t) => {
    const mutations = [];
    const db = {
        transaction: (fn) => (...args) => fn(...args),
        upsertAudit() {},
    };
    const handlers = {
        kill_dates_insert({ workingData }) {
            mutations.push({ ...workingData });
        },
    };
    const sessions = new Map([
        ['header-token', { name: 'HEADER USER', role: 'Clerk' }],
        ['body-token', { name: 'BODY USER', role: 'Clerk' }],
    ]);
    const route = await createRouteServer({ db, actionHandlers: handlers, sessions });
    t.after(() => route.close());
    const payload = {
        table: 'kill_dates',
        action: 'insert',
        data: { id: 'CRED-1', item: 'ITEM', status: 'Active' },
    };

    const emptyBody = await route.post(
        { ...payload, token: '' },
        { 'x-session-token': 'header-token' },
    );
    assert.equal(emptyBody.status, 200);
    assert.equal(mutations.at(-1).logged_by, 'HEADER USER');

    for (const body of [
        { ...payload, token: 'body-token' },
        { ...payload, userContext: { token: 'body-token' } },
        { ...payload, token: 'header-token', userContext: { token: 'body-token' } },
    ]) {
        const before = mutations.length;
        const conflict = await route.post(body, { 'x-session-token': 'header-token' });
        assert.equal(conflict.status, 400);
        assert.equal(conflict.body.code, 'CONFLICTING_CREDENTIALS');
        assert.equal(mutations.length, before);
    }

    const deviceConflict = await route.post(
        { ...payload, deviceToken: 'body-device-token' },
        { 'x-device-token': 'header-device-token' },
    );
    assert.equal(deviceConflict.status, 400);
    assert.equal(deviceConflict.body.code, 'CONFLICTING_CREDENTIALS');
});

test('internal and SQLite errors are sanitized while known domain errors remain explicit', async (t) => {
    const db = {
        transaction: (fn) => (...args) => fn(...args),
        upsertAudit() {},
    };
    let mode = 'internal';
    const handlers = {
        kill_dates_insert() {
            if (mode === 'constraint') {
                const error = new Error('UNIQUE constraint failed: staff.pin DISTINCTIVE-SQL');
                error.code = 'SQLITE_CONSTRAINT_UNIQUE';
                throw error;
            }
            if (mode === 'domain') {
                const error = new Error('Record not found.');
                error.status = 404;
                error.code = 'RECORD_NOT_FOUND';
                throw error;
            }
            throw new Error('filesystem /secret/path and DISTINCTIVE-INTERNAL');
        },
    };
    const route = await createRouteServer({ db, actionHandlers: handlers });
    t.after(() => route.close());
    const payload = {
        table: 'kill_dates',
        action: 'insert',
        data: { id: 'ERR-1', item: 'ITEM', status: 'Active' },
    };

    const internal = await route.post(payload, { 'x-session-token': 'manager-session' });
    assert.deepEqual(
        { status: internal.status, error: internal.body.error, code: internal.body.code },
        { status: 500, error: 'Action failed.', code: 'ACTION_FAILED' },
    );
    assert.doesNotMatch(JSON.stringify(internal.body), /secret|DISTINCTIVE/);

    mode = 'constraint';
    const conflict = await route.post(payload, { 'x-session-token': 'manager-session' });
    assert.deepEqual(
        { status: conflict.status, error: conflict.body.error, code: conflict.body.code },
        { status: 409, error: 'Action conflicts with an existing record.', code: 'ACTION_CONFLICT' },
    );
    assert.doesNotMatch(JSON.stringify(conflict.body), /staff\.pin|DISTINCTIVE/);

    mode = 'domain';
    const domain = await route.post(payload, { 'x-session-token': 'manager-session' });
    assert.deepEqual(
        { status: domain.status, error: domain.body.error, code: domain.body.code },
        { status: 404, error: 'Record not found.', code: 'RECORD_NOT_FOUND' },
    );
});
