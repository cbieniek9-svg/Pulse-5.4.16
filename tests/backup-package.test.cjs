'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    hashFile,
    verifyOpsDatabaseCopy,
    createBackupPackage,
    loadManifest,
    promoteDailyAlias,
} = require('../src/lib/backup-package.cjs');

function tempDir(prefix = 'tgp-backup-pkg-') {
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

function wrapDb(sqlite) {
    return {
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run: (sql, ...params) => sqlite.prepare(sql).run(...params),
        exec: (sql) => sqlite.exec(sql),
        backup: (dest) => sqlite.backup(dest),
        close: () => sqlite.close(),
    };
}

function makeIsolatedStore(t) {
    const Database = requireSqlite(t);
    if (!Database) return null;

    const dataRoot = tempDir();
    fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
    fs.mkdirSync(path.join(dataRoot, 'backups'), { recursive: true });

    const opsPath = path.join(dataRoot, 'tgp_ops.db');
    const sqlite = new Database(opsPath);
    sqlite.exec(`
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        CREATE TABLE staff (id INTEGER PRIMARY KEY, name TEXT);
        INSERT INTO settings (setting_name, setting_value) VALUES ('Store_Name', 'Test');
    `);
    const db = wrapDb(sqlite);
    return {
        db,
        dataRoot,
        close: () => {
            try { db.close(); } catch (_) { /* ignore */ }
        },
    };
}

function seedSidecars(dataRoot) {
    const invPath = path.join(dataRoot, 'data', 'pulse_inventory.db');
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

test('header-only sqlite file fails package verification', () => {
    const dir = tempDir();
    const fake = path.join(dir, 'fake.db');
    fs.writeFileSync(fake, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64)]));
    const result = verifyOpsDatabaseCopy(fake);
    assert.equal(result.ok, false);
});

test('createBackupPackage bundles ops inventory attachments transfers and manifest', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        seedSidecars(dataRoot);
        const pkg = await createBackupPackage({
            db,
            dataRoot,
            stage: 'manual',
            actor: 'TEST',
            labelDate: '2026-08-04',
        });
        assert.equal(pkg.ok, true);
        assert.ok(fs.existsSync(pkg.opsDbPath));
        assert.ok(pkg.manifest.artifacts.some((a) => a.role === 'ops_db'));
        assert.ok(pkg.manifest.artifacts.some((a) => a.role === 'inventory_db'));
        assert.ok(pkg.manifest.artifacts.some((a) => a.role === 'incident_attachments'));
        assert.ok(pkg.manifest.artifacts.some((a) => a.role === 'store_transfers'));
        assert.equal(pkg.manifest.stage, 'manual');
        assert.equal(pkg.labelDate, '2026-08-04');
        assert.match(path.basename(pkg.directory), /^pkg_manual_2026-08-04_\d{6}$/);

        const loaded = loadManifest(pkg.directory);
        assert.equal(loaded.stage, 'manual');
        assert.ok(loaded.artifacts.some((a) => a.role === 'ops_db'));
        assert.equal(typeof hashFile(pkg.opsDbPath), 'string');
        assert.equal(hashFile(pkg.opsDbPath).length, 64);
    } finally {
        close();
    }
});

test('verification failure returns code BACKUP_VERIFICATION_FAILED', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        const badDb = {
            backup: async (dest) => {
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.writeFileSync(dest, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(64)]));
            },
        };
        const pkg = await createBackupPackage({
            db: badDb,
            dataRoot,
            stage: 'manual',
            actor: 'TEST',
            labelDate: '2026-08-04',
        });
        assert.equal(pkg.ok, false);
        assert.equal(pkg.code, 'BACKUP_VERIFICATION_FAILED');
        assert.ok(pkg.error);
    } finally {
        close();
    }
});

test('pre_eod promotes tgp_ops_pre_eod alias under backups', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        const pkg = await createBackupPackage({
            db,
            dataRoot,
            stage: 'pre_eod',
            actor: 'EOD',
            labelDate: '2026-08-04',
        });
        assert.equal(pkg.ok, true);
        const alias = path.join(dataRoot, 'backups', 'tgp_ops_pre_eod_2026-08-04.db');
        assert.ok(fs.existsSync(alias), 'pre_eod daily alias must exist');
        assert.equal(fs.existsSync(path.join(dataRoot, 'backups', 'tgp_ops_backup_2026-08-04.db')), false);
        assert.equal(verifyOpsDatabaseCopy(alias).ok, true);
    } finally {
        close();
    }
});

test('post_eod and manual promote tgp_ops_backup alias', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        for (const stage of ['post_eod', 'manual']) {
            const labelDate = stage === 'post_eod' ? '2026-08-05' : '2026-08-06';
            const pkg = await createBackupPackage({
                db,
                dataRoot,
                stage,
                actor: 'TEST',
                labelDate,
            });
            assert.equal(pkg.ok, true, `${stage} package ok`);
            const alias = path.join(dataRoot, 'backups', `tgp_ops_backup_${labelDate}.db`);
            assert.ok(fs.existsSync(alias), `${stage} daily alias must exist`);
            assert.equal(fs.existsSync(path.join(dataRoot, 'backups', `tgp_ops_pre_eod_${labelDate}.db`)), false);
        }
    } finally {
        close();
    }
});

