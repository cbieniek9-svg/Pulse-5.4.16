'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { inspectBackupDatabase } = require('./backup-health.cjs');

const BACKUP_VERIFICATION_FAILED = 'BACKUP_VERIFICATION_FAILED';
const BACKUP_PACKAGE_IO_FAILED = 'BACKUP_PACKAGE_IO_FAILED';
const PACKAGE_ID_RE = /^[A-Za-z0-9._-]+$/;

function hashFile(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(64 * 1024);
        for (;;) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, null);
            if (bytesRead <= 0) break;
            hash.update(buf.subarray(0, bytesRead));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function walkFiles(rootDir) {
    const out = [];
    if (!fs.existsSync(rootDir)) return out;
    const stack = [rootDir];
    while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) out.push(full);
        }
    }
    // Locale-independent: code-unit order (not localeCompare).
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function hashTree(rootDir) {
    const hash = crypto.createHash('sha256');
    const files = walkFiles(rootDir);
    for (const file of files) {
        const rel = path.relative(rootDir, file).split(path.sep).join('/');
        hash.update(rel);
        hash.update('\0');
        hash.update(fs.readFileSync(file));
        hash.update('\0');
    }
    return hash.digest('hex');
}

function directoryByteSize(rootDir) {
    return walkFiles(rootDir).reduce((sum, file) => sum + fs.statSync(file).size, 0);
}

function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDirRecursive(from, to);
        else if (entry.isFile()) fs.copyFileSync(from, to);
    }
}

async function copyInventoryDbOnline(inventorySrc, invDest) {
    let Database;
    try {
        Database = require('better-sqlite3');
    } catch (_) {
        throw new Error('better-sqlite3 unavailable');
    }
    const src = new Database(inventorySrc, { readonly: true, fileMustExist: true });
    try {
        if (typeof src.backup !== 'function') {
            throw new Error('database backup() is unavailable');
        }
        fs.mkdirSync(path.dirname(invDest), { recursive: true });
        await src.backup(invDest);
    } finally {
        src.close();
    }
}

function pushDirArtifact(artifacts, role, relPath, srcDir, destDir) {
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return;
    copyDirRecursive(srcDir, destDir);
    artifacts.push({
        role,
        path: relPath,
        size: directoryByteSize(destDir),
        hash: hashTree(destDir),
    });
}

function pushInventoryArtifact(artifacts, invDest) {
    artifacts.push({
        role: 'inventory_db',
        path: 'pulse_inventory.db',
        size: fs.statSync(invDest).size,
        hash: hashFile(invDest),
    });
}

/**
 * Copy optional package sidecars into packageDir and return artifact descriptors.
 * Ops DB is handled by the caller (online backup or sync VACUUM INTO path).
 * Inventory prefers better-sqlite3 backup(); falls back to copyFileSync.
 */
async function assemblePackageSidecars({
    dataRoot,
    packageDir,
    copyFileSync: copyFileSyncOpt,
    copyInventoryDbOnline: copyInventoryDbOnlineOpt,
} = {}) {
    if (!dataRoot || !packageDir) {
        throw new Error('dataRoot and packageDir are required');
    }
    const copyFileSync = copyFileSyncOpt || ((src, dest) => fs.copyFileSync(src, dest));
    const copyInventory = copyInventoryDbOnlineOpt || copyInventoryDbOnline;
    const artifacts = [];

    const inventorySrc = path.join(dataRoot, 'data', 'pulse_inventory.db');
    if (fs.existsSync(inventorySrc) && fs.statSync(inventorySrc).isFile()) {
        const invDest = path.join(packageDir, 'pulse_inventory.db');
        try {
            await copyInventory(inventorySrc, invDest);
        } catch (_) {
            copyFileSync(inventorySrc, invDest);
        }
        pushInventoryArtifact(artifacts, invDest);
    }

    pushDirArtifact(
        artifacts,
        'incident_attachments',
        'incident_investigations',
        path.join(dataRoot, 'data', 'incident_investigations'),
        path.join(packageDir, 'incident_investigations'),
    );
    pushDirArtifact(
        artifacts,
        'store_transfers',
        'store-transfers',
        path.join(dataRoot, 'store-transfers'),
        path.join(packageDir, 'store-transfers'),
    );

    return artifacts;
}

