'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createPreMigrationSnapshot,
    isSafeMigrationSnapshotFilename,
    isSafeMigrationPackageDir,
    listMigrationSnapshots,
    stampFor,
    MIGRATION_SNAPSHOT_REQUIRED,
} = require('../src/lib/migration-safety.cjs');

function tmpDir(prefix = 'tgp-migration-safety-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

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

test('migration snapshot filenames are strict and sortable', () => {
    assert.equal(stampFor(new Date('2026-06-22T14:30:00')), '2026-06-22_1430');
    assert.equal(isSafeMigrationSnapshotFilename('tgp_ops_pre_migration_2026-06-22_1430.db'), true);
    assert.equal(isSafeMigrationSnapshotFilename('../tgp_ops_pre_migration_2026-06-22_1430.db'), false);
    assert.equal(isSafeMigrationSnapshotFilename('tgp_ops_backup_2026-06-22.db'), false);
    assert.equal(isSafeMigrationPackageDir('pkg_migration_2026-06-22_143000'), true);
    assert.equal(isSafeMigrationPackageDir('pkg_migration_2026-06-22_143000_1'), true);
    assert.equal(isSafeMigrationPackageDir('pkg_pre_eod_2026-06-22_143000'), false);
});

test('createPreMigrationSnapshot skips when no migrations are pending', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const backupsDir = path.join(dir, 'backups');
    fs.writeFileSync(dbPath, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128)]));

    const skipped = createPreMigrationSnapshot({
        db: { exec() {} },
        dbPath,
        backupsDir,
        dataRoot: dir,
        pendingMigrations: [],
    });
    assert.equal(skipped.skipped, true);
    assert.equal(fs.existsSync(backupsDir), false);
});

function seedSidecars(dataRoot) {
    const invPath = path.join(dataRoot, 'data', 'pulse_inventory.db');
    fs.mkdirSync(path.dirname(invPath), { recursive: true });
    const Database = require('better-sqlite3');
    const inv = new Database(invPath);
    try {
        inv.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, sku TEXT);');
        inv.prepare('INSERT INTO items (sku) VALUES (?)').run('SKU-1');
    } finally {
        inv.close();
    }

    const attDir = path.join(dataRoot, 'data', 'incident_investigations', '42');
    fs.mkdirSync(attDir, { recursive: true });
    fs.writeFileSync(path.join(attDir, 'photo.jpg'), Buffer.from('fake-image'));

    const xferDir = path.join(dataRoot, 'store-transfers');
    fs.mkdirSync(xferDir, { recursive: true });
    fs.writeFileSync(path.join(xferDir, 'ST-000001.xlsx'), Buffer.from('PK\x03\x04fake-xlsx'));
}

