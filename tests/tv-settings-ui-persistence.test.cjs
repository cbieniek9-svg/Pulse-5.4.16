'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
    path.join(__dirname, '..', 'client', 'src', 'settings', 'lib', 'settingsHelpers.js'),
    'utf8',
);

test('TV display checkboxes use robust setting boolean parsing', () => {
    assert.match(source, /export function settingIsEnabled\(settings, key, defaultValue = true\)/);
    assert.match(source, /typeof raw === 'number'\) return raw !== 0/);
    assert.match(source, /\['0', 'false', 'off', 'no'\]\.includes\(s\)/);

    assert.doesNotMatch(source, /TV_Show_Pinned_Daily_Huddle\s*!==\s*'0'/);
    assert.doesNotMatch(source, /TV_Show_Store_Comms\s*!==\s*'0'/);
    assert.doesNotMatch(source, /TV_Show_Audit_Trail\s*!==\s*'0'/);
    assert.doesNotMatch(source, /TV_Show_Ticker\s*!==\s*'0'/);
    assert.doesNotMatch(source, /TV_Show_Latest_Shift_Update\s*!==\s*'0'/);
});
