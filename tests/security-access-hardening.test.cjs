'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMigrations, listMigrationFiles } = require('../src/migrations/runner.cjs');
const {
    ACTIVE_MANAGER_EXISTS_SQL,
    hasActiveManager,
} = require('../src/lib/pc-admin-pin.cjs');

function requireSqlite(t) {
    try {
        const Database = require('better-sqlite3');
        const probe = new Database(':memory:');
        probe.close();
        return Database;
    } catch (error) {
        const message = String(error?.message || error);
        if (message.includes('NODE_MODULE_VERSION') || message.includes('Could not locate the bindings file')) {
            t.skip(`better-sqlite3 is not loadable in this runtime: ${message}`);
            return null;
        }
        throw error;
    }
}

function wrap(sqlite) {
    return {
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run: (sql, ...params) => sqlite.prepare(sql).run(...params),
        exec: (sql) => sqlite.exec(sql),
        transaction: (fn) => sqlite.transaction(fn),
    };
}

function createUpgradeFixture(t) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    db.exec(`
        CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL,
            name TEXT NOT NULL
        );
        CREATE TABLE settings (
            setting_name TEXT PRIMARY KEY,
            setting_value TEXT
        );
        CREATE TABLE staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            active INTEGER DEFAULT 1,
            pin TEXT DEFAULT '1234',
            app_access INTEGER DEFAULT 1,
            role TEXT DEFAULT 'Clerk',
            pin_hashed INTEGER DEFAULT 0,
            permissions TEXT DEFAULT ''
        );
        CREATE TABLE sessions (
            token TEXT PRIMARY KEY,
            staff_id INTEGER,
            name TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT '',
            training INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            last_active_at TEXT NOT NULL
        );
        CREATE TABLE trusted_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT UNIQUE,
            label TEXT,
            status TEXT DEFAULT 'Pending',
            last_seen TEXT,
            device_token_hash TEXT,
            token_created_at TEXT,
            last_seen_at TEXT
        );
        CREATE TABLE audit_ledger (
            id TEXT PRIMARY KEY,
            timestamp TEXT,
            user TEXT,
            action_type TEXT,
            target_table TEXT,
            details TEXT
        );
    `);
    const applied = db.run;
    for (let version = 1; version <= 59; version += 1) {
        applied(
            'INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)',
            version,
            '2026-08-03T00:00:00.000Z',
            `fixture_${version}`,
        );
    }
    db.run("INSERT INTO settings VALUES ('Training_Mode_Enabled', '1')");
    db.run("INSERT INTO settings VALUES ('Require_TV_Device_Token', '0')");
    db.run(`
        INSERT INTO staff (id, name, active, pin, app_access, role, pin_hashed, permissions)
        VALUES (7, 'TRAINING MODE', 1, '1234', 1, 'Manager', 0, 'receiving,markdown,comms')
    `);
    db.run(`
        INSERT INTO staff (id, name, active, pin, app_access, role, pin_hashed, permissions)
        VALUES (8, '  training mode  ', 1, '2468', 1, 'Manager', 1, 'historic')
    `);
    db.run(`
        INSERT INTO staff (id, name, active, pin, app_access, role, pin_hashed, permissions)
        VALUES (9, 'TRAINING MODEX', 1, '1357', 1, 'Clerk', 0, 'unrelated')
    `);
    db.run(`
        INSERT INTO sessions (token, staff_id, name, role, training, created_at, last_active_at)
        VALUES ('by-id', 7, 'OLD TRAINING LABEL', 'Manager', 1, 'now', 'now')
    `);
    db.run(`
        INSERT INTO sessions (token, staff_id, name, role, training, created_at, last_active_at)
        VALUES ('by-name', 99, 'TRAINING MODE', 'Manager', 1, 'now', 'now')
    `);
    db.run(`
        INSERT INTO sessions (token, staff_id, name, role, training, created_at, last_active_at)
        VALUES ('training-marker', 100, 'LEGACY WALKTHROUGH', 'Manager', 1, 'now', 'now')
    `);
    db.run(`
        INSERT INTO sessions (token, staff_id, name, role, training, created_at, last_active_at)
        VALUES ('mixed-by-id', 8, 'OLD LABEL', 'Manager', 0, 'now', 'now')
    `);
    db.run(`
        INSERT INTO sessions (token, staff_id, name, role, training, created_at, last_active_at)
        VALUES ('mixed-by-name', 101, ' Training Mode ', 'Manager', 0, 'now', 'now')
    `);
    db.run(`
        INSERT INTO sessions (token, staff_id, name, role, training, created_at, last_active_at)
        VALUES ('other', 9, 'TRAINING MODEX', 'Clerk', 0, 'now', 'now')
    `);
    db.run(`
        INSERT INTO trusted_devices (ip_address, label, status, device_token_hash)
        VALUES ('192.168.1.20', 'Existing TV', 'Authorized', 'hash')
    `);
    db.run(`
        INSERT INTO audit_ledger (id, timestamp, user, action_type, target_table, details)
        VALUES ('audit-1', 'now', 'TRAINING MODE', 'historic', 'staff', 'preserve')
    `);
    return { sqlite, db };
}

