'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    isSafeBackupFilename,
    validateSqliteHeader,
    listBackupFiles,
    getBackupHealth,
    inspectBackupDatabase,
} = require('../src/lib/backup-health.cjs');

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-backups-'));
}

function requireBetterSqlite3(t) {
    let Database;
    try {
        Database = require('better-sqlite3');
        const probeFile = path.join(tempDir(), 'probe.db');
        const probe = new Database(probeFile);
        probe.close();
    } catch (e) {
        t.skip(`better-sqlite3 is not loadable in this environment: ${e.message || e}`);
        return null;
    }
    return Database;
}

test('backup filename allowlist accepts only generated SQLite backup names', () => {
    assert.equal(isSafeBackupFilename('tgp_ops_backup_2026-06-21.db'), true);
    assert.equal(isSafeBackupFilename('tgp_ops_weekly_2026-06-21.db'), true);
    assert.equal(isSafeBackupFilename('../tgp_ops_backup_2026-06-21.db'), false);
    assert.equal(isSafeBackupFilename('notes.db'), false);
    assert.equal(isSafeBackupFilename('tgp_ops_backup_2026-6-21.db'), false);
});

test('header-only truncated file is not healthy (readable may be true; ok/verified must be false)', () => {
    const dir = tempDir();
    const older = path.join(dir, 'tgp_ops_backup_2026-06-20.db');
    const latest = path.join(dir, 'tgp_ops_weekly_2026-06-21.db');
    const ignored = path.join(dir, 'random.db');

    fs.writeFileSync(older, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(32)]));
    fs.writeFileSync(latest, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64)]));
    fs.writeFileSync(ignored, 'not a generated backup');

    const now = new Date('2026-06-21T12:00:00Z');
    const then = new Date('2026-06-20T12:00:00Z');
    fs.utimesSync(older, then, then);
    fs.utimesSync(latest, now, now);

    assert.equal(validateSqliteHeader(latest), true);
    const files = listBackupFiles(dir);
    assert.deepEqual(files.map((f) => f.file), [
        'tgp_ops_weekly_2026-06-21.db',
        'tgp_ops_backup_2026-06-20.db',
    ]);

    const health = getBackupHealth(dir);
    // Header-only junk can still pass the cheap readable check; health.ok requires verify.
    assert.equal(health.latest_readable, true);
    assert.equal(health.latest_verified, false);
    assert.equal(health.ok, false);
    assert.equal(health.count, 2);
    assert.equal(health.latest_file, 'tgp_ops_weekly_2026-06-21.db');
    assert.ok(health.latest_verify_error);
});

test('real SQLite backup is healthy when latest candidate verifies', (t) => {
    const Database = requireBetterSqlite3(t);
    if (!Database) return;

    const dir = tempDir();
    const olderHeaderOnly = path.join(dir, 'tgp_ops_backup_2026-06-20.db');
    const latest = path.join(dir, 'tgp_ops_backup_2026-06-21.db');

    fs.writeFileSync(olderHeaderOnly, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(32)]));
    const sqlite = new Database(latest);
    try {
        sqlite.exec(`
            CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
            CREATE TABLE staff (id INTEGER PRIMARY KEY, name TEXT);
        `);
    } finally {
        sqlite.close();
    }

    const then = new Date('2026-06-20T12:00:00Z');
    const now = new Date('2026-06-21T12:00:00Z');
    fs.utimesSync(olderHeaderOnly, then, then);
    fs.utimesSync(latest, now, now);

    const health = getBackupHealth(dir);
    assert.equal(health.ok, true);
    assert.equal(health.latest_verified, true);
    assert.equal(health.latest_readable, true);
    assert.equal(health.latest_file, 'tgp_ops_backup_2026-06-21.db');
    assert.equal(health.latest_verify_error, null);
});

test('inspectBackupDatabase performs SQLite integrity and required table checks', (t) => {
    const Database = requireBetterSqlite3(t);
    if (!Database) return;

    const dir = tempDir();
    const file = path.join(dir, 'tgp_ops_backup_2026-06-21.db');
    const sqlite = new Database(file);
    try {
        sqlite.exec(`
            CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
            CREATE TABLE staff (id INTEGER PRIMARY KEY, name TEXT);
        `);
    } finally {
        sqlite.close();
    }

    const ok = inspectBackupDatabase(file, { requiredTables: ['settings', 'staff'] });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.missing_tables, []);

    const missing = inspectBackupDatabase(file, { requiredTables: ['settings', 'staff', 'tasks'] });
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.missing_tables, ['tasks']);
});
