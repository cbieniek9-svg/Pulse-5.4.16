'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkDatabaseHealth, recordBootHealth } = require('../src/lib/db-health.cjs');

function requireSqlite(t) {
    try {
        const Database = require('better-sqlite3');
        const tmp = path.join(tempDir(), 'probe.db');
        const probe = new Database(tmp);
        probe.close();
        return Database;
    } catch (e) {
        t.skip(`better-sqlite3 is not loadable in this environment: ${e.message || e}`);
        return null;
    }
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-db-health-'));
}

function createWrapper(sqliteDb) {
    const stmtCache = new Map();
    const getStmt = (sql) => {
        if (!stmtCache.has(sql)) stmtCache.set(sql, sqliteDb.prepare(sql));
        return stmtCache.get(sql);
    };
    return {
        all: (sql, ...params) => getStmt(sql).all(...params),
        get: (sql, ...params) => getStmt(sql).get(...params),
        run: (sql, ...params) => getStmt(sql).run(...params),
        exec: (sql) => sqliteDb.exec(sql),
        transaction: (fn) => sqliteDb.transaction(fn),
    };
}

test('checkDatabaseHealth reports ok for required tables and WAL file DB', (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;
    const dir = tempDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const sqlite = new Database(dbPath);
    const db = createWrapper(sqlite);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        CREATE TABLE staff (id INTEGER PRIMARY KEY, name TEXT);
    `);

    const health = checkDatabaseHealth(db, {
        requiredTables: ['settings', 'staff'],
        checkBackups: false,
        dbPath,
        dataRoot: dir,
    });

    assert.equal(health.ok, true);
    assert.equal(health.status, 'ok');
    assert.equal(health.checks.required_tables.ok, true);
    assert.equal(health.checks.journal_mode.value, 'wal');

    sqlite.close();
});

test('checkDatabaseHealth reports missing required tables', (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;
    const dir = tempDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const sqlite = new Database(dbPath);
    const db = createWrapper(sqlite);
    db.exec('CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);');

    const health = checkDatabaseHealth(db, {
        requiredTables: ['settings', 'staff'],
        checkBackups: false,
        dbPath,
        dataRoot: dir,
    });

    assert.equal(health.ok, false);
    assert.equal(health.status, 'error');
    assert.deepEqual(health.checks.required_tables.missing, ['staff']);
    assert.ok(health.errors.some((m) => m.includes('Missing required table')));

    sqlite.close();
});

test('recordBootHealth stores compact status rows', (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;
    const dir = tempDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const sqlite = new Database(dbPath);
    const db = createWrapper(sqlite);
    db.exec('CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);');

    const ok = recordBootHealth(db, {
        status: 'warning',
        checked_at: '2026-06-21T12:00:00.000Z',
        errors: [],
        warnings: ['No verified generated backup found'],
    });

    assert.equal(ok, true);
    assert.equal(db.get("SELECT setting_value FROM settings WHERE setting_name='Boot_Health_Status'").setting_value, 'warning');
    assert.equal(db.get("SELECT setting_value FROM settings WHERE setting_name='Boot_Health_Last_Run'").setting_value, '2026-06-21T12:00:00.000Z');

    sqlite.close();
});
