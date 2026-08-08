'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStoreTemplate, loadStoreTemplate } = require('../src/lib/store-template.cjs');

test('loads default template JSON', () => {
    const t = loadStoreTemplate('default');
    assert.ok(t.rhythmTasks.everyday.length >= 5);
    assert.ok(t.vendorSchedule.Tuesday.includes('TGP'));
});

test('seeds empty rhythm tables', () => {
    const rhythm = [];
    const vendors = [];
    const settings = [];
    const db = {
        get(sql) {
            if (sql.includes('rhythm_tasks')) return rhythm.length ? { ok: 1 } : null;
            if (sql.includes('vendor_schedule')) return vendors.length ? { ok: 1 } : null;
            if (sql.includes('settings')) return null;
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO rhythm_tasks')) rhythm.push(params);
            if (sql.includes('INSERT INTO vendor_schedule')) vendors.push(params);
            if (sql.includes('INSERT OR REPLACE INTO settings') || sql.includes('INSERT INTO settings')) settings.push(params);
        },
        transaction(fn) { return () => fn(); },
    };
    const result = applyStoreTemplate(db, 'default');
    assert.equal(result.seededRhythm, true);
    assert.ok(rhythm.some((r) => r[2] === 'TGP Order'));
    assert.ok(vendors.length > 0);
});
