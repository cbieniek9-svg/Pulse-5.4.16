'use strict';

const fs = require('fs');
const path = require('path');

const BACKUP_FILE_RE = /^tgp_ops_(backup|weekly)_\d{4}-\d{2}-\d{2}\.db$/i;
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8');

function isSafeBackupFilename(name) {
    return BACKUP_FILE_RE.test(String(name || ''));
}

function validateSqliteHeader(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(SQLITE_HEADER.length);
            const read = fs.readSync(fd, buf, 0, buf.length, 0);
            return read === SQLITE_HEADER.length && buf.equals(SQLITE_HEADER);
        } finally {
            fs.closeSync(fd);
        }
    } catch (_) {
        return false;
    }
}

function listBackupFiles(backupsDir) {
    if (!backupsDir || !fs.existsSync(backupsDir)) return [];
    return fs.readdirSync(backupsDir)
        .filter(isSafeBackupFilename)
        .map((file) => {
            const fullPath = path.join(backupsDir, file);
            const stat = fs.statSync(fullPath);
            return {
                file,
                size: stat.size,
                modified_at: stat.mtime.toISOString(),
                readable: validateSqliteHeader(fullPath),
            };
        })
        .sort((a, b) => String(b.modified_at).localeCompare(String(a.modified_at)));
}

function getBackupHealth(backupsDir) {
    const backups = listBackupFiles(backupsDir);
    const latest = backups[0] || null;
    let latestVerified = false;
    let latestVerifyError = null;

    if (latest) {
        const fullPath = path.join(backupsDir, latest.file);
        const inspection = inspectBackupDatabase(fullPath, { skipIntegrityCheck: true });
        latestVerified = Boolean(inspection.ok);
        latestVerifyError = inspection.error || null;
    }

    return {
        ok: Boolean(latestVerified),
        count: backups.length,
        latest_file: latest?.file || null,
        latest_modified_at: latest?.modified_at || null,
        latest_size: latest?.size || 0,
        latest_readable: Boolean(latest?.readable),
        latest_verified: latestVerified,
        latest_verify_error: latestVerifyError,
    };
}

function firstPragmaValue(row) {
    if (!row || typeof row !== 'object') return undefined;
    const key = Object.keys(row)[0];
    return row[key];
}

function openSqliteReadonly(filePath) {
    let Database;
    try {
        Database = require('better-sqlite3');
    } catch (e) {
        throw new Error(`better-sqlite3 unavailable: ${e.message || e}`);
    }
    return new Database(filePath, { readonly: true, fileMustExist: true });
}

/**
 * Performs a real SQLite read check on a backup file.
 * This is heavier than the header check, so it is used by drill scripts
 * and manager maintenance flows rather than every public sync call.
 */
function inspectBackupDatabase(filePath, opts = {}) {
    const requiredTables = Array.isArray(opts.requiredTables) ? opts.requiredTables : [];
    const result = {
        ok: false,
        file: path.basename(filePath || ''),
        path: filePath,
        header_ok: false,
        quick_check: null,
        integrity_check: null,
        user_version: null,
        table_count: 0,
        missing_tables: [],
        error: null,
    };

    if (!filePath || !fs.existsSync(filePath)) {
        result.error = 'backup file not found';
        return result;
    }

    result.header_ok = validateSqliteHeader(filePath);
    if (!result.header_ok) {
        result.error = 'invalid SQLite header';
        return result;
    }

    let db;
    try {
        db = openSqliteReadonly(filePath);
        const quickRows = db.pragma('quick_check');
        const integrityRows = opts.skipIntegrityCheck ? [{ integrity_check: 'skipped' }] : db.pragma('integrity_check');
        const quickValues = quickRows.map(firstPragmaValue).map(String);
        const integrityValues = integrityRows.map(firstPragmaValue).map(String);
        const userVersionRow = db.pragma('user_version')[0];

        const tableRows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
        const tables = new Set(tableRows.map((r) => r.name));
        result.quick_check = quickValues;
        result.integrity_check = integrityValues;
        result.user_version = Number(firstPragmaValue(userVersionRow) || 0);
        result.table_count = tables.size;
        result.missing_tables = requiredTables.filter((name) => !tables.has(name));
        result.ok = quickValues.every((v) => v.toLowerCase() === 'ok')
            && (opts.skipIntegrityCheck || integrityValues.every((v) => v.toLowerCase() === 'ok'))
            && result.missing_tables.length === 0;
        if (!result.ok) {
            if (!quickValues.every((v) => v.toLowerCase() === 'ok')) result.error = `quick_check failed: ${quickValues.join('; ')}`;
            else if (!opts.skipIntegrityCheck && !integrityValues.every((v) => v.toLowerCase() === 'ok')) result.error = `integrity_check failed: ${integrityValues.join('; ')}`;
            else if (result.missing_tables.length) result.error = `missing required table(s): ${result.missing_tables.join(', ')}`;
        }
        return result;
    } catch (e) {
        result.error = e.message || String(e);
        return result;
    } finally {
        try { if (db) db.close(); } catch (_) { /* ignore */ }
    }
}

module.exports = {
    BACKUP_FILE_RE,
    SQLITE_HEADER,
    isSafeBackupFilename,
    validateSqliteHeader,
    listBackupFiles,
    getBackupHealth,
    inspectBackupDatabase,
};
