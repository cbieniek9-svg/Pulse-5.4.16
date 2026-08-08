'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.resolve(__dirname, '..');
const floorOps = fs.readFileSync(
    path.join(appRoot, 'client/src/components/floor/sidebar/OperationsLoggingPanel.jsx'),
    'utf8',
);
const floorApp = fs.readFileSync(path.join(appRoot, 'client/src/components/floor/FloorApp.jsx'), 'utf8');

test('React floor no longer renders the unused Quick Commands panel', () => {
    assert.equal(/QUICK COMMANDS/i.test(floorOps), false);
    assert.equal(/QUICK COMMANDS/i.test(floorApp), false);
    assert.equal(/id=["']omni["']/.test(floorOps), false);
    assert.equal(/handleQuickRecovery\(\)/.test(floorOps), false);
    assert.equal(/handleOmni\(\)/.test(floorOps), false);
});

test('manual task override remains available under Operations Logging', () => {
    assert.match(floorOps, /MANUAL TASK OVERRIDE/);
});
