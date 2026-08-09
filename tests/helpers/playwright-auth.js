import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '..', '.playwright-staff-cache.json');

/**
 * Shared reader for tests/.playwright-staff-cache.json.
 * @param {{ requireManagers?: boolean, requireSecurityPii?: boolean, optional?: boolean }} [opts]
 */
export function readPlaywrightStaffCache(opts = {}) {
    const {
        requireManagers = false,
        requireSecurityPii = false,
        optional = false,
    } = opts;

    let cache;
    try {
        cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch (err) {
        if (optional) return null;
        throw new Error(`Playwright staff cache unavailable: ${err.message || err}`);
    }

    for (const key of requireManagers ? ['managerA', 'managerB', 'storeManager'] : ['managerA']) {
        if (!cache?.[key]?.name || !cache?.[key]?.pin) {
            if (optional) return null;
            throw new Error(`Playwright ${key} credentials are unavailable.`);
        }
    }

    if (requireSecurityPii) {
        const pii = cache.securityPii;
        if (!pii?.customer || !pii?.contact || !pii?.notes) {
            if (optional) return null;
            throw new Error('Playwright security PII fixture is unavailable.');
        }
    }

    if (cache.name == null && cache.managerA?.name) {
        cache = { ...cache, name: cache.managerA.name, pin: cache.managerA.pin };
    }

    return cache;
}

export function managerCredentials() {
    return readPlaywrightStaffCache().managerA;
}

export function csDeviceToken() {
    const cache = readPlaywrightStaffCache();
    if (!cache?.csDeviceToken) throw new Error('Playwright cs_desk device token is unavailable.');
    return cache.csDeviceToken;
}

async function fillExplicitManagerName(page, manager) {
    const manualInput = page.getByLabel('Enter your name');
    if (!await manualInput.isVisible()) {
        await page.getByRole('button', { name: 'Enter name manually' }).click();
    }
    await manualInput.fill(manager.name);
}

export async function loginManagerMobile(page, manager = managerCredentials()) {
    await page.goto('/');
    await expect(page.locator('#auth-screen')).toBeVisible();
    await fillExplicitManagerName(page, manager);
    await page.getByLabel('Personal PIN').fill(manager.pin);
    await page.getByRole('button', { name: /UNLOCK UPLINK/i }).click();
    await expect(page.locator('#app-screen')).toBeVisible({ timeout: 15000 });
}

export async function loginPortal(page, path, enterLabel = /ENTER/i, manager = managerCredentials()) {
    await page.goto(path);
    await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15000 });
    await fillExplicitManagerName(page, manager);
    await page.getByLabel('Personal PIN').fill(manager.pin);
    await page.getByRole('button', { name: enterLabel }).click();
    await expect(page.locator('#auth-screen')).toBeHidden({ timeout: 15000 });
}
