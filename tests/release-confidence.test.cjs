'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');
const {
    buildSteps,
    parseArgs,
    resolveSqliteRuntime,
    runStep,
} = require('../scripts/verify-release.cjs');

test('package exposes release verification scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['verify:release'], /verify-release\.cjs/);
    assert.match(pkg.scripts['verify:fresh-install'], /fresh-install-smoke\.cjs/);
    assert.match(pkg.scripts['verify:upgrade'], /upgrade-smoke\.cjs/);
    assert.equal(
        pkg.scripts['rebuild:electron'],
        'electron-rebuild -f -w better-sqlite3',
        'native rebuild must use the installed Electron version instead of a stale hard-coded version',
    );
    assert.match(pkg.scripts['prepare:store'], /fetch-service-runtime\.ps1 -SkipNode/);
    assert.match(pkg.scripts['prepare:store'], /verify:release/);
});

test('verify-release step plan includes smoke checks and supports quick mode', () => {
    const steps = buildSteps({ quick: true });
    const names = steps.map((s) => s.name);
    assert.ok(names.includes('syntax-check'));
    assert.ok(names.includes('production-runtime-probe'));
    assert.ok(names.includes('core-unit-tests'));
    assert.ok(names.includes('fresh-install-smoke'));
    assert.ok(names.includes('upgrade-smoke-copy'));
    assert.ok(!names.includes('store-deploy-preflight'));

    const sqliteRuntime = resolveSqliteRuntime();
    const core = steps.find((step) => step.name === 'core-unit-tests');
    assert.equal(core.command, sqliteRuntime.exe);
    assert.deepEqual(core.env, sqliteRuntime.env);
    assert.equal(core.failOnSkip, true);

    assert.equal(parseArgs(['--quick', '--skip-backup']).quick, true);
    assert.equal(parseArgs(['--quick', '--skip-backup']).skipBackup, true);
});

test('store deploy preflight checks runtime artifacts, not editor-only files', () => {
    const source = fs.readFileSync(path.join(appRoot, 'scripts', 'verify-store-deploy.cjs'), 'utf8');
    assert.doesNotMatch(source, /\.cursor\/rules/);
    assert.match(source, /Install-TGP-Service\.ps1 must regenerate it on the store PC/);
    assert.match(source, /mustWindowsExecutable\('service\/TGP-CommandCenter\.exe', 'WinSW service wrapper'\)/);
    assert.doesNotMatch(source, /--- unit tests ---/);

    const installer = fs.readFileSync(path.join(appRoot, 'service', 'Install-TGP-Service.ps1'), 'utf8');
    assert.match(installer, /if \(-not \(Test-Path \$Wrapper\)\)/);
    assert.doesNotMatch(installer, /Test-Path \$Wrapper\).*PortableNode/);
});

test('release steps configured for zero skips reject a successful skipped run', () => {
    const result = runStep(
        'skip-probe',
        process.execPath,
        ['-e', "console.log('skipped 1')"],
        { failOnSkip: true },
    );
    assert.equal(result.status, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.ok, false);
});
