'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP_ROOT = path.resolve(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}

test('TV display toggle settings are seeded and migrated', () => {
    const db = read('src/db.cjs');
    const migration = read('src/migrations/024_tv_display_toggles.cjs');
    const stabilization = read('src/migrations/025_tv_display_stabilization.cjs');

    [
        'TV_Show_Pinned_Daily_Huddle',
        'TV_Show_Store_Comms',
        'TV_Show_Audit_Trail',
        'TV_Show_Ticker',
        'TV_Show_Latest_Shift_Update',
    ].forEach((key) => {
        assert.match(db, new RegExp(key));
        assert.match(migration, new RegExp(key));
        assert.match(stabilization, new RegExp(key));
    });

    assert.match(stabilization, /TV_Show_Ticker/);
    assert.match(stabilization, /setting_value='0'/);
});

test('React settings StoreTvTab can save TV display toggles', () => {
    const jsx = read('client/src/settings/tabs/StoreTvTab.jsx');

    [
        'TV_Show_Pinned_Daily_Huddle',
        'TV_Show_Store_Comms',
        'TV_Show_Audit_Trail',
        'TV_Show_Ticker',
        'TV_Show_Latest_Shift_Update',
    ].forEach((key) => {
        assert.match(jsx, new RegExp(key));
    });

    assert.match(jsx, /tvShowStoreComms/);
    assert.match(jsx, /tvShowTicker/);
    assert.match(jsx, /settingIsEnabled/);
});

test('TV dashboard respects display toggles without redesigning layout', () => {
    const js = read('public/tv/tv-dashboard.js');

    assert.match(js, /function tvDisplayPrefs/);
    assert.match(js, /showStoreComms/);
    assert.match(js, /showAuditTrail/);
    assert.match(js, /showTicker/);
    assert.match(js, /showPinnedDailyHuddle/);
    assert.match(js, /showLatestShiftUpdate/);
    assert.match(js, /function renderCommsPinned/);
    assert.match(js, /function renderRight/);
    assert.match(js, /function renderTicker/);
});
