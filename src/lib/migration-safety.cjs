'use strict';

const fs = require('fs');
const path = require('path');

const {
    verifyOpsDatabaseCopy,
    assemblePackageSidecars,
    hashFile,
    BACKUP_VERIFICATION_FAILED,
} = require('./backup-package.cjs');

const SNAPSHOT_FILE_RE = /^tgp_ops_pre_migration_\d{4}-\d{2}-\d{2}_\d{4}(?:_\d+)?\.db$/i;
const MIGRATION_PACKAGE_DIR_RE = /^pkg_migration_\d{4}-\d{2}-\d{2}_\d{6}(?:_\d+)?$/i;
const MIGRATION_SNAPSHOT_REQUIRED = 'MIGRATION_SNAPSHOT_REQUIRED';

function pad(n) {
    return String(n).padStart(2, '0');
}

function stampFor(date = new Date()) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function formatLabelDate(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatHms(d) {
    return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function isSafeMigrationSnapshotFilename(name) {
    return SNAPSHOT_FILE_RE.test(String(name || ''));
}

function isSafeMigrationPackageDir(name) {
    return MIGRATION_PACKAGE_DIR_RE.test(String(name || ''));
}

function listMigrationSnapshots(backupsDir) {
    if (!backupsDir || !fs.existsSync(backupsDir)) return [];
    const entries = [];
    for (const name of fs.readdirSync(backupsDir)) {
        const fullPath = path.join(backupsDir, name);
        let stat;
        try {
            stat = fs.statSync(fullPath);
        } catch (_) {
            continue;
        }
        if (stat.isFile() && isSafeMigrationSnapshotFilename(name)) {
            entries.push({
                file: name,
                size: stat.size,
                modified_at: stat.mtime.toISOString(),
                kind: 'legacy_file',
            });
        } else if (stat.isDirectory() && isSafeMigrationPackageDir(name)) {
            entries.push({
                file: name,
                size: stat.size,
                modified_at: stat.mtime.toISOString(),
                kind: 'package',
                path: fullPath,
            });
        }
    }
    return entries.sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)));
}

function ensureUniquePath(dir, baseName) {
    let fullPath = path.join(dir, baseName);
    if (!fs.existsSync(fullPath)) return fullPath;
    const ext = path.extname(baseName);
    const stem = ext ? baseName.slice(0, -ext.length) : baseName;
    for (let i = 1; i < 1000; i++) {
        fullPath = path.join(dir, ext ? `${stem}_${i}${ext}` : `${stem}_${i}`);
        if (!fs.existsSync(fullPath)) return fullPath;
    }
    throw new Error(`Could not allocate unique migration snapshot name in ${dir}`);
}

function snapshotError(message, causeCode) {
    const err = new Error(message);
    err.code = MIGRATION_SNAPSHOT_REQUIRED;
    if (causeCode) err.causeCode = causeCode;
    return err;
}

function emptyResult(pendingMigrations) {
    return {
        ok: false,
        skipped: false,
        reason: '',
        file: null,
        path: null,
        packageId: null,
        pending_migrations: pendingMigrations.map((m) => m.file || String(m)),
        error: null,
        code: null,
    };
}

function resolveDataRoot(dataRoot, backupsDir) {
    if (dataRoot) return dataRoot;
    if (backupsDir) return path.dirname(backupsDir);
    return null;
}

/**
 * Sync consistent ops copy for migration boot (createBackupPackage is async).
 * Prefer VACUUM INTO; fall back to checkpoint + copyFileSync.
 */
function copyOpsDbForMigrationSync(db, dbPath, destPath) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (db && typeof db.exec === 'function') {
        try {
            const sqlPath = destPath.replace(/\\/g, '/').replace(/'/g, "''");
            db.exec(`VACUUM INTO '${sqlPath}'`);
            if (fs.existsSync(destPath)) return 'vacuum_into';
        } catch (_) {
            // Fall through to checkpoint + copy.
        }
    }
    try {
        if (db && typeof db.exec === 'function') db.exec('PRAGMA wal_checkpoint(FULL)');
    } catch (_) {
        // Snapshot can still proceed; SQLite will replay WAL if present.
    }
    fs.copyFileSync(dbPath, destPath);
    return 'copy';
}

function createVerifiedMigrationPackageSync({
    db,
    dbPath,
    dataRoot,
    backupsDir,
    now,
    actor = 'migration',
}) {
    const when = now instanceof Date ? now : new Date();
    const labelDate = formatLabelDate(when);
    const baseId = `pkg_migration_${labelDate}_${formatHms(when)}`;
    const directory = ensureUniquePath(backupsDir, baseId);
    const packageId = path.basename(directory);
    const opsDbPath = path.join(directory, 'tgp_ops.db');

    fs.mkdirSync(directory, { recursive: true });
    copyOpsDbForMigrationSync(db, dbPath, opsDbPath);

    const verification = verifyOpsDatabaseCopy(opsDbPath);
    if (!verification.ok) {
        try {
            fs.rmSync(directory, { recursive: true, force: true });
        } catch (_) { /* ignore */ }
        return {
            ok: false,
            packageId,
            directory,
            opsDbPath,
            error: verification.error || 'ops database verification failed',
            code: BACKUP_VERIFICATION_FAILED,
            manifest: null,
            labelDate,
        };
    }

    const artifacts = [{
        role: 'ops_db',
        path: 'tgp_ops.db',
        size: fs.statSync(opsDbPath).size,
        hash: hashFile(opsDbPath),
    }];
    artifacts.push(...assemblePackageSidecars({ dataRoot, packageDir: directory }));

    const manifest = {
        packageId,
        stage: 'migration',
        actor: actor || '',
        created_at: when.toISOString(),
        labelDate,
        artifacts,
        ops_verification: {
            ok: verification.ok,
            quick_check: verification.quick_check,
            integrity_check: verification.integrity_check,
            user_version: verification.user_version,
            table_count: verification.table_count,
            error: verification.error,
        },
    };
    fs.writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    // migration stage must never promote daily EOD aliases (dailyAliasName returns null).
    return {
        ok: true,
        packageId,
        directory,
        opsDbPath,
        manifest,
        labelDate,
        error: null,
        code: null,
    };
}