test('fresh database defaults fail closed for training and TV access', (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-security-fresh-'));
    const hadDataDir = Object.prototype.hasOwnProperty.call(process.env, 'TGP_DATA_DIR');
    const previousDataDir = process.env.TGP_DATA_DIR;
    const dbModulePath = require.resolve('../src/db.cjs');
    let db;
    t.after(() => {
        try {
            if (db) db.close();
        } finally {
            delete require.cache[dbModulePath];
            if (hadDataDir) process.env.TGP_DATA_DIR = previousDataDir;
            else delete process.env.TGP_DATA_DIR;
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    });
    process.env.TGP_DATA_DIR = dataDir;
    delete require.cache[dbModulePath];
    const dbModule = require('../src/db.cjs');
    db = dbModule.db;
    const { initializeSettings } = dbModule;
    initializeSettings();

    assert.equal(
        db.get("SELECT setting_value FROM settings WHERE setting_name = 'Training_Mode_Enabled'").setting_value,
        '0',
    );
    assert.equal(
        db.get("SELECT setting_value FROM settings WHERE setting_name = 'Require_TV_Device_Token'").setting_value,
        '1',
    );
    const training = db.get(
        "SELECT active, app_access, pin, pin_hashed FROM staff WHERE name = 'TRAINING MODE'",
    );
    assert.ok(!training || (
        training.active === 0
        && training.app_access === 0
        && training.pin === ''
        && training.pin_hashed === 0
    ));
});

test('migration 060 revokes training access and adds unassigned device purpose', (t) => {
    const fixture = createUpgradeFixture(t);
    if (!fixture) return;
    const { sqlite, db } = fixture;

    runMigrations(db);

    assert.deepEqual(
        db.get("SELECT active, app_access, pin, pin_hashed FROM staff WHERE name = 'TRAINING MODE'"),
        { active: 0, app_access: 0, pin: '', pin_hashed: 0 },
    );
    assert.deepEqual(
        db.get('SELECT active, app_access, pin, pin_hashed FROM staff WHERE id = 8'),
        { active: 0, app_access: 0, pin: '', pin_hashed: 0 },
    );
    assert.deepEqual(
        db.get('SELECT active, app_access, pin FROM staff WHERE id = 9'),
        { active: 1, app_access: 1, pin: '1357' },
    );
    assert.deepEqual(db.all('SELECT token FROM sessions ORDER BY token'), [{ token: 'other' }]);
    assert.equal(
        db.get("SELECT setting_value FROM settings WHERE setting_name = 'Training_Mode_Enabled'").setting_value,
        '0',
    );
    assert.equal(
        db.get("SELECT setting_value FROM settings WHERE setting_name = 'Require_TV_Device_Token'").setting_value,
        '1',
    );
    const purposeColumn = db.all('PRAGMA table_info(trusted_devices)')
        .find((column) => column.name === 'device_purpose');
    assert.ok(purposeColumn);
    assert.equal(purposeColumn.type, 'TEXT');
    assert.equal(purposeColumn.notnull, 1);
    assert.equal(purposeColumn.dflt_value, "''");
    assert.equal(db.get('SELECT device_purpose FROM trusted_devices WHERE id = 1').device_purpose, '');
    assert.ok(
        db.all("PRAGMA index_list('trusted_devices')")
            .some((index) => index.name === 'idx_trusted_devices_purpose_status'),
    );
    assert.equal(db.get("SELECT COUNT(*) AS count FROM audit_ledger WHERE id = 'audit-1'").count, 1);

    sqlite.close();
});

test('migration 060 up body is directly idempotent', (t) => {
    const fixture = createUpgradeFixture(t);
    if (!fixture) return;
    const { sqlite, db } = fixture;
    assert.ok(
        listMigrationFiles().includes('060_security_access_hardening.cjs'),
        'migration 060 must exist',
    );
    const migration = require('../src/migrations/060_security_access_hardening.cjs');

    migration.up(db);
    migration.up(db);

    assert.equal(
        db.all('PRAGMA table_info(trusted_devices)')
            .filter((column) => column.name === 'device_purpose').length,
        1,
    );
    assert.equal(db.get("SELECT COUNT(*) AS count FROM sessions WHERE name = 'TRAINING MODE'").count, 0);
    sqlite.close();
});

test('migration runner rolls back migration 060 data and schema on failure', (t) => {
    const fixture = createUpgradeFixture(t);
    if (!fixture) return;
    const { sqlite, db } = fixture;
    const run = db.run;
    db.run = (sql, ...params) => {
        if (sql.includes('INSERT INTO schema_version') && params[0] === 60) {
            throw new Error('injected schema-version failure');
        }
        return run(sql, ...params);
    };

    assert.throws(() => runMigrations(db), /injected schema-version failure/);

    assert.equal(
        db.all('PRAGMA table_info(trusted_devices)').some((column) => column.name === 'device_purpose'),
        false,
    );
    assert.deepEqual(
        db.get("SELECT active, app_access, pin FROM staff WHERE name = 'TRAINING MODE'"),
        { active: 1, app_access: 1, pin: '1234' },
    );
    assert.equal(
        db.get("SELECT setting_value FROM settings WHERE setting_name = 'Training_Mode_Enabled'").setting_value,
        '1',
    );
    assert.equal(db.get('SELECT COUNT(*) AS count FROM schema_version WHERE version = 60').count, 0);
    sqlite.close();
});

test('bootstrap manager detection uses one active Manager and Store Manager query', () => {
    assert.match(ACTIVE_MANAGER_EXISTS_SQL, /active\s*=\s*1/i);
    assert.match(ACTIVE_MANAGER_EXISTS_SQL, /role\s+IN\s*\(\s*'Manager'\s*,\s*'Store Manager'\s*\)/i);

    const seen = [];
    assert.equal(hasActiveManager({
        get(sql) {
            seen.push(sql);
            return { ok: 1 };
        },
    }), true);
    assert.deepEqual(seen, [ACTIVE_MANAGER_EXISTS_SQL]);
});
