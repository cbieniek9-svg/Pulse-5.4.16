'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSettingsHandlers } = require('../src/actions/handlers/settings.cjs');
const { applySettingsBatch } = require('../src/lib/settings-batch.cjs');
const {
    TRAINING_STAFF_NAME,
    isTrainingStaff,
    isTrainingModeEnabled,
    isUnassignedOptionEnabled,
    ensureTrainingStaff,
} = require('../src/lib/training-staff.cjs');

function createRealDb(t) {
    let Database;
    try {
        Database = require('better-sqlite3');
        const probe = new Database(':memory:');
        probe.close();
    } catch (error) {
        const message = String(error?.message || error);
        if (message.includes('NODE_MODULE_VERSION') || message.includes('Could not locate the bindings file')) {
            t.skip(`better-sqlite3 is not loadable in this runtime: ${message}`);
            return null;
        }
        throw error;
    }
    const sqlite = new Database(':memory:');
    sqlite.exec(`
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        CREATE TABLE staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            active INTEGER,
            pin TEXT,
            app_access INTEGER,
            role TEXT,
            pin_hashed INTEGER,
            permissions TEXT
        );
        CREATE TABLE sessions (
            token TEXT PRIMARY KEY,
            staff_id INTEGER,
            name TEXT NOT NULL,
            training INTEGER NOT NULL DEFAULT 0
        );
    `);
    const db = {
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run: (sql, ...params) => sqlite.prepare(sql).run(...params),
        exec: (sql) => sqlite.exec(sql),
        transaction: (fn) => sqlite.transaction(fn),
    };
    return { db, sqlite };
}

function makeDb(settings = { Training_Mode_Enabled: '1' }) {
    const staff = new Map();
    const sessions = [];
    return {
        transaction(fn) { return () => fn(); },
        get(sql, ...params) {
            if (sql.includes('SELECT id FROM staff')) {
                return staff.has(params[0]) ? { id: staff.get(params[0]).id } : undefined;
            }
            if (sql.includes('setting_name = ?') && params[0] === 'Training_Mode_Enabled') {
                return { setting_value: settings.Training_Mode_Enabled ?? '1' };
            }
            return undefined;
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE staff') && sql.includes('active = 0')) {
                for (const [name, row] of staff) {
                    if (!isTrainingStaff(name)) continue;
                    row.active = 0;
                    row.app_access = 0;
                    row.pin = '';
                    row.pin_hashed = 0;
                }
            }
            if (sql.includes('DELETE FROM sessions')) {
                const trainingIds = new Set(
                    [...staff.entries()]
                        .filter(([name]) => isTrainingStaff(name))
                        .map(([, row]) => row.id),
                );
                for (let i = sessions.length - 1; i >= 0; i -= 1) {
                    if (
                        sessions[i].training === 1
                        || trainingIds.has(sessions[i].staff_id)
                        || isTrainingStaff(sessions[i].name)
                    ) sessions.splice(i, 1);
                }
            }
        },
        _staff: staff,
        _sessions: sessions,
    };
}

test('isTrainingStaff matches training profile name only', () => {
    assert.equal(isTrainingStaff('TRAINING MODE'), true);
    assert.equal(isTrainingStaff('training mode'), true);
    assert.equal(isTrainingStaff('Luke'), false);
});

test('missing training setting fails closed', () => {
    const db = makeDb({});
    db.get = () => undefined;
    assert.equal(isTrainingModeEnabled(db), false);
});

test('ensureTrainingStaff never creates a missing training profile', () => {
    const db = makeDb();
    ensureTrainingStaff(db);
    assert.equal(db._staff.has(TRAINING_STAFF_NAME), false);
});

test('ensureTrainingStaff revokes orphaned training sessions without a staff row', (t) => {
    const fixture = createRealDb(t);
    if (!fixture) return;
    const { db, sqlite } = fixture;
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('by-name', 9, 'TRAINING MODE', 0)");
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('by-marker', 10, 'LEGACY', 1)");
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('other', 11, 'ALEX', 0)");

    ensureTrainingStaff(db);

    assert.deepEqual(db.all('SELECT token FROM sessions ORDER BY token'), [{ token: 'other' }]);
    sqlite.close();
});

test('ensureTrainingStaff normalizes mixed-case padded staff and session names', (t) => {
    const fixture = createRealDb(t);
    if (!fixture) return;
    const { db, sqlite } = fixture;
    db.run(`
        INSERT INTO staff (id, name, active, pin, app_access, role, pin_hashed, permissions)
        VALUES (7, '  training mode  ', 1, '2468', 1, 'Manager', 1, 'historic')
    `);
    db.run(`
        INSERT INTO staff (id, name, active, pin, app_access, role, pin_hashed, permissions)
        VALUES (8, 'TRAINING MODEX', 1, '1357', 1, 'Clerk', 0, 'unrelated')
    `);
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('by-id', 7, 'OLD LABEL', 0)");
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('by-name', 99, ' Training Mode ', 0)");
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('other', 8, 'TRAINING MODEX', 0)");

    ensureTrainingStaff(db);

    assert.deepEqual(
        db.get('SELECT active, app_access, pin, pin_hashed FROM staff WHERE id = 7'),
        { active: 0, app_access: 0, pin: '', pin_hashed: 0 },
    );
    assert.deepEqual(
        db.get('SELECT active, app_access, pin FROM staff WHERE id = 8'),
        { active: 1, app_access: 1, pin: '1357' },
    );
    assert.deepEqual(db.all('SELECT token FROM sessions ORDER BY token'), [{ token: 'other' }]);
    sqlite.close();
});

