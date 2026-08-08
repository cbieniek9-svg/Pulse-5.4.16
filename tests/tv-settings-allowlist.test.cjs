'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MANAGER_WRITABLE_SETTINGS } = require('../src/constants/api-settings.cjs');

const TV_DISPLAY_SETTING_KEYS = [
    'TV_Show_Pinned_Daily_Huddle',
    'TV_Show_Store_Comms',
    'TV_Show_Audit_Trail',
    'TV_Show_Ticker',
    'TV_Show_Latest_Shift_Update',
];

test('TV display toggles are manager-writable settings', () => {
    TV_DISPLAY_SETTING_KEYS.forEach((key) => {
        assert.equal(MANAGER_WRITABLE_SETTINGS.has(key), true, `${key} should be manager writable`);
    });
});
