import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginManagerMobile, loginPortal } from './helpers/playwright-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function managerCredentials() {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '.playwright-staff-cache.json'), 'utf8'));
    if (!cache?.managerA?.name || !cache?.managerA?.pin) {
        throw new Error('Playwright manager credentials are unavailable.');
    }
    return cache.managerA;
}

function csDeviceToken() {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '.playwright-staff-cache.json'), 'utf8'));
    if (!cache?.csDeviceToken) throw new Error('Playwright cs_desk device token is unavailable.');
    return cache.csDeviceToken;
}

async function loginManagerPortal(page, pathName, buttonLabel) {
    const manager = managerCredentials();
    await page.goto(pathName);
    await expect(page.locator('#auth-screen')).toBeVisible({ timeout: 15000 });
    const manual = page.getByLabel('Enter your name');
    if (!await manual.isVisible()) {
        await page.getByRole('button', { name: 'Enter name manually' }).click();
    }
    await page.getByLabel('Enter your name').fill(manager.name);
    await page.getByLabel('Personal PIN').fill(manager.pin);
    await page.getByRole('button', { name: buttonLabel }).click();
    await expect(page.locator('#auth-screen')).toBeHidden({ timeout: 15000 });
}

test.describe('Full app — portal surfaces', () => {
    test('receiving portal loads and accepts login', async ({ page }) => {
        await loginPortal(page, '/rec', /ENTER SYSTEM/i);
        await expect(page.getByText('INBOUND FREIGHT')).toBeVisible();
        await expect(page.locator('#pending-list')).toBeVisible();
        await expect(page.locator('#adhoc-vendor')).toBeVisible();
    });

    test('receiving ad-hoc arrival UI flow', async ({ page }) => {
        page.on('dialog', (d) => d.accept());
        await loginPortal(page, '/rec', /ENTER SYSTEM/i);
        const vendor = `UI VENDOR ${Date.now()}`;
        await page.locator('#adhoc-vendor').fill(vendor);
        await page.locator('#adhoc-create-task').uncheck();
        await page.getByRole('button', { name: /LOG TIME IN/i }).click();
        await expect(page.locator('#dock-list')).toContainText(vendor, { timeout: 15000 });
    });

    test('reports portal renders dashboard sections', async ({ page }) => {
        await loginManagerPortal(page, '/reports', /UNLOCK REPORTS/i);
        await expect(page.getByText('ACTION INBOX — DO THIS NEXT')).toBeVisible({ timeout: 15000 });
        await expect(page.getByRole('navigation', { name: 'Report modes' })).toBeVisible();
    });

    test('markdown portal main form visible after login', async ({ page }) => {
        await loginPortal(page, '/markdown');
        await expect(page.locator('#item-name')).toBeVisible();
    });

    test('financial log portal loads for manager', async ({ page }) => {
        page.on('dialog', (d) => d.accept());
        await loginManagerPortal(page, '/financial', /ENTER FINANCIAL LOG/i);
        const claimBtn = page.getByRole('button', { name: /Enable shadow access/i });
        if (await claimBtn.isVisible().catch(() => false)) {
            await claimBtn.click();
        }
        await expect(page.getByText(/Financial Log — Edmonton Wholesale Market/i)).toBeVisible({ timeout: 15000 });
    });

    test('CS portal shows legacy form when betacs disabled', async ({ page, request }) => {
        const manager = managerCredentials();
        const auth = await request.post('/api/mobile-auth', {
            data: { name: manager.name, pin: manager.pin },
        });
        expect(auth.ok()).toBeTruthy();
        const { token } = await auth.json();
        for (const id_val of ['Cs_Full_Enabled', 'Betacs_Enabled', 'Cs_Hub_Enabled']) {
            await request.post('/api/action', {
                headers: { 'x-session-token': token },
                data: {
                    table: 'settings',
                    action: 'update',
                    id_col: 'setting_name',
                    id_val,
                    data: { setting_value: '0' },
                    userContext: { name: manager.name, pin: manager.pin, token },
                },
            });
        }
        await page.goto(`/cs#deviceToken=${encodeURIComponent(csDeviceToken())}`);
        await expect(page.getByTestId('cs-dispatch-form')).toBeVisible({ timeout: 10000 });
    });

    test('settings editor portal loads for manager', async ({ page }) => {
        await loginManagerPortal(page, '/settings', /UNLOCK SETTINGS/i);
        await expect(page.locator('#app')).toBeVisible({ timeout: 15000 });
        await expect(page.locator('#panel-rhythm')).toBeVisible();
        await expect(page.locator('#rhythm-table-body')).toBeVisible();
        await page.getByRole('button', { name: /Staff/i }).click();
        await expect(page.locator('#panel-staff')).toBeVisible();
        await expect(page.locator('#staff-list')).toBeVisible();
    });

    test('manager hub exposes all major panels', async ({ page }) => {
        await loginManagerMobile(page);
        await page.locator('summary', { hasText: 'MANAGEMENT HUB' }).click();

        await expect(page.getByRole('link', { name: /SETTINGS EDITOR/i })).toBeVisible();

        const panels = [
            'DAILY DIRECTION',
            "TODAY'S BRIEFING",
            'EXPIRY / MARKDOWN',
            'BLE PRESENCE',
            'HOME BASE AUDITS',
            'SYSTEM ADMIN',
        ];
        for (const label of panels) {
            await expect(page.locator('summary', { hasText: label })).toBeVisible();
        }
    });
});
