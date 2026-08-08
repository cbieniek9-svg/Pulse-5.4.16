'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const APP_ROOT = path.resolve(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}

test('sync payload exposes computed TV display preferences', () => {
    const sync = read('src/dal/sync-payload.cjs');
    const prefs = read('src/lib/tv-display-prefs.cjs');

    assert.match(sync, /buildTvDisplayPrefs/);
    assert.match(sync, /tv_display:\s*tvDisplay/);
    assert.match(prefs, /function buildTvDisplayPrefs/);
    assert.match(prefs, /TV_Show_Store_Comms/);
    assert.match(prefs, /TV_Show_Ticker/);
});

test('native TV renderer applies toggles to DOM, not only settings save UI', () => {
    const tv = read('public/tv/tv-dashboard.js');

    assert.match(tv, /function applyTvDisplayPrefsToDom/);
    assert.match(tv, /dataset\.tvShowStoreComms/);
    assert.doesNotMatch(tv, /document\.getElementById\('tv-comms-section'\)\?\.remove\(\)/);
    assert.match(tv, /wrap\.style\.display = 'none'/);
    assert.match(tv, /window\.TgpTvNative = \{/);
    assert.match(tv, /applyTvDisplayPrefsToDom/);
});

test('TV overlay guard does not re-show hidden comms/ticker sections', () => {
    const overrides = read('public/tv/tv-overrides.js');

    assert.match(overrides, /function applyDisplayToggleGuards/);
    assert.match(overrides, /readTvDisplayPrefs/);
    assert.doesNotMatch(overrides, /document\.getElementById\('tv-comms-section'\)\?\.remove\(\)/);
    assert.match(overrides, /tv-ticker-wrap/);
});
