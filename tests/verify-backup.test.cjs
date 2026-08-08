'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { chooseBackup, runBackupDrill } = require('../scripts/verify-backup.cjs');
const { REQUIRED_TABLES } = require('../src/lib/db-health.cjs');

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
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-verify-backup-'));
}

function createMinimalBackup(t, filePath) {
    const Database = requireSqlite(t);
    if (!Database) return false;
    const sqlite = new Database(filePath);
    try {
        REQUIRED_TABLES.forEach((name) => {
            sqlite.exec(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY)`);
        });
    } finally {
        sqlite.close();
    }
    return true;
}

test('chooseBackup rejects unsafe requested filenames', () => {
    const dir = tempDir();
    assert.throws(
        () => chooseBackup(dir, '../tgp_ops_backup_2026-06-21.db'),
        /Unsafe or unsupported backup filename/,
    );
});

test('runBackupDrill checks a copied generated backup without mutating original', (t) => {
    const dir = tempDir();
    const file = path.join(dir, 'tgp_ops_backup_2026-06-21.db');
    if (!createMinimalBackup(t, file)) return;
    const before = fs.statSync(file).mtimeMs;

    const result = runBackupDrill({
        backupsDir: dir,
        backup: 'tgp_ops_backup_2026-06-21.db',
        skipMigrations: true,
    });

    assert.equal(result.ok, true);
    assert.equal(result.stage, 'complete');
    assert.equal(result.backup, 'tgp_ops_backup_2026-06-21.db');
    assert.ok(result.copy_path.includes('tgp-backup-drill-'));
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.statSync(file).mtimeMs, before);
});

test('runBackupDrill fails clearly for a corrupted generated backup', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'tgp_ops_backup_2026-06-21.db'), 'not sqlite');

    const result = runBackupDrill({
        backupsDir: dir,
        backup: 'tgp_ops_backup_2026-06-21.db',
        skipMigrations: true,
    });

    assert.equal(result.ok, false);
    assert.equal(result.stage, 'preflight');
    assert.match(result.inspection.error, /invalid SQLite header/);
});

test('runBackupDrill can skip cleanly when no generated backup exists', () => {
    const dir = tempDir();
    const result = runBackupDrill({ backupsDir: dir, allowMissing: true });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.stage, 'skipped');
});
