import { test, expect } from '@playwright/test';

const TRAINING = { name: 'TRAINING MODE', pin: '1234' };

test.describe('Training mode — fail-closed (5.4.11)', () => {
    test('public login selector excludes TRAINING MODE', async ({ page }) => {
        await page.goto('/');
        await expect(page.locator('#auth-screen')).toBeVisible();
        const options = await page.getByLabel('Select your name').locator('option').allTextContents();
        const normalized = options.map((v) => v.trim().toUpperCase());
        expect(normalized).not.toContain('TRAINING MODE');
    });

    test('TRAINING MODE / 1234 cannot authenticate on mobile', async ({ page, request }) => {
        const auth = await request.post('/api/mobile-auth', { data: TRAINING });
        expect(auth.status()).toBe(403);
        const body = await auth.json();
        expect(body.token).toBeFalsy();

        await page.goto('/');
        await expect(page.locator('#auth-screen')).toBeVisible();
        await page.getByRole('button', { name: 'Enter name manually' }).click();
        await page.getByLabel('Enter your name').fill(TRAINING.name);
        await page.getByLabel('Personal PIN').fill(TRAINING.pin);
        await page.getByRole('button', { name: /UNLOCK UPLINK/i }).click();
        // Fail-closed: TRAINING MODE staff is revoked (active=0 / app_access=0), not a soft "invalid credentials".
        await expect(page.getByRole('alert')).toContainText(/account access is revoked/i, { timeout: 15000 });
        await expect(page.locator('#app-screen')).toBeHidden();
    });

    test('TV dashboard map shell still renders without training login', async ({ page }) => {
        await page.goto('/public/tv/tv-dashboard.html');
        // Dashboard chrome must load without TRAINING MODE; operational zone labels require paired TV (5.4.11).
        await expect(page.locator('#tv-map-svg')).toBeVisible({ timeout: 20000 });
        await expect(page.locator('body')).not.toContainText(/TRAINING MODE/i);
    });
});
