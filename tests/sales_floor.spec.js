import { test, expect } from '@playwright/test';

/**
 * Run with the Command Center already listening on port 3001, e.g.
 *   npx electron .
 * from resources/app, then:
 *   npm run test:smoke
 */
test.describe('Sales floor — HTTP surface', () => {
  test('portal HTML', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('TGP');
  });

  test('anonymous sync returns staff array', async ({ request }) => {
    let res;
    for (let i = 0; i < 5; i++) {
      res = await request.get('/api/sync');
      if (res.status() !== 429) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.staff)).toBe(true);
    expect(body.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('health endpoint requires session', async ({ request }) => {
    const res = await request.get('/api/health');
    expect(res.status()).toBe(403);
  });
});
