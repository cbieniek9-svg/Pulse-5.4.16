'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    appendAppLog,
    recordAppError,
    readRecentErrors,
    SYNC_LAST_ERROR_KEY,
    RECENT_ERRORS_KEY,
} = require('../src/lib/app-log.cjs');
const { repairManagerHubSchema } = require('../src/lib/manager-hub-boot.cjs');

function tempLogPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-applog-'));
    return path.join(dir, 'tgp_error.log');
}

test('appendAppLog writes structured lines with context', () => {
    const logPath = tempLogPath();
    const original = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = path.dirname(logPath);
    try {
        appendAppLog('error', 'sync/manager_meta', 'no such column: shift_lead_eligible', {
            storeDate: '2026-07-12',
            sessionUser: 'Chris',
        });
        const text = fs.readFileSync(logPath, 'utf8');
        assert.match(text, /\[ERROR\] \[sync\/manager_meta\]/);
        assert.match(text, /shift_lead_eligible/);
        assert.match(text, /"sessionUser":"Chris"/);
    } finally {
        if (original === undefined) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = original;
    }
});

test('recordAppError persists recent and sync-last error settings', () => {
    const settings = new Map();
    const db = {
        get(sql, key) {
            if (!sql.includes('settings')) return null;
            const value = settings.get(key);
            return value == null ? undefined : { setting_value: value };
        },
        run(sql, key, value) {
            if (sql.includes('settings')) settings.set(key, value);
        },
    };

    recordAppError('sync/manager_meta', 'probe failed', new Error('probe failed'), {
        storeDate: '2026-07-12',
    }, db);

    const recent = readRecentErrors(db);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].scope, 'sync/manager_meta');
    const lastSync = JSON.parse(settings.get(SYNC_LAST_ERROR_KEY));
    assert.equal(lastSync.scope, 'sync/manager_meta');
    assert.equal(JSON.parse(settings.get(RECENT_ERRORS_KEY)).length, 1);
});

test('repairManagerHubSchema adds shift_lead_eligible when missing', () => {
    const sqlLog = [];
    const db = {
        all(sql) {
            sqlLog.push(sql);
            if (sql.includes('PRAGMA table_info(staff)')) {
                return [{ name: 'id' }, { name: 'name' }, { name: 'role' }];
            }
            return [];
        },
        exec(sql) { sqlLog.push(sql); },
        run(sql) { sqlLog.push(sql); },
    };
    const repairs = repairManagerHubSchema(db);
    assert.ok(repairs.some((r) => r.includes('shift_lead_eligible')));
    assert.ok(sqlLog.some((s) => String(s).includes('ALTER TABLE staff ADD COLUMN shift_lead_eligible')));
});
