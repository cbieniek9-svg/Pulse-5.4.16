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

child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 1 : code);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
