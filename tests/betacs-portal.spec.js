import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csDeviceToken, loginManagerMobile } from './helpers/playwright-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function managerCredentials() {
    const cache = JSON.parse(fs.readFileSync(path.join(__dirname, '.playwright-staff-cache.json'), 'utf8'));
    if (!cache?.managerA?.name || !cache?.managerA?.pin) {
        throw new Error('Playwright manager credentials are unavailable.');
    }
    return cache.managerA;
}

async function loginCsPortal(page, manager = managerCredentials()) {
    await expect(page.getByText('CS UPLINK')).toBeVisible({ timeout: 15000 });
    await page.selectOption('#cs-user', manager.name);
    await page.fill('#cs-pin', manager.pin);
    await page.getByRole('button', { name: /ENTER HUB/i }).click();
}

async function setBetacsEnabled(request, enabled) {
    const manager = managerCredentials();
    const auth = await request.post('/api/mobile-auth', {
        data: { name: manager.name, pin: manager.pin },
    });
    expect(auth.ok()).toBeTruthy();
    const { token } = await auth.json();
    for (const id_val of ['Cs_Full_Enabled', 'Betacs_Enabled']) {
        const res = await request.post('/api/action', {
            headers: { 'x-session-token': token },
            data: {
                table: 'settings',
                action: 'update',
                id_col: 'setting_name',
                id_val,
                data: { setting_value: enabled ? '1' : '0' },
                userContext: { name: manager.name, pin: manager.pin, token },
            },
        });
        expect(res.ok()).toBeTruthy();
    }
    // Keep hub off so Playwright hits legacy / CS_Full surfaces directly
    await request.post('/api/action', {
        headers: { 'x-session-token': token },
        data: {
            table: 'settings',
            action: 'update',
            id_col: 'setting_name',
            id_val: 'Cs_Hub_Enabled',
            data: { setting_value: '0' },
            userContext: { name: manager.name, pin: manager.pin, token },
        },
    });
}

test.describe('Betacs CS portal — full UI', () => {
    test('legacy /cs form when Betacs off', async ({ page, request }) => {
        await loginManagerMobile(page);
        await setBetacsEnabled(request, false);

        await page.goto(`/cs#deviceToken=${encodeURIComponent(csDeviceToken())}`);
        await expect(page.getByText('CS DIRECT DISPATCH')).toBeVisible({ timeout: 10000 });
        await expect(page.getByTestId('cs-dispatch-form')).toBeVisible();
        await expect(page.getByTestId('cs-submit-btn')).toHaveText(/TRANSMIT TO FLOOR/i);

        await page.getByTestId('cs-customer-name').fill('UI LEGACY CUSTOMER');
        await page.getByTestId('cs-items-list').fill('2X UI TEST ITEM');
        await page.getByTestId('cs-order-location').selectOption('2');
        await page.getByTestId('cs-submit-btn').click();
        await expect(page.getByTestId('cs-status-message')).toContainText(/TV|LOGGED|sent/i, { timeout: 10000 });
    });

    test('betacs log form — every field and tab', async ({ page, request }) => {
        await loginManagerMobile(page);
        await setBetacsEnabled(request, true);

        await page.goto(`/cs#deviceToken=${encodeURIComponent(csDeviceToken())}`);
        await loginCsPortal(page);
        await expect(page.getByText('CS_FULL')).toBeVisible({ timeout: 10000 });
        await expect(page.getByRole('button', { name: 'LOG ORDER' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'ORDER BOARD' })).toBeVisible();

        // Submit empty → browser validation / required fields
        await page.locator('#b-submit').click();
        const customer = page.locator('#b-customer');
        await expect(customer).toBeFocused();

        await customer.fill('UI BETACS CUSTOMER');
        await page.locator('#b-phone').fill('403-555-1234');
        await page.locator('#b-needed').fill('2026-12-15');
        await page.locator('#b-taken').selectOption({ label: 'CS DESK' });
        await page.locator('#b-route').selectOption({ label: 'Pop' });
        await page.locator('#b-item').fill('3X UI PLAYWRIGHT ITEM');
        await page.locator('#b-loc').selectOption('22');
        await page.locator('#b-submit').click();
        await expect(page.locator('#log-status')).toContainText(/NEW/i, { timeout: 10000 });
    });

    test('betacs board — all stage buttons', async ({ page, request }) => {
        await loginManagerMobile(page);
        await setBetacsEnabled(request, true);

        const orderId = `ORD-UI-E2E-${Date.now()}`;
        const ins = await request.post('/api/action', {
            headers: { 'x-device-token': csDeviceToken() },
            data: {
                table: 'special_orders',
                action: 'insert',
                data: {
                    order_id: orderId,
                    customer: 'BOARD TEST',
                    contact: '403-555-4321',
                    needed_by: '2026-12-20',
                    taken_by: 'CS DESK',
                    route: 'G&L',
                    item: '1X BOARD ITEM',
                    location: '1',
                    status: 'New',
                    source: 'betacs',
                    closed_by: '',
                },
            },
        });
        expect(ins.ok()).toBeTruthy();

        await page.goto(`/cs#deviceToken=${encodeURIComponent(csDeviceToken())}`);
        await loginCsPortal(page);
        await page.getByRole('button', { name: 'ORDER BOARD' }).click();
        const card = page.locator('.order-card').filter({ hasText: 'BOARD TEST' });
        await expect(card).toBeVisible({ timeout: 10000 });

        await card.getByRole('button', { name: /MARK ORDERED/i }).click();
        await expect(card.getByRole('button', { name: /MARK READY/i })).toBeVisible({ timeout: 10000 });

        const manager = managerCredentials();
        const auth = await request.post('/api/mobile-auth', {
            data: { name: manager.name, pin: manager.pin },
        });
        expect(auth.ok()).toBeTruthy();
        const { token: managerToken } = await auth.json();
        const sync1 = await request.get('/api/sync', {
            headers: { 'x-session-token': managerToken },
        });
        const body1 = await sync1.json();
        const tvIds = (body1.orders_tv || []).map((o) => o.order_id);
        expect(tvIds).toContain(orderId);

        await card.getByRole('button', { name: /MARK READY/i }).click();
        await expect(card.getByRole('button', { name: /COMPLETE/i })).toBeVisible({ timeout: 10000 });

        const sync2 = await request.get('/api/sync', {
            headers: { 'x-session-token': managerToken },
        });
        const body2 = await sync2.json();
        expect((body2.orders_tv || []).map((o) => o.order_id)).not.toContain(orderId);

        await card.getByRole('button', { name: /COMPLETE/i }).click();
        await expect(page.locator('.order-card').filter({ hasText: 'BOARD TEST' })).toHaveCount(0, { timeout: 10000 });
    });

    test('/betacs redirects to /cs', async ({ page }) => {
        await page.goto('/betacs');
        await expect(page).toHaveURL(/\/cs$/);
    });
});
