'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const authFactory = require('../src/auth.cjs');

function sqliteReady(t) {
    try {
        // The native binding only loads on construction, so requiring alone proves nothing.
        // better-sqlite3 is built against Electron's ABI; under plain node this throws.
        new (require('better-sqlite3'))(':memory:').close();
        return true;
    } catch (e) {
        t.skip(`better-sqlite3 is not loadable in this environment: ${e.message || e}`);
        return false;
    }
}

/** Minimal db wrapper matching the shape src/db.cjs exposes to the auth factory. */
function makeDb() {
    const Database = require('better-sqlite3');
    const conn = new Database(':memory:');
    conn.exec(`
        CREATE TABLE staff (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT '',
            pin TEXT DEFAULT '',
            pin_hashed INTEGER DEFAULT 0,
            permissions TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            app_access INTEGER DEFAULT 1
        );
        CREATE TABLE auth_attempts (
            staff_name TEXT PRIMARY KEY,
            fail_count INTEGER DEFAULT 0,
            first_fail_at TEXT,
            locked_until TEXT
        );
    `);
    return {
        _conn: conn,
        all: (sql, ...p) => conn.prepare(sql).all(...p),
        get: (sql, ...p) => conn.prepare(sql).get(...p),
        run: (sql, ...p) => conn.prepare(sql).run(...p),
        exec: (sql) => conn.exec(sql),
        transaction: (fn) => conn.transaction(fn),
        findStaffByName: (name) => conn
            .prepare('SELECT name, role, pin, pin_hashed, permissions, active, app_access FROM staff WHERE name = ?')
            .get(name),
    };
}

function addStaff(db, {
    id, name, role = 'Clerk', active = 1, app_access = 1, pin = '',
}) {
    db.run(
        'INSERT INTO staff (id, name, role, active, app_access, pin) VALUES (?, ?, ?, ?, ?, ?)',
        id, name, role, active, app_access, pin,
    );
    return { id, name, role };
}

test('session survives a new auth instance built over the same database', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const user = addStaff(db, { id: 1, name: 'ASHLEY', role: 'Manager' });

    const before = authFactory(db);
    const token = before.createSession(user);
    assert.equal(before.getSession(token).name, 'ASHLEY');

    // A service restart rebuilds the auth module; the token must still resolve.
    const after = authFactory(db);
    const session = after.getSession(token);
    assert.ok(session, 'session should outlive the restart');
    assert.equal(session.name, 'ASHLEY');
    assert.equal(session.role, 'Manager');
    assert.equal(session.staff_id, 1);
});

test('an action actor resolves from a token that predates the restart', async (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const user = addStaff(db, { id: 7, name: 'ASHLEY', role: 'Manager' });

    const token = authFactory(db).createSession(user);
    const after = authFactory(db);

    const actor = await after.resolveActionActor({
        token, userContext: null, table: 'counts', action: 'update', data: { hardware: 42 },
    });
    assert.equal(actor, 'ASHLEY', 'piece-count update should still be attributed after a restart');
});

test('station display names never resolve as action credentials', async (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);
    const attempts = [
        ['CS_DESK', 'special_orders', 'insert'],
        ['RECEIVING_STATION', 'expected_orders', 'receiving_mark_arrived'],
        ['MARKDOWN_STATION', 'kill_dates', 'insert'],
    ];
    for (const [name, table, action] of attempts) {
        assert.equal(
            await a.resolveActionActor({
                userContext: { name, pin: '' },
                table,
                action,
                data: {},
            }),
            null,
            name,
        );
    }
});

test('role changes take effect on the next request without re-login', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const user = addStaff(db, { id: 2, name: 'JORDAN', role: 'Clerk' });
    const a = authFactory(db);
    const token = a.createSession(user);
    assert.equal(a.getSession(token).role, 'Clerk');

    db.run("UPDATE staff SET role = 'Manager' WHERE id = 2");
    assert.equal(a.getSession(token).role, 'Manager', 'promotion should apply immediately');

    db.run("UPDATE staff SET role = 'Clerk' WHERE id = 2");
    assert.equal(a.getSession(token).role, 'Clerk', 'demotion should apply immediately');
});