function mapPackageToSnapshotResult(pkg, pendingMigrations) {
    const result = emptyResult(pendingMigrations);
    if (!pkg || typeof pkg !== 'object') {
        result.error = 'createBackupPackage returned an invalid result';
        result.code = MIGRATION_SNAPSHOT_REQUIRED;
        return result;
    }
    if (pkg.ok) {
        result.ok = true;
        result.file = pkg.packageId || (pkg.directory ? path.basename(pkg.directory) : null);
        result.path = pkg.directory || pkg.opsDbPath || null;
        result.packageId = pkg.packageId || null;
        return result;
    }
    result.error = pkg.error || pkg.code || 'backup verification failed';
    result.code = pkg.code || BACKUP_VERIFICATION_FAILED;
    result.file = pkg.packageId || null;
    result.path = pkg.directory || null;
    result.packageId = pkg.packageId || null;
    return result;
}

/**
 * Create a verified migration-stage backup package before numbered migrations run.
 *
 * Boot remains synchronous, while createBackupPackage is async (better-sqlite3
 * backup()). Default path builds an equivalent verified package via VACUUM INTO
 * (or checkpoint + copy) + verifyOpsDatabaseCopy. Tests may inject
 * opts.createBackupPackage (sync). Thenables fail closed.
 *
 * Default failOnError is true — snapshot failure blocks pending migrations.
 */
function createPreMigrationSnapshot(opts = {}) {
    const {
        db,
        dbPath,
        backupsDir,
        dataRoot: dataRootOpt,
        pendingMigrations = [],
        now = new Date(),
        failOnError = true,
        createBackupPackage,
        actor = 'migration',
    } = opts;

    const result = emptyResult(pendingMigrations);

    try {
        if (!Array.isArray(pendingMigrations) || pendingMigrations.length === 0) {
            result.skipped = true;
            result.reason = 'no pending migrations';
            return result;
        }
        if (!dbPath || !fs.existsSync(dbPath)) {
            result.skipped = true;
            result.reason = 'database file does not exist yet';
            return result;
        }
        if (!backupsDir) throw snapshotError(`${MIGRATION_SNAPSHOT_REQUIRED}: backupsDir is required`);

        const dataRoot = resolveDataRoot(dataRootOpt, backupsDir);
        if (!dataRoot) throw snapshotError(`${MIGRATION_SNAPSHOT_REQUIRED}: dataRoot is required`);

        fs.mkdirSync(backupsDir, { recursive: true });

        let pkg;
        if (typeof createBackupPackage === 'function') {
            pkg = createBackupPackage({
                db,
                dataRoot,
                stage: 'migration',
                actor,
                now,
                labelDate: formatLabelDate(now instanceof Date ? now : new Date()),
            });
            if (pkg != null && typeof pkg.then === 'function') {
                throw snapshotError(
                    `${MIGRATION_SNAPSHOT_REQUIRED}: createBackupPackage returned a Promise; `
                    + 'sync boot requires a sync package implementation or the default verified snapshot path',
                );
            }
        } else {
            pkg = createVerifiedMigrationPackageSync({
                db,
                dbPath,
                dataRoot,
                backupsDir,
                now,
                actor,
            });
        }

        const mapped = mapPackageToSnapshotResult(pkg, pendingMigrations);
        if (!mapped.ok) {
            const err = snapshotError(
                `${MIGRATION_SNAPSHOT_REQUIRED}: ${mapped.error}`,
                mapped.code || BACKUP_VERIFICATION_FAILED,
            );
            if (failOnError) throw err;
            mapped.error = err.message;
            mapped.code = MIGRATION_SNAPSHOT_REQUIRED;
            return mapped;
        }
        return mapped;
    } catch (e) {
        if (e && e.code === MIGRATION_SNAPSHOT_REQUIRED) {
            if (failOnError) throw e;
            result.error = e.message || String(e);
            result.code = MIGRATION_SNAPSHOT_REQUIRED;
            return result;
        }
        const message = e && e.message ? e.message : String(e);
        const err = snapshotError(`${MIGRATION_SNAPSHOT_REQUIRED}: ${message}`);
        if (failOnError) throw err;
        result.error = err.message;
        result.code = MIGRATION_SNAPSHOT_REQUIRED;
        return result;
    }
}

module.exports = {
    SNAPSHOT_FILE_RE,
    MIGRATION_PACKAGE_DIR_RE,
    MIGRATION_SNAPSHOT_REQUIRED,
    createPreMigrationSnapshot,
    isSafeMigrationSnapshotFilename,
    isSafeMigrationPackageDir,
    listMigrationSnapshots,
    stampFor,
};
