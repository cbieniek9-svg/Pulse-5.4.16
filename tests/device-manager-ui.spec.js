import { test, expect } from '@playwright/test';
import { loginPortal } from './helpers/playwright-auth.js';

const TOKEN = 'tgpdt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('device manager locks one-time credentials and builds HTTPS purpose URLs', async ({ page, context }) => {
    const syncState = {
        staff: [{ name: 'Playwright Manager A', role: 'Manager' }],
        devices: [{
            id: 701,
            label: 'Service desk',
            status: 'Authorized',
            device_purpose: 'cs_desk',
            has_device_token: true,
            ip_address: null,
        }],
        network: {
            public_https_base_url: 'https://store.example:3443',
        },
    };
    let lifecycleRequests = 0;
    let releaseRotate;

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: 'http://127.0.0.1:3101',
    });
    await page.route('**/api/sync', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(syncState) });
    });
    await page.route('**/api/health', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ network: syncState.network }),
        });
    });
    await page.route('**/api/devices/**', async (route) => {
        lifecycleRequests += 1;
        const url = new URL(route.request().url());
        const body = route.request().postDataJSON();
        if (url.pathname.endsWith('/rotate-token')) {
            await new Promise((resolve) => { releaseRotate = resolve; });
        }
        const purpose = body.purpose || syncState.devices.find((item) => item.id === body.id)?.device_purpose || 'tv';
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                device_token: TOKEN,
                device: {
                    id: body.id || 900 + lifecycleRequests,
                    label: body.label || 'Station',
                    status: 'Authorized',
                    device_purpose: purpose,
                    has_device_token: true,
                },
            }),
        });
    });

    await loginPortal(page, '/settings?tab=devices', /UNLOCK SETTINGS/i);
    await expect(page.locator('#panel-devices')).toBeVisible();
    const rowPurpose = page.locator('#device-purpose-701');
    await expect(rowPurpose).toHaveValue('cs_desk');

    await page.getByRole('button', { name: 'ROTATE TOKEN' }).click();
    await page.getByRole('button', { name: 'CONFIRM' }).click();
    await expect.poll(() => page.locator('#settings-device-list button').evaluateAll(
        (buttons) => buttons.every((button) => button.disabled),
    )).toBe(true);
    await expect.poll(() => page.locator('#settings-device-list select').evaluateAll(
        (selects) => selects.every((select) => select.disabled),
    )).toBe(true);
    await expect(page.getByRole('button', { name: /CREATE & ISSUE TOKEN/i })).toBeDisabled();
    expect(lifecycleRequests).toBe(1);
    releaseRotate();

    const dialog = page.getByRole('dialog', { name: /one-time device credential/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('textbox')).toHaveValue(
        `https://store.example:3443/cs#deviceToken=${TOKEN}`,
    );
    await expect.poll(() => page.locator('#settings-device-list button').evaluateAll(
        (buttons) => buttons.every((button) => button.disabled),
    )).toBe(true);
    await expect(dialog.getByRole('button', { name: /close/i })).toBeDisabled();
    await dialog.getByRole('button', { name: /copy credential/i }).click();
    await expect(dialog).toContainText(/copied/i);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/cs#deviceToken=');
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: /close/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'ROTATE TOKEN' })).toBeEnabled();

    syncState.devices[0] = {
        ...syncState.devices[0],
        device_purpose: 'markdown',
    };
    await page.getByRole('button', { name: /REFRESH/i }).click();
    await expect(rowPurpose).toHaveValue('markdown');

    const paths = {
        tv: '/tv',
        cs_desk: '/cs',
        receiving: '/rec',
        markdown: '/markdown',
    };
    for (const [purpose, path] of Object.entries(paths)) {
        await page.locator('#add-device-label').fill(`${purpose} fixture`);
        await page.locator('#add-device-purpose').selectOption(purpose);
        await page.getByRole('button', { name: /CREATE & ISSUE TOKEN/i }).click();
        await expect(dialog.getByRole('textbox')).toHaveValue(
            `https://store.example:3443${path}#deviceToken=${TOKEN}`,
        );
        if (purpose === 'receiving' || purpose === 'markdown') {
            await expect(dialog).toContainText(/action credential only/i);
        }
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: /close/i }).click();
    }

    syncState.network = {};
    await page.getByRole('button', { name: /REFRESH/i }).click();
    await page.locator('#add-device-label').fill('No HTTPS fixture');
    await page.locator('#add-device-purpose').selectOption('tv');
    await page.getByRole('button', { name: /CREATE & ISSUE TOKEN/i }).click();
    await expect(dialog).toContainText('HTTPS address unavailable; complete HTTPS setup');
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await expect(dialog).not.toContainText(TOKEN);
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: /close/i }).click();
    expect(lifecycleRequests).toBe(6);
});
