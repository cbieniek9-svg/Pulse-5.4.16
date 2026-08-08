'use strict';

const fs = require('fs');
const path = require('path');
const { getDataRoot, getBackupsDir, getDbPath } = require('../paths.cjs');
const { getBackupHealth } = require('./backup-health.cjs');

const REQUIRED_TABLES = [
    'tasks',
    'oos',
    'special_orders',
    'expected_orders',
    'staff',
    'counts',
    'settings',
    'rhythm_tasks',
    'vendor_schedule',
    'vendor_contacts',
    'audit_ledger',
    'trusted_devices',
    'shift_order_history',
    'daily_report_snapshots',
];

function firstValue(row) {
    if (!row || typeof row !== 'object') return undefined;
    const key = Object.keys(row)[0];
    return row[key];
}

function safeGet(db, sql) {
    try { return db.get(sql); } catch (e) { return { __error: e.message }; }
}

function safeAll(db, sql) {
    try { return db.all(sql); } catch (e) { return [{ __error: e.message }]; }
}

function getDiskSpace(dir = getDataRoot()) {
    if (typeof fs.statfsSync !== 'function') return null;
    try {
        const target = fs.existsSync(dir) ? dir : path.dirname(dir);
        const stat = fs.statfsSync(target);
        return {
            path: target,
            free_bytes: Number(stat.bavail) * Number(stat.bsize),
            total_bytes: Number(stat.blocks) * Number(stat.bsize),
        };
    } catch (_) {
        return null;
    }
}

function normalizeBackupAgeHours(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 72;
}

/**
 * Run a cheap-but-useful database health check against the app db wrapper.
 * Designed for single-store PoC recoverability: detect obvious corruption,
 * disabled WAL, missing app tables, stale/missing backups, and low disk space.
 */
function checkDatabaseHealth(db, opts = {}) {
    const warnings = [];
    const errors = [];
    const checks = {};
    const requiredTables = opts.requiredTables || REQUIRED_TABLES;
    const maxBackupAgeHours = normalizeBackupAgeHours(opts.maxBackupAgeHours);
    const nowMs = opts.now ? new Date(opts.now).getTime() : Date.now();

    const quickRows = safeAll(db, 'PRAGMA quick_check');
    const quickError = quickRows.find((r) => r && r.__error)?.__error;
    const quickValues = quickRows.map(firstValue).filter((v) => v !== undefined);
    checks.quick_check = quickError ? { ok: false, error: quickError } : { ok: quickValues.length > 0 && quickValues.every((v) => String(v).toLowerCase() === 'ok'), values: quickValues };
    if (!checks.quick_check.ok) errors.push(`SQLite quick_check failed: ${quickError || quickValues.join('; ') || 'unknown result'}`);

    const journalRow = safeGet(db, 'PRAGMA journal_mode');
    const journalError = journalRow.__error;
    const journalMode = journalError ? null : String(firstValue(journalRow) || '').toLowerCase();
    checks.journal_mode = { ok: journalMode === 'wal', value: journalMode || null, error: journalError || null };
    if (journalError) warnings.push(`Could not read journal_mode: ${journalError}`);
    else if (journalMode !== 'wal') warnings.push(`SQLite journal_mode is ${journalMode || 'unknown'}; expected wal`);

    const userVersionRow = safeGet(db, 'PRAGMA user_version');
    checks.user_version = userVersionRow.__error ? { ok: false, error: userVersionRow.__error } : { ok: true, value: Number(firstValue(userVersionRow) || 0) };

    const schemaRows = safeAll(db, "SELECT name FROM sqlite_master WHERE type='table'");
    const schemaError = schemaRows.find((r) => r && r.__error)?.__error;
    const tables = new Set(schemaRows.filter((r) => r && !r.__error).map((r) => r.name));
    const missingTables = schemaError ? requiredTables.slice() : requiredTables.filter((name) => !tables.has(name));
    checks.required_tables = {
        ok: !schemaError && missingTables.length === 0,
        missing: missingTables,
        count: tables.size,
        error: schemaError || null,
    };
    if (schemaError) errors.push(`Could not inspect schema: ${schemaError}`);
    else if (missingTables.length) errors.push(`Missing required table(s): ${missingTables.join(', ')}`);

    const disk = getDiskSpace(opts.dataRoot || getDataRoot());
    checks.disk_space = disk ? { ok: disk.free_bytes >= 500 * 1024 * 1024, ...disk } : { ok: true, unavailable: true };
    if (disk && disk.free_bytes < 500 * 1024 * 1024) warnings.push(`Low disk space: ${Math.round(disk.free_bytes / 1024 / 1024)} MB free`);

    let dbSize = null;
    try { dbSize = fs.statSync(opts.dbPath || getDbPath()).size; } catch (_) { /* locked or not present */ }
    checks.database_file = { ok: dbSize !== null, path: opts.dbPath || getDbPath(), size: dbSize };
    if (dbSize === null) warnings.push('Could not stat live database file');

    if (opts.checkBackups !== false) {
        const backupDir = opts.backupsDir || getBackupsDir();
        const backupHealth = getBackupHealth(backupDir);
        checks.backups = { ok: backupHealth.ok, ...backupHealth, max_age_hours: maxBackupAgeHours };
        if (!backupHealth.ok) {
            warnings.push('No verified generated backup found');
        } else if (backupHealth.latest_modified_at) {
            const ageHours = (nowMs - new Date(backupHealth.latest_modified_at).getTime()) / 36e5;
            checks.backups.latest_age_hours = Number(ageHours.toFixed(2));
            if (ageHours > maxBackupAgeHours) {
                warnings.push(`Latest verified backup is ${Math.round(ageHours)} hours old`);
            }
        }
    }

    return {
        ok: errors.length === 0,
        status: errors.length ? 'error' : (warnings.length ? 'warning' : 'ok'),
        checked_at: new Date(nowMs).toISOString(),
        errors,
        warnings,
        checks,
    };
}

function recordBootHealth(db, health) {
    if (!db || !health) return false;
    const rows = [
        ['Boot_Health_Last_Run', health.checked_at],
        ['Boot_Health_Status', health.status],
        ['Boot_Health_Errors', JSON.stringify(health.errors || [])],
        ['Boot_Health_Warnings', JSON.stringify(health.warnings || [])],
    ];

    try {
        const run = () => rows.forEach(([name, value]) => {
            db.run(
                'INSERT INTO settings (setting_name, setting_value) VALUES (?, ?) ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value',
                name,
                String(value ?? ''),
            );
        });
        if (typeof db.transaction === 'function') db.transaction(run)();
        else run();
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = {
    REQUIRED_TABLES,
    checkDatabaseHealth,
    recordBootHealth,
    getDiskSpace,
};
