'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applySettingsBatch } = require('../src/lib/settings-batch.cjs');

function mockDb(initial = {}) {
    const settings = new Map(Object.entries(initial));
    return {
        settings,
        getSettings: () => Object.fromEntries(settings),
        run(sql, ...params) {
            if (sql.includes('ON CONFLICT') || sql.includes('INSERT INTO settings')) {
                settings.set(params[0], params[1]);
            }
        },
        transaction(fn) {
            return () => fn();
        },
        get() { return null; },
        all() { return []; },
    };
}

test('applySettingsBatch writes paired notes atomically', () => {
    const db = mockDb();
    const result = applySettingsBatch(db, [
        { setting_name: 'Shift_Notes', setting_value: 'hello' },
        { setting_name: 'Critical_Alert', setting_value: '1' },
    ], { isManager: false });
    assert.equal(result.count, 2);
    assert.equal(db.settings.get('Shift_Notes'), 'hello');
    assert.equal(db.settings.get('Critical_Alert'), '1');
});

test('applySettingsBatch rejects Order_Start', () => {
    const db = mockDb();
    assert.throws(
        () => applySettingsBatch(db, [{ setting_name: 'Order_Start', setting_value: 'x' }], { isManager: true }),
        /cannot be updated via settings batch/i,
    );
});

test('applySettingsBatch rejects clerk writing manager-only keys', () => {
    const db = mockDb();
    assert.throws(
        () => applySettingsBatch(db, [{ setting_name: 'TV_Scale', setting_value: '1.1' }], { isManager: false }),
        /Not allowed/i,
    );
});