/** Sync sidecars for migration boot (inventory via copyFileSync only). */
function assemblePackageSidecarsSync({ dataRoot, packageDir, copyFileSync: copyFileSyncOpt } = {}) {
    if (!dataRoot || !packageDir) {
        throw new Error('dataRoot and packageDir are required');
    }
    const copyFileSync = copyFileSyncOpt || ((src, dest) => fs.copyFileSync(src, dest));
    const artifacts = [];

    const inventorySrc = path.join(dataRoot, 'data', 'pulse_inventory.db');
    if (fs.existsSync(inventorySrc) && fs.statSync(inventorySrc).isFile()) {
        const invDest = path.join(packageDir, 'pulse_inventory.db');
        copyFileSync(inventorySrc, invDest);
        pushInventoryArtifact(artifacts, invDest);
    }

    pushDirArtifact(
        artifacts,
        'incident_attachments',
        'incident_investigations',
        path.join(dataRoot, 'data', 'incident_investigations'),
        path.join(packageDir, 'incident_investigations'),
    );
    pushDirArtifact(
        artifacts,
        'store_transfers',
        'store-transfers',
        path.join(dataRoot, 'store-transfers'),
        path.join(packageDir, 'store-transfers'),
    );

    return artifacts;
}

function verifyOpsDatabaseCopy(filePath, opts = {}) {
    return inspectBackupDatabase(filePath, opts);
}