test('createPreMigrationSnapshot creates verified migration package when migrations are pending', (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;

    const dataRoot = tmpDir();
    const backupsDir = path.join(dataRoot, 'backups');
    const dbPath = path.join(dataRoot, 'tgp_ops.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        INSERT INTO settings (setting_name, setting_value) VALUES ('Store_Name', 'Test');
    `);
    const calls = [];
    const db = {
        exec(sql) {
            calls.push(sql);
            return sqlite.exec(sql);
        },
    };

    try {
        const result = createPreMigrationSnapshot({
            db,
            dbPath,
            backupsDir,
            dataRoot,
            pendingMigrations: [{ file: '017_trusted_device_token_pairing.cjs', version: 17 }],
            now: new Date('2026-06-22T14:30:00'),
        });

        assert.equal(result.ok, true);
        assert.equal(result.file, 'pkg_migration_2026-06-22_143000');
        assert.equal(result.packageId, 'pkg_migration_2026-06-22_143000');
        assert.ok(fs.existsSync(path.join(result.path, 'tgp_ops.db')));
        assert.ok(fs.existsSync(path.join(result.path, 'manifest.json')));
        const manifest = JSON.parse(fs.readFileSync(path.join(result.path, 'manifest.json'), 'utf8'));
        assert.equal(manifest.stage, 'migration');
        assert.equal(fs.existsSync(path.join(backupsDir, 'tgp_ops_backup_2026-06-22.db')), false);
        assert.equal(fs.existsSync(path.join(backupsDir, 'tgp_ops_pre_eod_2026-06-22.db')), false);

        const snapshots = listMigrationSnapshots(backupsDir);
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].file, result.file);
        assert.equal(snapshots[0].kind, 'package');
        assert.ok(
            calls.some((sql) => /VACUUM INTO/i.test(sql) || /wal_checkpoint/i.test(sql)),
            'expected VACUUM INTO or wal_checkpoint during snapshot',
        );
    } finally {
        try { sqlite.close(); } catch (_) { /* ignore */ }
    }
});

test('createPreMigrationSnapshot packages inventory attachments and store-transfers sidecars', (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;

    const dataRoot = tmpDir();
    const backupsDir = path.join(dataRoot, 'backups');
    const dbPath = path.join(dataRoot, 'tgp_ops.db');
    const sqlite = new Database(dbPath);
    sqlite.exec(`
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        INSERT INTO settings (setting_name, setting_value) VALUES ('Store_Name', 'Test');
    `);
    const db = { exec: (sql) => sqlite.exec(sql) };

    try {
        seedSidecars(dataRoot);
        const result = createPreMigrationSnapshot({
            db,
            dbPath,
            backupsDir,
            dataRoot,
            pendingMigrations: [{ file: '061_backup_integrity_controls.cjs', version: 61 }],
            now: new Date('2026-08-04T10:15:30'),
        });

        assert.equal(result.ok, true);
        const manifest = JSON.parse(fs.readFileSync(path.join(result.path, 'manifest.json'), 'utf8'));
        assert.equal(manifest.stage, 'migration');
        assert.ok(manifest.artifacts.some((a) => a.role === 'ops_db'));
        assert.ok(manifest.artifacts.some((a) => a.role === 'inventory_db'));
        assert.ok(manifest.artifacts.some((a) => a.role === 'incident_attachments'));
        assert.ok(manifest.artifacts.some((a) => a.role === 'store_transfers'));
        assert.ok(fs.existsSync(path.join(result.path, 'pulse_inventory.db')));
        assert.ok(fs.existsSync(path.join(result.path, 'incident_investigations', '42', 'photo.jpg')));
        assert.ok(fs.existsSync(path.join(result.path, 'store-transfers', 'ST-000001.xlsx')));
        assert.equal(fs.existsSync(path.join(backupsDir, 'tgp_ops_backup_2026-08-04.db')), false);
    } finally {
        try { sqlite.close(); } catch (_) { /* ignore */ }
    }
});

test('createPreMigrationSnapshot fails closed when createBackupPackage returns !ok', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const backupsDir = path.join(dir, 'backups');
    fs.writeFileSync(dbPath, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(128)]));

    assert.throws(() => createPreMigrationSnapshot({
        db: { exec() { throw new Error('checkpoint boom'); } },
        dbPath,
        backupsDir,
        dataRoot: dir,
        pendingMigrations: [{ file: '061_x.cjs' }],
        failOnError: true,
        createBackupPackage: () => ({ ok: false, error: 'nope', code: 'BACKUP_VERIFICATION_FAILED' }),
    }), /MIGRATION_SNAPSHOT_REQUIRED|BACKUP_VERIFICATION/);
});

test('createPreMigrationSnapshot fails closed when createBackupPackage throws', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const backupsDir = path.join(dir, 'backups');
    fs.writeFileSync(dbPath, Buffer.from('SQLite format 3\0'));

    assert.throws(() => createPreMigrationSnapshot({
        db: { exec() {} },
        dbPath,
        backupsDir,
        dataRoot: dir,
        pendingMigrations: [{ file: '061_x.cjs' }],
        failOnError: true,
        createBackupPackage: () => {
            throw new Error('BACKUP_VERIFICATION_FAILED: injected');
        },
    }), /MIGRATION_SNAPSHOT_REQUIRED|BACKUP_VERIFICATION/);
});

test('createPreMigrationSnapshot fails closed when createBackupPackage returns a Promise', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const backupsDir = path.join(dir, 'backups');
    fs.writeFileSync(dbPath, Buffer.from('SQLite format 3\0'));

    assert.throws(() => createPreMigrationSnapshot({
        db: {
            exec() { throw new Error('checkpoint boom'); },
            backup: async () => { throw new Error('backup boom'); },
        },
        dbPath,
        backupsDir,
        dataRoot: dir,
        pendingMigrations: [{ file: '061_x.cjs' }],
        failOnError: true,
        createBackupPackage: async () => ({ ok: false, error: 'nope', code: 'BACKUP_VERIFICATION_FAILED' }),
    }), /MIGRATION_SNAPSHOT_REQUIRED|BACKUP_VERIFICATION/);
});

test('createPreMigrationSnapshot returns not-ok when failOnError is false', () => {
    const dir = tmpDir();
    const dbPath = path.join(dir, 'tgp_ops.db');
    const backupsDir = path.join(dir, 'backups');
    fs.writeFileSync(dbPath, Buffer.from('SQLite format 3\0'));

    const result = createPreMigrationSnapshot({
        db: { exec() {} },
        dbPath,
        backupsDir,
        dataRoot: dir,
        pendingMigrations: [{ file: '061_x.cjs' }],
        failOnError: false,
        createBackupPackage: () => ({ ok: false, error: 'nope', code: 'BACKUP_VERIFICATION_FAILED' }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, false);
    assert.match(String(result.error), /MIGRATION_SNAPSHOT_REQUIRED|nope/);
    assert.equal(result.code, MIGRATION_SNAPSHOT_REQUIRED);
});