test('ensureTrainingStaff revokes an existing profile without rewriting history fields', () => {
    const db = makeDb();
    db._staff.set(TRAINING_STAFF_NAME, {
        id: 9,
        name: TRAINING_STAFF_NAME,
        pin: '9999',
        pin_hashed: 1,
        role: 'Clerk',
        permissions: 'historic',
        active: 1,
        app_access: 1,
    });
    db._sessions.push(
        { token: 'training-by-id', staff_id: 9, name: 'OLD NAME' },
        { token: 'training-by-name', staff_id: 99, name: TRAINING_STAFF_NAME },
        { token: 'training-marker', staff_id: 99, name: 'LEGACY WALKTHROUGH', training: 1 },
        { token: 'other', staff_id: 10, name: 'ALEX' },
    );
    ensureTrainingStaff(db);
    const row = db._staff.get(TRAINING_STAFF_NAME);
    assert.equal(row.active, 0);
    assert.equal(row.app_access, 0);
    assert.equal(row.pin, '');
    assert.equal(row.pin_hashed, 0);
    assert.equal(row.role, 'Clerk');
    assert.equal(row.permissions, 'historic');
    assert.deepEqual(db._sessions.map((session) => session.token), ['other']);
});

test('training settings toggles cannot reactivate or reset the revoked credential', () => {
    const db = makeDb({ Training_Mode_Enabled: '1' });
    db._staff.set(TRAINING_STAFF_NAME, {
        id: 1,
        name: TRAINING_STAFF_NAME,
        pin: '9876',
        pin_hashed: 1,
        role: 'Manager',
        active: 1,
        app_access: 1,
    });
    ensureTrainingStaff(db);
    const row = db._staff.get(TRAINING_STAFF_NAME);
    assert.equal(row.active, 0);
    assert.equal(row.app_access, 0);
    assert.equal(row.pin, '');
    assert.equal(row.pin_hashed, 0);
});

test('single-setting handler cannot reactivate training and revokes its sessions', (t) => {
    const fixture = createRealDb(t);
    if (!fixture) return;
    const { db, sqlite } = fixture;
    db.run(`
        INSERT INTO staff (id, name, active, pin, app_access, role, pin_hashed, permissions)
        VALUES (7, 'TRAINING MODE', 1, '4321', 1, 'Manager', 0, 'historic')
    `);
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('training', 7, 'TRAINING MODE', 1)");
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('other', 8, 'ALEX', 0)");
    const handlers = createSettingsHandlers({
        db,
        broadcastUpdate() {},
        getStoreDateStamp: () => '2026-08-03',
        actionHandlers: {},
        archiveCompletedOrderClock() {},
    });

    handlers.settings_update({
        id_val: 'Training_Mode_Enabled',
        id_col: 'setting_name',
        table: 'settings',
        workingData: { setting_value: '1' },
    });

    assert.deepEqual(
        db.get("SELECT active, app_access, pin, pin_hashed FROM staff WHERE name = 'TRAINING MODE'"),
        { active: 0, app_access: 0, pin: '', pin_hashed: 0 },
    );
    assert.deepEqual(db.all('SELECT token FROM sessions ORDER BY token'), [{ token: 'other' }]);
    sqlite.close();
});

test('batch settings caller cannot create training and revokes orphaned sessions', (t) => {
    const fixture = createRealDb(t);
    if (!fixture) return;
    const { db, sqlite } = fixture;
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('by-name', 7, 'TRAINING MODE', 0)");
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('by-marker', 8, 'LEGACY', 1)");
    db.run("INSERT INTO sessions (token, staff_id, name, training) VALUES ('other', 9, 'ALEX', 0)");

    applySettingsBatch(
        db,
        [{ setting_name: 'Training_Mode_Enabled', setting_value: '1' }],
        { isManager: true },
    );

    assert.equal(db.get("SELECT COUNT(*) AS count FROM staff WHERE name = 'TRAINING MODE'").count, 0);
    assert.deepEqual(db.all('SELECT token FROM sessions ORDER BY token'), [{ token: 'other' }]);
    sqlite.close();
});

test('isUnassignedOptionEnabled respects setting', () => {
    assert.equal(isUnassignedOptionEnabled({}), true);
    assert.equal(isUnassignedOptionEnabled({ Unassigned_Option_Enabled: '1' }), true);
    assert.equal(isUnassignedOptionEnabled({ Unassigned_Option_Enabled: '0' }), false);
});