test('deactivating or revoking app access kills the session', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);

    const deactivated = a.createSession(addStaff(db, { id: 3, name: 'PAT' }));
    db.run('UPDATE staff SET active = 0 WHERE id = 3');
    assert.equal(a.getSession(deactivated), null);

    const revoked = a.createSession(addStaff(db, { id: 4, name: 'SAM' }));
    db.run('UPDATE staff SET app_access = 0 WHERE id = 4');
    assert.equal(a.getSession(revoked), null);

    const deleted = a.createSession(addStaff(db, { id: 5, name: 'ALEX' }));
    db.run('DELETE FROM staff WHERE id = 5');
    assert.equal(a.getSession(deleted), null);
});

test('manager credential verification rejects a malformed active training identity', async (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    addStaff(db, {
        id: 90,
        name: '  training mode  ',
        role: ' manager ',
        active: 1,
        app_access: 1,
        pin: '2468',
    });
    addStaff(db, {
        id: 91,
        name: 'LOWER MANAGER',
        role: ' manager ',
        active: 1,
        app_access: 1,
        pin: '1357',
    });
    const a = authFactory(db);

    assert.equal(
        await a.isAuthorizedManager({ name: 'LOWER MANAGER', pin: '1357' }),
        true,
    );
    assert.equal(
        await a.isAuthorizedManager({ name: '  training mode  ', pin: '2468' }),
        false,
    );
});

test('session lookup requires active and app_access to normalize exactly to one', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);

    const allowed = a.createSession(addStaff(db, {
        id: 20, name: 'STRING FLAGS', active: '1', app_access: '1',
    }));
    assert.ok(a.getSession(allowed), 'numeric string flags should normalize to enabled');

    for (const [id, name, active, appAccess] of [
        [21, 'NULL ACTIVE', null, 1],
        [22, 'ODD ACTIVE', 2, 1],
        [23, 'NULL ACCESS', 1, null],
        [24, 'ODD ACCESS', 1, 2],
    ]) {
        const token = a.createSession(addStaff(db, {
            id, name, active, app_access: appAccess,
        }));
        assert.equal(a.getSession(token), null, `${name} must be revoked on next lookup`);
    }
});

for (const role of ['Manager', 'Store Manager']) {
    test(`${role} PIN authorization observes app-access revocation on the next attempt`, async (t) => {
        if (!sqliteReady(t)) return;
        const db = makeDb();
        addStaff(db, {
            id: role === 'Manager' ? 30 : 31,
            name: role.toUpperCase(),
            role,
            active: 1,
            app_access: 1,
            pin: '2468',
        });
        const a = authFactory(db);
        const credentials = { name: role.toUpperCase(), pin: '2468' };

        assert.equal(await a.isAuthorizedManager(credentials), true);
        db.run('UPDATE staff SET app_access = 0 WHERE name = ?', role.toUpperCase());

        assert.equal(
            await a.isAuthorizedManager(credentials),
            false,
        );
        await assert.rejects(
            a.resolveActionActor({
                userContext: credentials,
                table: 'settings',
                action: 'update',
                data: {},
            }),
            (error) => error.status === 403 && error.code === 'ACCOUNT_ACCESS_REVOKED',
        );
    });
}

test('TRAINING MODE identity cannot bypass manager role requirements', async (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    addStaff(db, {
        id: 32,
        name: 'TRAINING MODE',
        role: 'Clerk',
        active: 1,
        app_access: 1,
        pin: '2468',
    });

    assert.equal(
        await authFactory(db).isAuthorizedManager({ name: 'TRAINING MODE', pin: '2468' }),
        false,
    );
});

