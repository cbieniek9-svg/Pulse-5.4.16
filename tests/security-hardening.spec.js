import { test, expect, request as playwrightRequest } from '@playwright/test';
import { createRequire } from 'node:module';
import { loginPortal, readPlaywrightStaffCache } from './helpers/playwright-auth.js';

const require = createRequire(import.meta.url);

function staffCache() {
    return readPlaywrightStaffCache({ requireManagers: true, requireSecurityPii: true });
}

function deviceTokenFromPairingUrl(pairingUrl) {
    const parsed = new URL(pairingUrl);
    expect(parsed.hash).toMatch(/deviceToken=/);
    expect(parsed.search).not.toMatch(/deviceToken=/i);
    const hashParams = new URLSearchParams(parsed.hash.startsWith('#') ? parsed.hash.slice(1) : '');
    const token = hashParams.get('deviceToken');
    expect(token).toBeTruthy();
    return token;
}

async function managerSession(request) {
    const manager = staffCache().managerA;
    const auth = await request.post('/api/mobile-auth', { data: { name: manager.name, pin: manager.pin } });
    expect(auth.ok()).toBeTruthy();
    const body = await auth.json();
    expect(body.token).toBeTruthy();
    return { manager, token: body.token };
}

async function createPurposeDevice(request, { token, label, purpose }) {
    const res = await request.post('/api/devices/create', {
        headers: { 'x-session-token': token },
        data: { label, purpose, token },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.device_token).toBeTruthy();
    expect(body.device?.id).toBeTruthy();
    return body;
}

async function submitCsInsert(request, { deviceToken, orderId, customer, contact, item }) {
    const headers = {};
    if (deviceToken) headers['x-device-token'] = deviceToken;
    return request.post('/api/action', {
        headers,
        data: {
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: orderId,
                customer,
                contact,
                item,
                location: '1',
                status: 'Open',
            },
        },
    });
}

