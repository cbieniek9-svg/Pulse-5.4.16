'use strict';

/**
 * Ensures a deterministic staff row exists for /api/mobile-auth used by Playwright.
 * Writes `tests/.playwright-staff-cache.json` for workers.
 *
 * Seeds via `tests/playwright-seed.cjs` under Electron's Node (ELECTRON_RUN_AS_NODE)
 * so better-sqlite3 matches the native addon build.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CACHE_NAME = '.playwright-staff-cache.json';

module.exports = async () => {
    const cachePath = path.join(__dirname, CACHE_NAME);
    const appRoot = path.join(__dirname, '..');
    const electronExe = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    const seedScript = path.join(__dirname, 'playwright-seed.cjs');

    if (process.env.PLAYWRIGHT_STAFF_NAME && process.env.PLAYWRIGHT_STAFF_PIN) {
        try {
            fs.writeFileSync(cachePath, JSON.stringify({
                name: process.env.PLAYWRIGHT_STAFF_NAME,
                pin: process.env.PLAYWRIGHT_STAFF_PIN,
                csDeviceToken: process.env.PLAYWRIGHT_CS_DEVICE_TOKEN || '',
            }, null, 0), 'utf8');
        } catch (e) {
            console.warn('[playwright globalSetup] Could not write staff cache:', e.message);
        }
        return;
    }

    if (!fs.existsSync(electronExe)) {
        console.warn('[playwright globalSetup] Electron binary not found; set PLAYWRIGHT_STAFF_* or tests/playwright.local.env.');
        try { fs.unlinkSync(cachePath); } catch (_) { /* ignore */ }
        return;
    }

    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    const r = spawnSync(electronExe, [seedScript], {
        cwd: appRoot,
        env,
        encoding: 'utf8',
        windowsHide: true,
    });

    if (r.status !== 0) {
        console.warn('[playwright globalSetup] Seed script failed:', r.stderr || r.stdout || r.error?.message);
        try { fs.unlinkSync(cachePath); } catch (_) { /* ignore */ }
        return;
    }

    if (fs.existsSync(cachePath)) {
        console.log('[playwright globalSetup] Staff cache ready.');
    }
};