test('manager PIN success rechecks access after asynchronous bcrypt comparison', async (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const bcrypt = require('bcryptjs');
    const originalCompare = bcrypt.compare;
    addStaff(db, {
        id: 33,
        name: 'RACING MANAGER',
        role: 'Manager',
        active: 1,
        app_access: 1,
        pin: bcrypt.hashSync('2468', 4),
    });
    db.run("UPDATE staff SET pin_hashed = 1 WHERE name = 'RACING MANAGER'");
    bcrypt.compare = async () => {
        db.run("UPDATE staff SET app_access = 0 WHERE name = 'RACING MANAGER'");
        return true;
    };
    t.after(() => { bcrypt.compare = originalCompare; });

    assert.equal(
        await authFactory(db).isAuthorizedManager({ name: 'RACING MANAGER', pin: '2468' }),
        false,
    );
});

for (const source of ['env', 'file']) {
    test(`PC_ADMIN rejects legacy 1234 from ${source}`, async (t) => {
        if (!sqliteReady(t)) return;
        const db = makeDb();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tgp-admin-${source}-`));
        const previousDataDir = process.env.TGP_DATA_DIR;
        const previousPin = process.env.PC_ADMIN_PIN;
        t.after(() => {
            if (previousDataDir == null) delete process.env.TGP_DATA_DIR;
            else process.env.TGP_DATA_DIR = previousDataDir;
            if (previousPin == null) delete process.env.PC_ADMIN_PIN;
            else process.env.PC_ADMIN_PIN = previousPin;
            fs.rmSync(dir, { recursive: true, force: true });
        });
        process.env.TGP_DATA_DIR = dir;
        if (source === 'env') process.env.PC_ADMIN_PIN = '1234';
        else {
            delete process.env.PC_ADMIN_PIN;
            fs.writeFileSync(path.join(dir, 'pc-admin-pin.txt'), '1234\n');
        }

        assert.equal(
            await authFactory(db).isAuthorizedManager({ name: 'PC_ADMIN', pin: '1234' }),
            false,
        );
    });
}

test('generated PC_ADMIN PIN authenticates only until the first active manager exists', async (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-admin-generated-'));
    const previousDataDir = process.env.TGP_DATA_DIR;
    const previousPin = process.env.PC_ADMIN_PIN;
    t.after(() => {
        if (previousDataDir == null) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = previousDataDir;
        if (previousPin == null) delete process.env.PC_ADMIN_PIN;
        else process.env.PC_ADMIN_PIN = previousPin;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    process.env.TGP_DATA_DIR = dir;
    delete process.env.PC_ADMIN_PIN;

    const a = authFactory(db);
    const pinPath = path.join(dir, 'pc-admin-pin.txt');
    const { pin } = require('../src/lib/pc-admin-pin.cjs').resolvePcAdminPin({ db, dataRoot: dir, env: {} });
    assert.match(pin, /^\d{8}$/);
    assert.notEqual(pin, '1234');
    assert.equal(await a.isAuthorizedManager({ name: 'PC_ADMIN', pin }), true);

    addStaff(db, { id: 40, name: 'FIRST MANAGER', role: 'Store Manager', active: 1, app_access: 1 });
    assert.equal(await a.isAuthorizedManager({ name: 'PC_ADMIN', pin }), false);
    assert.equal(fs.existsSync(pinPath), true, 'disabling bootstrap must not alter its secure file');
});

for (const role of ['Manager', 'Store Manager']) {
    test(`active ${role} closes PC_ADMIN even when app access is revoked`, async (t) => {
        if (!sqliteReady(t)) return;
        const db = makeDb();
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-admin-role-closure-'));
        const previousDataDir = process.env.TGP_DATA_DIR;
        const previousPin = process.env.PC_ADMIN_PIN;
        t.after(() => {
            if (previousDataDir == null) delete process.env.TGP_DATA_DIR;
            else process.env.TGP_DATA_DIR = previousDataDir;
            if (previousPin == null) delete process.env.PC_ADMIN_PIN;
            else process.env.PC_ADMIN_PIN = previousPin;
            fs.rmSync(dir, { recursive: true, force: true });
        });
        process.env.TGP_DATA_DIR = dir;
        process.env.PC_ADMIN_PIN = '87654321';
        addStaff(db, {
            id: role === 'Manager' ? 41 : 42,
            name: `CLOSING ${role.toUpperCase()}`,
            role,
            active: 1,
            app_access: 0,
        });

        const a = authFactory(db);
        assert.equal(
            await a.isAuthorizedManager({ name: 'PC_ADMIN', pin: '87654321' }),
            false,
        );
        assert.equal(
            require('../src/lib/pc-admin-pin.cjs').resolvePcAdminPin({ db }).source,
            'disabled',
        );
    });
}

test('PC_ADMIN fails closed when active-manager detection throws', async (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const get = db.get;
    db.get = (sql, ...params) => {
        if (String(sql).includes("role IN ('Manager', 'Store Manager')")) {
            throw new Error('injected manager query failure');
        }
        return get(sql, ...params);
    };
    const previousPin = process.env.PC_ADMIN_PIN;
    t.after(() => {
        if (previousPin == null) delete process.env.PC_ADMIN_PIN;
        else process.env.PC_ADMIN_PIN = previousPin;
    });
    process.env.PC_ADMIN_PIN = '87654321';

    assert.equal(
        await authFactory(db).isAuthorizedManager({ name: 'PC_ADMIN', pin: '87654321' }),
        false,
    );
});

test('destroySession revokes a token immediately', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);
    const token = a.createSession(addStaff(db, { id: 6, name: 'CHRIS', role: 'Manager' }));

    assert.ok(a.getSession(token));
    assert.equal(a.destroySession(token), true);
    assert.equal(a.getSession(token), null);
    assert.equal(a.destroySession(token), false);
});

test('destroySessionsForStaff clears every token that staff holds', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);
    const user = addStaff(db, { id: 8, name: 'DANA', role: 'Manager' });
    const phone = a.createSession(user);
    const desk = a.createSession(user);

    assert.equal(a.destroySessionsForStaff({ staffId: 8 }), 2);
    assert.equal(a.getSession(phone), null);
    assert.equal(a.getSession(desk), null);
});

test('expired sessions are dropped on lookup and by cleanup', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);
    const token = a.createSession(addStaff(db, { id: 9, name: 'MORGAN' }));

    const longAgo = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    db.run('UPDATE sessions SET last_active_at = ? WHERE token = ?', longAgo, token);

    assert.equal(a.getSession(token), null, 'idle past the timeout should not resolve');
    assert.equal(db.get('SELECT COUNT(*) AS n FROM sessions').n, 0, 'lookup should delete the row');

    const stale = a.createSession(addStaff(db, { id: 10, name: 'RILEY' }));
    db.run('UPDATE sessions SET last_active_at = ? WHERE token = ?', longAgo, stale);
    assert.equal(a.cleanupSessions(), 1);
});

test('listActiveSessions reports current users for the health panel', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);
    a.createSession(addStaff(db, { id: 11, name: 'ASHLEY', role: 'Manager' }));
    a.createSession(addStaff(db, { id: 12, name: 'JORDAN' }));

    const names = a.listActiveSessions().map((s) => s.name).sort();
    assert.deepEqual(names, ['ASHLEY', 'JORDAN']);
});

test('unknown and empty tokens never resolve', (t) => {
    if (!sqliteReady(t)) return;
    const db = makeDb();
    const a = authFactory(db);
    assert.equal(a.getSession(''), null);
    assert.equal(a.getSession(null), null);
    assert.equal(a.getSession('not-a-real-token'), null);
});