test.describe('Pulse 5.4.11 security hardening — browser', () => {
    test.describe.configure({ timeout: 90_000 });

    test('public login selector excludes Manager, Store Manager, and TRAINING MODE', async ({ page }) => {
        const cache = staffCache();
        await page.goto('/');
        await expect(page.locator('#auth-screen')).toBeVisible();
        await expect(page.getByLabel('Select your name')).toBeVisible({ timeout: 15000 });

        const options = await page.getByLabel('Select your name').locator('option').allTextContents();
        const normalized = options.map((value) => value.trim());
        expect(normalized).not.toContain(cache.managerA.name);
        expect(normalized).not.toContain(cache.managerB.name);
        expect(normalized).not.toContain(cache.storeManager.name);
        expect(normalized.some((value) => /manager/i.test(value))).toBe(false);
        expect(normalized).not.toContain('TRAINING MODE');
        expect(normalized).toContain(cache.name);
    });

    test('explicit manager-name mode authenticates with typed name and PIN', async ({ page }) => {
        const manager = staffCache().managerA;
        await page.goto('/');
        await expect(page.locator('#auth-screen')).toBeVisible();

        await page.getByRole('button', { name: 'Enter name manually' }).click();
        await page.getByLabel('Enter your name').fill(manager.name);
        await page.getByLabel('Personal PIN').fill(manager.pin);

        const authResponse = page.waitForResponse((response) => (
            response.url().endsWith('/api/mobile-auth')
            && response.request().method() === 'POST'
        ));
        await page.getByRole('button', { name: 'UNLOCK UPLINK' }).click();
        expect((await authResponse).ok()).toBeTruthy();
        await expect(page.locator('#app-screen')).toBeVisible({ timeout: 15000 });
    });

    test.describe.serial('CS desk pairing, write, and revocation', () => {
        /** @type {string} */
        let csDeviceToken = '';
        /** @type {string} */
        let csDeviceLabel = '';

        test('manager assigns cs_desk and CS page strips #deviceToken from the URL', async ({ page, context }) => {
            await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
                origin: 'http://127.0.0.1:3101',
            });

            csDeviceLabel = `PW CS Desk ${Date.now()}`;
            await loginPortal(page, '/settings?tab=devices', /UNLOCK SETTINGS/i);
            await expect(page.locator('#panel-devices')).toBeVisible({ timeout: 15000 });

            await page.locator('#add-device-label').fill(csDeviceLabel);
            await page.locator('#add-device-purpose').selectOption('cs_desk');
            await page.getByRole('button', { name: /CREATE & ISSUE TOKEN/i }).click();

            const dialog = page.getByRole('dialog', { name: /one-time device credential/i });
            await expect(dialog).toBeVisible({ timeout: 15000 });
            const pairingUrl = await dialog.getByRole('textbox', { name: /one-time pairing url/i }).inputValue();
            expect(pairingUrl).toMatch(/^https:\/\//);
            expect(pairingUrl).toContain('/cs#deviceToken=');
            csDeviceToken = deviceTokenFromPairingUrl(pairingUrl);

            await dialog.getByRole('checkbox').check();
            await dialog.getByRole('button', { name: /close/i }).click();
            await expect(dialog).toBeHidden();

            await page.goto(`/cs#deviceToken=${encodeURIComponent(csDeviceToken)}`);
            await expect.poll(() => page.evaluate(() => ({
                href: window.location.href,
                hash: window.location.hash,
                search: window.location.search,
                stored: window.localStorage.getItem('tgp.cs.deviceToken') || '',
            })), { timeout: 15000 }).toEqual(expect.objectContaining({
                hash: '',
                search: '',
                stored: csDeviceToken,
            }));
            const after = await page.evaluate(() => ({
                href: window.location.href,
                hash: window.location.hash,
                search: window.location.search,
            }));
            expect(after.href).not.toContain('deviceToken=');
            expect(after.hash).not.toContain('deviceToken=');
            expect(after.search).not.toContain('deviceToken=');
        });

        test('bare CS submission without session or device token receives 401', async ({ request }) => {
            const res = await submitCsInsert(request, {
                orderId: `PW-SEC-BARE-${Date.now()}`,
                customer: 'PWSEC-BARE-CUSTOMER',
                contact: '403-555-0000',
                item: '1X BARE ITEM',
            });
            expect(res.status()).toBe(401);
            const body = await res.json();
            expect(body.code).toBe('STATION_DEVICE_AUTH_REQUIRED');
        });

        test('paired CS submission succeeds', async ({ request }) => {
            expect(csDeviceToken).toBeTruthy();
            const orderId = `PW-SEC-PAIRED-${Date.now()}`;
            const res = await submitCsInsert(request, {
                deviceToken: csDeviceToken,
                orderId,
                customer: 'PWSEC-PAIRED-CUSTOMER',
                contact: '403-555-0001',
                item: '1X PAIRED ITEM',
            });
            expect(res.ok()).toBeTruthy();
            const body = await res.json();
            expect(body.success !== false).toBeTruthy();
        });

        test('revocation blocks the next CS write', async ({ page, request }) => {
            expect(csDeviceToken).toBeTruthy();
            expect(csDeviceLabel).toBeTruthy();

            await loginPortal(page, '/settings?tab=devices', /UNLOCK SETTINGS/i);
            await expect(page.locator('#panel-devices')).toBeVisible({ timeout: 15000 });

            const row = page.locator('#settings-device-list .mgr-card').filter({ hasText: csDeviceLabel });
            await expect(row).toBeVisible({ timeout: 15000 });
            await row.getByRole('button', { name: 'REVOKE TOKEN' }).click();
            await page.getByRole('button', { name: 'CONFIRM' }).click();
            await expect(row).toContainText(/Unpaired|token required/i, { timeout: 15000 });

            const res = await submitCsInsert(request, {
                deviceToken: csDeviceToken,
                orderId: `PW-SEC-REVOKED-${Date.now()}`,
                customer: 'PWSEC-REVOKED-CUSTOMER',
                contact: '403-555-0002',
                item: '1X REVOKED ITEM',
            });
            expect(res.status()).toBe(401);
            const body = await res.json();
            expect(['INVALID_DEVICE_TOKEN', 'STATION_DEVICE_AUTH_REQUIRED']).toContain(body.code);
        });
    });

    test('paired TV sync omits seeded customer name and phone', async ({ page, request }) => {
        const cache = staffCache();
        const pii = cache.securityPii;
        const { token } = await managerSession(request);
        const created = await createPurposeDevice(request, {
            token,
            label: `PW TV ${Date.now()}`,
            purpose: 'tv',
        });

        const syncResponsePromise = page.waitForResponse((response) => {
            if (!response.url().includes('/api/sync') || response.request().method() !== 'GET') return false;
            return !!response.request().headers()['x-device-token'];
        }, { timeout: 30000 });

        await page.goto(`/tv#deviceToken=${encodeURIComponent(created.device_token)}`);
        const syncResponse = await syncResponsePromise;
        expect(syncResponse.ok()).toBeTruthy();
        const payload = await syncResponse.json();
        expect(payload.syncAudience).toBe('tv');

        const raw = JSON.stringify(payload);
        expect(raw).not.toContain(pii.customer);
        expect(raw).not.toContain(pii.contact);
        expect(raw).not.toContain(pii.notes);
        for (const order of payload.orders_tv || []) {
            expect(order).not.toHaveProperty('customer');
            expect(order).not.toHaveProperty('contact');
            expect(order).not.toHaveProperty('notes');
            expect(order).not.toHaveProperty('logged_by');
            expect(order).not.toHaveProperty('taken_by');
        }
        expect(payload.orders == null || payload.orders.length === 0).toBeTruthy();

        await expect(page.locator('body')).not.toHaveAttribute('data-tv-pairing-required', /./);
        await expect(page.getByText(/PAIRING REQUIRED/i)).toHaveCount(0);
    });

    test('unpaired and IP-only TV clients only receive the public empty shell', async ({ request, page }) => {
        const cache = staffCache();
        const pii = cache.securityPii;

        const unpaired = await request.get('/api/sync');
        expect(unpaired.ok()).toBeTruthy();
        const unpairedBody = await unpaired.json();
        expect(unpairedBody.syncAudience).toBe('public');
        expect(unpairedBody.orders).toEqual([]);
        expect(unpairedBody.orders_tv).toEqual([]);
        expect(JSON.stringify(unpairedBody)).not.toContain(pii.customer);
        expect(JSON.stringify(unpairedBody)).not.toContain(pii.contact);

        // Seeded Authorized tv row without a token must not unlock operational sync.
        expect(cache.ipOnlyTvLabel).toBeTruthy();
        const ipOnly = await request.get('/api/sync', {
            headers: { 'x-forwarded-for': cache.ipOnlyTvAddress || '192.168.99.99' },
        });
        expect(ipOnly.ok()).toBeTruthy();
        const ipOnlyBody = await ipOnly.json();
        expect(ipOnlyBody.syncAudience).toBe('public');
        expect(ipOnlyBody.orders).toEqual([]);
        expect(ipOnlyBody.orders_tv).toEqual([]);
        expect(ipOnlyBody.deviceSessionActive).not.toBe(true);

        await page.goto('/tv');
        await expect(page.getByRole('heading', { name: /PAIRING REQUIRED/i })).toBeVisible({ timeout: 15000 });
        await expect(page.locator('#tv-col-center')).toContainText(/No operational data is available until this TV is paired/i);
    });

    test('loopback HTTP auth works; HTTPS auth succeeds; non-loopback HTTP is 426 HTTPS_REQUIRED', async ({ request }) => {
        const manager = staffCache().managerA;

        const loopback = await request.post('/api/mobile-auth', {
            data: { name: manager.name, pin: manager.pin },
        });
        expect(loopback.ok()).toBeTruthy();
        expect((await loopback.json()).token).toBeTruthy();

        const ready = await request.get('/api/ready');
        expect(ready.ok()).toBeTruthy();
        const readyBody = await ready.json();
        expect(readyBody.https?.active).toBe(true);
        expect(readyBody.https?.port).toBeTruthy();

        const httpsBase = `https://127.0.0.1:${readyBody.https.port}`;
        const httpsCtx = await playwrightRequest.newContext({
            baseURL: httpsBase,
            ignoreHTTPSErrors: true,
        });
        try {
            const httpsAuth = await httpsCtx.post('/api/mobile-auth', {
                data: { name: manager.name, pin: manager.pin },
            });
            expect(httpsAuth.ok()).toBeTruthy();
            expect((await httpsAuth.json()).token).toBeTruthy();
        } finally {
            await httpsCtx.dispose();
        }

        // HTTP is bound to loopback only, so a true non-loopback peer cannot reach the
        // Playwright webServer. Assert the shared middleware gate (unit-covered) with a
        // forged non-loopback remote, matching production LAN HTTP denial.
        const { requireHttpsForNonLoopback } = require('../src/lib/app-boot.cjs');
        const forged = {
            statusCode: 0,
            body: null,
            status(code) { this.statusCode = code; return this; },
            json(payload) { this.body = payload; return this; },
        };
        let nextCalled = false;
        requireHttpsForNonLoopback(
            {
                secure: true,
                socket: { encrypted: false, remoteAddress: '192.168.0.50' },
                headers: { 'x-forwarded-proto': 'https' },
                body: { name: manager.name, pin: manager.pin },
            },
            forged,
            () => { nextCalled = true; },
        );
        expect(nextCalled).toBe(false);
        expect(forged.statusCode).toBe(426);
        expect(forged.body.code).toBe('HTTPS_REQUIRED');
        expect(String(forged.body.error || '')).toMatch(/HTTPS is required/i);
    });
});