async function copyOpsDbOnline(db, destPath) {
    if (!db || typeof db.backup !== 'function') {
        throw new Error('database backup() is unavailable');
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    await db.backup(destPath);
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function formatLabelDate(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatHms(d) {
    return `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function dailyAliasName(stage, labelDate) {
    if (stage === 'pre_eod') return `tgp_ops_pre_eod_${labelDate}.db`;
    if (stage === 'post_eod' || stage === 'manual' || stage === 'weekly') {
        return `tgp_ops_backup_${labelDate}.db`;
    }
    return null;
}

function cleanupPath(filePath, unlinkSync = fs.unlinkSync.bind(fs)) {
    try {
        if (filePath && fs.existsSync(filePath)) unlinkSync(filePath);
    } catch (_) { /* ignore */ }
}

/**
 * Stage a verified ops copy to a temp name, then rename into the daily alias.
 * Never unlinks the existing alias before the staged file is ready.
 */
function promoteDailyAlias(backupsDir, opsDbPath, stage, labelDate, deps = {}) {
    const name = dailyAliasName(stage, labelDate);
    if (!name) return null;

    const linkSync = deps.linkSync || ((src, dest) => fs.linkSync(src, dest));
    const copyFileSync = deps.copyFileSync || ((src, dest) => fs.copyFileSync(src, dest));
    const renameSync = deps.renameSync || ((src, dest) => fs.renameSync(src, dest));
    const unlinkSync = deps.unlinkSync || ((p) => fs.unlinkSync(p));
    const existsSync = deps.existsSync || ((p) => fs.existsSync(p));

    const dest = path.join(backupsDir, name);
    const tmp = path.join(
        backupsDir,
        `.${name}.${process.pid}.${Date.now()}.tmp`,
    );
    const bak = `${dest}.${process.pid}.bak`;

    try {
        try {
            linkSync(opsDbPath, tmp);
        } catch (_) {
            copyFileSync(opsDbPath, tmp);
        }

        if (!existsSync(dest)) {
            renameSync(tmp, dest);
            return dest;
        }

        // Windows cannot rename over an existing file: move prior aside, then
        // swap in the staged copy. Restore prior if the final rename fails.
        cleanupPath(bak, unlinkSync);
        renameSync(dest, bak);
        try {
            renameSync(tmp, dest);
        } catch (err) {
            try {
                if (existsSync(bak) && !existsSync(dest)) renameSync(bak, dest);
            } catch (_) { /* ignore restore errors */ }
            throw err;
        }
        cleanupPath(bak, unlinkSync);
        return dest;
    } catch (e) {
        cleanupPath(tmp, unlinkSync);
        throw e;
    }
}

function cleanupPackageDir(directory, backupsDir) {
    try {
        if (!directory || !fs.existsSync(directory)) return;
        if (backupsDir) {
            const root = path.resolve(backupsDir);
            const target = path.resolve(directory);
            const rel = path.relative(root, target);
            if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
        }
        fs.rmSync(directory, { recursive: true, force: true });
    } catch (_) { /* ignore */ }
}

function failResult({ packageId, directory, opsDbPath, labelDate, error, code = BACKUP_VERIFICATION_FAILED, backupsDir = null }) {
    cleanupPackageDir(directory, backupsDir);
    return {
        ok: false,
        packageId: packageId || null,
        directory: directory || null,
        opsDbPath: opsDbPath || null,
        manifest: null,
        labelDate: labelDate || null,
        error: error || 'backup verification failed',
        code,
    };
}

async function createBackupPackage({
    db,
    dataRoot,
    stage,
    actor = '',
    labelDate,
    packageId,
    now,
    copyFileSync: copyFileSyncOpt,
    copyInventoryDbOnline: copyInventoryDbOnlineOpt,
    promoteDailyAlias: promoteOpt,
} = {}) {
    if (!dataRoot) {
        return failResult({ error: 'dataRoot is required', labelDate: labelDate || null });
    }
    if (!stage) {
        return failResult({ error: 'stage is required', labelDate: labelDate || null });
    }

    const when = now instanceof Date ? now : new Date();
    const date = labelDate || formatLabelDate(when);
    const id = String(packageId || `pkg_${stage}_${date}_${formatHms(when)}`);
    // PACKAGE_ID_RE allows '.' / '..'; reject those explicitly and keep the package under backupsDir.
    if (!PACKAGE_ID_RE.test(id) || id === '.' || id === '..') {
        return failResult({
            packageId: id,
            labelDate: date,
            error: 'invalid package id',
            code: BACKUP_PACKAGE_IO_FAILED,
        });
    }
    const backupsDir = path.join(dataRoot, 'backups');
    const directory = path.join(backupsDir, id);
    const backupsRootResolved = path.resolve(backupsDir);
    const directoryResolved = path.resolve(directory);
    if (
        directoryResolved !== backupsRootResolved
        && !directoryResolved.startsWith(backupsRootResolved + path.sep)
    ) {
        return failResult({
            packageId: id,
            labelDate: date,
            error: 'invalid package id',
            code: BACKUP_PACKAGE_IO_FAILED,
        });
    }
    const opsDbPath = path.join(directory, 'tgp_ops.db');
    const copyFileSync = copyFileSyncOpt || ((src, dest) => fs.copyFileSync(src, dest));
    const promote = promoteOpt || promoteDailyAlias;

    try {
        fs.mkdirSync(directory, { recursive: true });
    } catch (e) {
        return failResult({
            packageId: id,
            directory,
            labelDate: date,
            error: e.message || String(e),
            code: BACKUP_PACKAGE_IO_FAILED,
            backupsDir,
        });
    }

    try {
        await copyOpsDbOnline(db, opsDbPath);
    } catch (e) {
        return failResult({
            packageId: id,
            directory,
            opsDbPath,
            labelDate: date,
            error: e.message || String(e),
            backupsDir,
        });
    }

    const verification = verifyOpsDatabaseCopy(opsDbPath);
    if (!verification.ok) {
        return failResult({
            packageId: id,
            directory,
            opsDbPath,
            labelDate: date,
            error: verification.error || 'ops database verification failed',
            backupsDir,
        });
    }

    try {
        const artifacts = [{
            role: 'ops_db',
            path: 'tgp_ops.db',
            size: fs.statSync(opsDbPath).size,
            hash: hashFile(opsDbPath),
        }];
        artifacts.push(...await assemblePackageSidecars({
            dataRoot,
            packageDir: directory,
            copyFileSync,
            copyInventoryDbOnline: copyInventoryDbOnlineOpt,
        }));

        const manifest = {
            packageId: id,
            stage,
            actor: actor || '',
            created_at: when.toISOString(),
            labelDate: date,
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

        // Package is complete once manifest is written. Alias promote is best-effort
        // so a promote failure must not flip a verified package to ok:false.
        try {
            promote(backupsDir, opsDbPath, stage, date);
        } catch (_) { /* ignore promote errors */ }

        return {
            ok: true,
            packageId: id,
            directory,
            opsDbPath,
            manifest,
            labelDate: date,
            error: null,
            code: null,
        };
    } catch (e) {
        return failResult({
            packageId: id,
            directory,
            opsDbPath,
            labelDate: date,
            error: e.message || String(e),
            code: BACKUP_PACKAGE_IO_FAILED,
            backupsDir,
        });
    }
}

function loadManifest(packageDir) {
    const file = path.join(packageDir, 'manifest.json');
    if (!fs.existsSync(file)) {
        throw new Error(`manifest.json not found in ${packageDir}`);
    }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
    BACKUP_VERIFICATION_FAILED,
    BACKUP_PACKAGE_IO_FAILED,
    hashFile,
    walkFiles,
    hashTree,
    copyDirRecursive,
    directoryByteSize,
    assemblePackageSidecars,
    assemblePackageSidecarsSync,
    copyInventoryDbOnline,
    verifyOpsDatabaseCopy,
    copyOpsDbOnline,
    createBackupPackage,
    loadManifest,
    promoteDailyAlias,
    dailyAliasName,
};