test('weekly promotes tgp_ops_backup alias under backups', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        const pkg = await createBackupPackage({
            db,
            dataRoot,
            stage: 'weekly',
            actor: 'TEST',
            labelDate: '2026-08-08',
        });
        assert.equal(pkg.ok, true);
        const alias = path.join(dataRoot, 'backups', 'tgp_ops_backup_2026-08-08.db');
        assert.ok(fs.existsSync(alias), 'weekly daily alias must exist');
        assert.equal(fs.existsSync(path.join(dataRoot, 'backups', 'tgp_ops_pre_eod_2026-08-08.db')), false);
        assert.equal(verifyOpsDatabaseCopy(alias).ok, true);
    } finally {
        close();
    }
});

test('migration stage does not write daily EOD alias names', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        const pkg = await createBackupPackage({
            db,
            dataRoot,
            stage: 'migration',
            actor: 'boot',
            labelDate: '2026-08-04',
        });
        assert.equal(pkg.ok, true);
        assert.ok(fs.existsSync(pkg.directory));
        assert.equal(fs.existsSync(path.join(dataRoot, 'backups', 'tgp_ops_backup_2026-08-04.db')), false);
        assert.equal(fs.existsSync(path.join(dataRoot, 'backups', 'tgp_ops_pre_eod_2026-08-04.db')), false);
        const topLevelDbs = fs.readdirSync(path.join(dataRoot, 'backups'))
            .filter((name) => /^tgp_ops_(backup|pre_eod|weekly)_/.test(name));
        assert.deepEqual(topLevelDbs, []);
    } finally {
        close();
    }
});

test('failed promote leaves prior daily alias intact', () => {
    const backupsDir = tempDir();
    const labelDate = '2026-08-09';
    const alias = path.join(backupsDir, `tgp_ops_backup_${labelDate}.db`);
    fs.writeFileSync(alias, 'PRIOR_GOOD_ALIAS');
    const opsDbPath = path.join(backupsDir, 'pkg_src', 'tgp_ops.db');
    fs.mkdirSync(path.dirname(opsDbPath), { recursive: true });
    fs.writeFileSync(opsDbPath, 'NEW_OPS_COPY');

    assert.throws(
        () => promoteDailyAlias(backupsDir, opsDbPath, 'manual', labelDate, {
            linkSync: () => { throw new Error('hardlink unavailable'); },
            copyFileSync: () => { throw new Error('staged copy failed'); },
        }),
        /staged copy failed/,
    );
    assert.equal(fs.readFileSync(alias, 'utf8'), 'PRIOR_GOOD_ALIAS');
    assert.equal(
        fs.readdirSync(backupsDir).some((name) => name.includes('.tmp')),
        false,
        'failed promote must not leave temp staging files',
    );
});

test('promoteDailyAlias replaces prior alias after successful staging', () => {
    const backupsDir = tempDir();
    const labelDate = '2026-08-10';
    const alias = path.join(backupsDir, `tgp_ops_backup_${labelDate}.db`);
    fs.writeFileSync(alias, 'PRIOR_GOOD_ALIAS');
    const opsDbPath = path.join(backupsDir, 'pkg_src', 'tgp_ops.db');
    fs.mkdirSync(path.dirname(opsDbPath), { recursive: true });
    fs.writeFileSync(opsDbPath, 'NEW_VERIFIED_OPS');

    const dest = promoteDailyAlias(backupsDir, opsDbPath, 'manual', labelDate);
    assert.equal(dest, alias);
    assert.equal(fs.readFileSync(alias, 'utf8'), 'NEW_VERIFIED_OPS');
});

test('post-verify I/O failure returns structured failResult', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        seedSidecars(dataRoot);
        const pkg = await createBackupPackage({
            db,
            dataRoot,
            stage: 'manual',
            actor: 'TEST',
            labelDate: '2026-08-11',
            // Force inventory online-backup fallback so the injectable copyFileSync path runs.
            copyInventoryDbOnline: async () => {
                throw new Error('force inventory copyFileSync fallback');
            },
            copyFileSync: () => {
                throw new Error('ENOSPC simulated');
            },
        });
        assert.equal(pkg.ok, false);
        assert.equal(pkg.code, 'BACKUP_PACKAGE_IO_FAILED');
        assert.match(String(pkg.error), /ENOSPC simulated/);
        assert.equal(typeof pkg, 'object');
    } finally {
        close();
    }
});

test('missing optional sidecars still succeed with ops and manifest', async (t) => {
    const store = makeIsolatedStore(t);
    if (!store) return;
    const { db, dataRoot, close } = store;
    try {
        const pkg = await createBackupPackage({
            db,
            dataRoot,
            stage: 'manual',
            actor: 'TEST',
            labelDate: '2026-08-04',
        });
        assert.equal(pkg.ok, true);
        assert.ok(pkg.manifest.artifacts.some((a) => a.role === 'ops_db'));
        assert.equal(pkg.manifest.artifacts.some((a) => a.role === 'inventory_db'), false);
        assert.equal(pkg.manifest.artifacts.some((a) => a.role === 'incident_attachments'), false);
        assert.equal(pkg.manifest.artifacts.some((a) => a.role === 'store_transfers'), false);
        assert.ok(fs.existsSync(path.join(pkg.directory, 'manifest.json')));

        seedSidecars(dataRoot);
        const withSidecars = await createBackupPackage({
            db,
            dataRoot,
            stage: 'manual',
            actor: 'TEST',
            labelDate: '2026-08-07',
        });
        assert.equal(withSidecars.ok, true);
        assert.ok(withSidecars.manifest.artifacts.some((a) => a.role === 'inventory_db'));
        assert.ok(withSidecars.manifest.artifacts.some((a) => a.role === 'incident_attachments'));
        assert.ok(withSidecars.manifest.artifacts.some((a) => a.role === 'store_transfers'));
    } finally {
        close();
    }
});
