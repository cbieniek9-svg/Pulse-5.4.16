#!/usr/bin/env node
'use strict';

/**
 * Start the Command Center API for Playwright / CI without a BrowserWindow.
 * Usage: node scripts/start-api-for-tests.cjs
 */
const path = require('path');
const { spawn } = require('child_process');

const appRoot = path.resolve(__dirname, '..');
const electronPath = require('electron');
const profileDir = path.join(
    process.env.TGP_DATA_DIR || path.join(appRoot, 'tests', '.e2e-data'),
    '.electron-profile',
);

const child = spawn(electronPath, [`--user-data-dir=${profileDir}`, '.', '--headless-test'], {
    cwd: appRoot,
    env: {
        ...process.env,
        TGP_HEADLESS_TEST: '1',
        TGP_TEST_MODE: process.env.TGP_TEST_MODE || '1',
        ELECTRON_ENABLE_LOGGING: '1',
    },
    stdio: 'inherit',
    windowsHide: true,
});

function onSigInt() { child.kill('SIGINT'); }
function onSigTerm() { child.kill('SIGTERM'); }
process.on('SIGINT', onSigInt);
process.on('SIGTERM', onSigTerm);

child.on('exit', (code, signal) => {
    process.removeListener('SIGINT', onSigInt);
    process.removeListener('SIGTERM', onSigTerm);
    if (signal) {
        const map = { SIGINT: 2, SIGTERM: 15 };
        const n = map[signal] || 1;
        process.exit(128 + n);
    }
    process.exit(code == null ? 1 : code);
});
