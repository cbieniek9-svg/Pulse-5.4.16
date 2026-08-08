import { test, expect } from '@playwright/test';
import { managerCredentials, readPlaywrightStaffCache } from './helpers/playwright-auth.js';

async function managerToken(request) {
  const manager = managerCredentials();
  const auth = await request.post('/api/mobile-auth', { data: manager });
  expect(auth.ok()).toBeTruthy();
  const { token } = await auth.json();
  expect(token).toBeTruthy();
  return { ...manager, token };
}

test.describe('Security Audit', () => {

  test('H1: Privileged actions require proper auth', async ({ request }) => {
    const res = await request.post('/api/action', {
      data: {
        table: 'staff',
        action: 'update',
        id_col: 'id',
        id_val: 1,
        data: { active: 0 },
        userContext: { name: 'CHRIS' },
      },
    });
    expect(res.status()).toBe(403);
  });

  test('L7: Health endpoint requires auth', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(403);
  });

  test('M6: CSV Injection protection', async ({ request }) => {
    const manager = await managerToken(request);
    const { token } = manager;

    const malicious = '=cmd|"/c calc"!A0';
    const taskId = `T-CSV-${Date.now()}`;
    const ins = await request.post('/api/action', {
      headers: { 'x-session-token': token },
      data: {
        table: 'tasks',
        action: 'insert',
        data: {
          task_id: taskId,
          task_detail: malicious,
          status: 'Open',
          priority: 'High',
          zone: 'A5',
          assigned_to: 'Unassigned',
          est_mins: 5,
        },
        userContext: { name: manager.name, pin: manager.pin, token },
      },
    });
    expect(ins.ok()).toBeTruthy();

    const exp = await request.post('/api/export-csv', {
      headers: { 'x-session-token': token },
    });
    expect(exp.ok()).toBeTruthy();
    const csv = await exp.text();
    expect(csv).toContain(taskId);
    expect(csv).toContain("'=cmd");

    await request.post('/api/action', {
      headers: { 'x-session-token': token },
      data: {
        table: 'tasks',
        action: 'update',
        id_col: 'task_id',
        id_val: taskId,
        data: { status: 'Closed' },
        userContext: { name: manager.name, pin: manager.pin, token },
      },
    });
  });

  test('P1: Public sync is a non-privileged bootstrap shell', async ({ request }) => {
    const credentials = readPlaywrightStaffCache({ requireManagers: true });
    const res = await request.get('/api/sync');
    expect(res.ok()).toBeTruthy();
    const data = await res.json();

    expect(data).not.toHaveProperty('trainingProfile');
    expect(data.features?.trainingMode).toBe(false);
    expect(data.tasks).toEqual([]);
    expect(data.orders).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('TRAINING MODE');
    expect(JSON.stringify(data)).not.toContain('1234');
    for (const staff of data.staff || []) {
      expect(staff).not.toHaveProperty('role');
      expect(staff).not.toHaveProperty('permissions');
      expect(staff).not.toHaveProperty('id');
    }
    const publicNames = (data.staff || []).map((staff) => staff.name);
    expect(publicNames).not.toContain(credentials.managerA.name);
    expect(publicNames).not.toContain(credentials.managerB.name);
    expect(credentials.storeManager?.name).toBeTruthy();
    expect(publicNames).not.toContain(credentials.storeManager.name);

    const settings = data.settings || {};
    [
      'TV_ACCESS_KEY',
      'Presence_Gateway_Key',
      'Presence_Gateway_Map',
      'Presence_Staff_Beacons',
      'Presence_Cart_Map',
      'Presence_Order_Gateways',
    ].forEach((key) => {
      expect(settings).not.toHaveProperty(key);
    });
  });

  test('P1b: Manager authenticates through explicit name entry', async ({ page }) => {
    const manager = managerCredentials();
    const credentials = readPlaywrightStaffCache({ requireManagers: true });
    await page.goto('/');
    await expect(page.locator('#auth-screen')).toBeVisible();

    const publicOptions = await page.getByLabel('Select your name').locator('option').allTextContents();
    expect(publicOptions).not.toContain(manager.name);
    expect(publicOptions).not.toContain(credentials.storeManager.name);

    await page.getByRole('button', { name: 'Enter name manually' }).click();
    const nameInput = page.getByLabel('Enter your name');
    await expect(nameInput).toBeFocused();
    await nameInput.fill(manager.name);
    await page.getByLabel('Personal PIN').fill('wrong-pin');

    const failedResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/mobile-auth')
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'UNLOCK UPLINK' }).click();
    expect((await failedResponse).status()).toBe(403);
    await expect(page.getByRole('alert')).toContainText(/invalid credentials/i);

    await page.getByLabel('Personal PIN').fill(manager.pin);
    const authResponse = page.waitForResponse((response) => (
      response.url().endsWith('/api/mobile-auth')
      && response.request().method() === 'POST'
    ));
    await page.getByRole('button', { name: 'UNLOCK UPLINK' }).click();

    expect((await authResponse).ok()).toBeTruthy();
    await expect(page.locator('#app-screen')).toBeVisible({ timeout: 15000 });
  });

  test('P2: Session tokens are not accepted in query strings', async ({ request }) => {
    const { token } = await managerToken(request);

    const headerHealth = await request.get('/api/health', {
      headers: { 'x-session-token': token },
    });
    expect(headerHealth.ok()).toBeTruthy();

    const queryHealth = await request.get(`/api/health?token=${encodeURIComponent(token)}`);
    expect(queryHealth.status()).toBe(403);
  });

});
