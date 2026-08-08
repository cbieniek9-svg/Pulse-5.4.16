import { expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function managerCredentials() {
    const cachePath = path.join(__dirname, '..', '.playwright-staff-cache.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (!cache?.managerA?.name || !cache?.managerA?.pin) {
        throw new Error('Playwright manager credentials are unavailable.');
    }
    return cache.managerA;
}

export function csDeviceToken() {
    const cachePath = path.join(__dirname, '..', '.playwright-staff-cache.json');
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
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
