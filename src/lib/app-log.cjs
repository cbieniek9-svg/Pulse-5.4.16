'use strict';

const fs = require('fs');
const { getLogPath } = require('../paths.cjs');

const RECENT_ERRORS_KEY = 'Recent_App_Errors';
const SYNC_LAST_ERROR_KEY = 'Sync_Last_Error';
const MAX_RECENT_ERRORS = 25;

function compactContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return undefined;
    const out = {};
    Object.entries(ctx).forEach(([key, value]) => {
        if (value === undefined || value === null || value === '') return;
        if (typeof value === 'string' && value.length > 240) {
            out[key] = `${value.slice(0, 237)}...`;
            return;
        }
        out[key] = value;
    });
    return Object.keys(out).length ? out : undefined;
}

function formatLine(level, scope, message, context) {
    const ctx = compactContext(context);
    const ctxSuffix = ctx ? ` | ctx=${JSON.stringify(ctx)}` : '';
    return `[${new Date().toISOString()}] [${String(level || 'INFO').toUpperCase()}] [${scope}] ${message}${ctxSuffix}`;
}

function appendAppLog(level, scope, message, context) {
    const line = `${formatLine(level, scope, message, context)}\n`;
    try { fs.appendFileSync(getLogPath(), line); } catch (_) { /* ignore */ }
    if (String(level || '').toLowerCase() === 'error') {
        console.error(line.trim());
    } else if (String(level || '').toLowerCase() === 'warn') {
        console.warn(line.trim());
    }
}

function readRecentErrors(db) {
    if (!db || typeof db.get !== 'function') return [];
    try {
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', RECENT_ERRORS_KEY);
        const parsed = row?.setting_value ? JSON.parse(row.setting_value) : [];
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function persistRecentError(db, entry) {
    if (!db || typeof db.run !== 'function') return;
    try {
        const next = [...readRecentErrors(db), entry].slice(-MAX_RECENT_ERRORS);
        db.run(
            'INSERT INTO settings (setting_name, setting_value) VALUES (?, ?) ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value',
            RECENT_ERRORS_KEY,
            JSON.stringify(next),
        );
    } catch (_) { /* ignore */ }
}

function persistSyncLastError(db, entry) {
    if (!db || typeof db.run !== 'function') return;
    try {
        db.run(
            'INSERT INTO settings (setting_name, setting_value) VALUES (?, ?) ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value',
            SYNC_LAST_ERROR_KEY,
            JSON.stringify(entry),
        );
    } catch (_) { /* ignore */ }
}

/**
 * Log an application error to tgp_error.log and optional in-DB recent error ring.
 * @param {string} scope e.g. sync/manager_meta, api/GET /api/sync
 * @param {string} message
 * @param {Error|string|null} err
 * @param {object} [context]
 * @param {object} [db]
 */
function recordAppError(scope, message, err, context = {}, db = null) {
    const detail = err instanceof Error ? err.message : String(err || message || '');
    const stack = err instanceof Error ? String(err.stack || '').split('\n').slice(0, 8).join('\n') : '';
    const ctx = compactContext(context);
    appendAppLog('error', scope, detail || message, ctx);
    if (stack) appendAppLog('error', scope, stack);

    const entry = {
        at: new Date().toISOString(),
        level: 'error',
        scope,
        message: message || detail,
        detail,
        context: ctx || null,
    };
    persistRecentError(db, entry);
    if (String(scope || '').startsWith('sync/')) {
        persistSyncLastError(db, entry);
    }
}

function logInfo(scope, message, context, db = null) {
    appendAppLog('info', scope, message, context);
    if (db) { /* reserved for future structured ring */ }
}

function logWarn(scope, message, context, db = null) {
    appendAppLog('warn', scope, message, context);
    if (db && String(scope || '').includes('receiving')) {
        try {
            persistRecentError(db, {
                at: new Date().toISOString(),
                level: 'warn',
                scope,
                message,
                detail: message,
                context: compactContext(context) || null,
            });
        } catch (_) { /* ignore */ }
    }
}

module.exports = {
    RECENT_ERRORS_KEY,
    SYNC_LAST_ERROR_KEY,
    appendAppLog,
    recordAppError,
    logInfo,
    logWarn,
    readRecentErrors,
};
