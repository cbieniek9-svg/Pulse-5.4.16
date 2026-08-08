'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const { buildSteps, parseArgs } = require('../scripts/verify-release.cjs');

test('package exposes release verification scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['verify:release'], /verify-release\.cjs/);
    assert.match(pkg.scripts['verify:fresh-install'], /fresh-install-smoke\.cjs/);
    assert.match(pkg.scripts['verify:upgrade'], /upgrade-smoke\.cjs/);
});

test('verify-release step plan includes smoke checks and supports quick mode', () => {
    const steps = buildSteps({ quick: true });
    const names = steps.map((s) => s.name);
    assert.ok(names.includes('syntax-check'));
    assert.ok(names.includes('core-unit-tests'));
    assert.ok(names.includes('fresh-install-smoke'));
    assert.ok(names.includes('upgrade-smoke-copy'));
    assert.ok(!names.includes('store-deploy-preflight'));

    assert.equal(parseArgs(['--quick', '--skip-backup']).quick, true);
    assert.equal(parseArgs(['--quick', '--skip-backup']).skipBackup, true);
});
