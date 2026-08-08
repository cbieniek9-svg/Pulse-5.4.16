'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const helpersPath = path.join(__dirname, '..', 'client', 'src', 'settings', 'lib', 'settingsHelpers.js');
const floorUtilsPath = path.join(__dirname, '..', 'client', 'src', 'lib', 'floorUtils.js');

test('React settings helpers classify shifts and parse booleans', () => {
    const helpers = fs.readFileSync(helpersPath, 'utf8');
    const floor = fs.readFileSync(floorUtilsPath, 'utf8');
    // Classifier lives once in floorUtils; Settings re-exports so Staff + roster never disagree.
    assert.match(helpers, /export \{[\s\S]*classifyImportedShift[\s\S]*\} from '\.\.\/\.\.\/lib\/floorUtils\.js'/);
    assert.match(helpers, /export \{[\s\S]*rhythmScheduleDeptValue[\s\S]*\} from '\.\.\/\.\.\/lib\/floorUtils\.js'/);
    assert.ok(!/function classifyImportedShift/.test(helpers), 'no duplicate classifier in settings');
    assert.match(helpers, /export function settingIsEnabled/);
    assert.match(helpers, /typeof raw === 'number'\) return raw !== 0/);
    assert.match(floor, /export function classifyImportedShift/);
    assert.match(floor, /\/supervisor\|\\bsupv\\b\|\\bsup\\b\//);
});
