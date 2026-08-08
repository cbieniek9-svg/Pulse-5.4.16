import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Requires Command Center on 127.0.0.1:3001 (e.g. `npx electron .` from resources/app).
 * Credentials: `PLAYWRIGHT_STAFF_NAME` + `PLAYWRIGHT_STAFF_PIN`, or `tests/playwright.local.env` (KEY=value),
 * or `tests/.playwright-staff-cache.json` written by `playwright-global-setup.cjs` when it can open tgp_ops.db.
 */
function loadLocalEnvFile() {
  const candidates = [
    path.join(__dirname, 'playwright.local.env'),
    path.join(__dirname, '..', 'playwright.local.env'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!process.env[key]) process.env[key] = val;
    }
    break;
  }
}

function readStaffCache() {
  const cachePath = path.join(__dirname, '.playwright-staff-cache.json');
  try {
    const j = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (j?.managerA?.name && j?.managerA?.pin) {
      return { name: j.managerA.name, pin: j.managerA.pin, managerA: j.managerA };
    }
    if (j?.name && j?.pin) return { name: j.name, pin: j.pin };
  } catch (_) { /* missing or invalid */ }
  return null;
}

loadLocalEnvFile();

async function tryStaffToken(request) {
  let name = process.env.PLAYWRIGHT_STAFF_NAME;
  let pin = process.env.PLAYWRIGHT_STAFF_PIN;
  let usedCache = false;
  if (!name || !pin) {
    const cached = readStaffCache();
    if (cached?.managerA?.name && cached?.managerA?.pin) {
      name = cached.managerA.name;
      pin = cached.managerA.pin;
      usedCache = true;
    } else if (cached?.name && cached?.pin) {
      name = cached.name;
      pin = cached.pin;
      usedCache = true;
    }
  }
  if (!name || !pin) {
    console.warn('[reports tests] no fixture manager credentials — run playwright-seed');
    return null;
  }
  const res = await request.post('/api/mobile-auth', { data: { name, pin } });
  if (!res.ok()) {
    if (usedCache) {
      const detail = await res.text().catch(() => '');
      console.warn('[reports tests] mobile-auth failed', res.status(), detail.slice(0, 200));
    }
    return null;
  }
  const body = await res.json();
  return body.token || null;
}

test.describe('Reports dashboard', () => {
  test('GET /api/reports returns 403 without session', async ({ request }) => {
    const res = await request.get('/api/reports');
    expect(res.status()).toBe(403);
  });

  test('GET /api/reports returns 403 with date query and no session', async ({ request }) => {
    const res = await request.get('/api/reports?date=2024-06-15');
    expect(res.status()).toBe(403);
  });

  test('GET /api/reports JSON shape when authenticated', async ({ request }, testInfo) => {
    const token = await tryStaffToken(request);
    if (!token) {
      const cached = readStaffCache();
      testInfo.skip(true, cached
        ? 'Staff cache exists but /api/mobile-auth failed. Start Command Center from this repo (npx electron . in resources/app) so it uses the same tgp_ops.db as globalSetup, or set PLAYWRIGHT_STAFF_NAME / PLAYWRIGHT_STAFF_PIN.'
        : 'No staff credentials: run globalSetup (npm test / playwright), add tests/playwright.local.env, or export PLAYWRIGHT_STAFF_NAME and PLAYWRIGHT_STAFF_PIN.');
    }

    const res = await request.get('/api/reports', { headers: { 'x-session-token': token } });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(d.meta).toBeTruthy();
    expect(d.meta.reportDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(['live', 'backup']).toContain(d.meta.reportSource);
    expect(d.meta.liveStoreDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.shift).toBeTruthy();
    expect(typeof d.shift.tasks_completed).toBe('number');
    expect(Array.isArray(d.task_closed_by_zone)).toBe(true);
    expect(Array.isArray(d.task_closed_by_priority)).toBe(true);
    expect(Array.isArray(d.tasks_open_by_zone)).toBe(true);
    expect(Array.isArray(d.completed_tasks)).toBe(true);
    expect(Array.isArray(d.customer_orders)).toBe(true);
    expect(Array.isArray(d.deliveries)).toBe(true);
    expect(Array.isArray(d.staff_shifts)).toBe(true);
    expect(Array.isArray(d.markdown_records)).toBe(true);
    expect(d.order_metrics).toBeTruthy();
    expect(typeof d.order_metrics.total_pieces).toBe('number');
    expect(d.oos_daily_comparison).toBeTruthy();
  });

  test('GET /api/reports ?date= overrides reportDate on live DB', async ({ request }, testInfo) => {
    const token = await tryStaffToken(request);
    if (!token) {
      const cached = readStaffCache();
      testInfo.skip(true, cached
        ? 'Staff cache exists but /api/mobile-auth failed. Start Command Center from this repo or set PLAYWRIGHT_STAFF_*.'
        : 'No staff credentials: run globalSetup, tests/playwright.local.env, or PLAYWRIGHT_STAFF_*.');
    }

    const res = await request.get('/api/reports?date=2022-11-30', { headers: { 'x-session-token': token } });
    expect(res.ok()).toBeTruthy();
    const d = await res.json();
    expect(d.meta.reportDate).toBe('2022-11-30');
    expect(d.meta.reportSource).toBe('live');
  });

  test('React reports app includes mode panels and section modules', () => {
    const appPath = path.join(__dirname, '..', 'client', 'src', 'reports', 'ReportsApp.jsx');
    const todayPath = path.join(__dirname, '..', 'client', 'src', 'reports', 'sections', 'TodayPanel.jsx');
    const handoffPath = path.join(__dirname, '..', 'client', 'src', 'reports', 'sections', 'HandoffPanel.jsx');
    const tabsPath = path.join(__dirname, '..', 'client', 'src', 'reports', 'components', 'ReportModeTabs.jsx');
    const app = fs.readFileSync(appPath, 'utf8');
    const today = fs.readFileSync(todayPath, 'utf8');
    const handoff = fs.readFileSync(handoffPath, 'utf8');
    const tabs = fs.readFileSync(tabsPath, 'utf8');
    expect(app).toContain('report-modes-wrap');
    expect(tabs).toContain('report-modes');
    expect(tabs).toContain('report-mode-hint');
    expect(today).toContain('report-mode-panel');
    expect(today).toContain("data-mode=\"today\"");
    expect(handoff).toContain("data-mode=\"handoff\"");
    expect(fs.existsSync(path.join(__dirname, '..', 'client', 'src', 'reports', 'sections', 'DeliveriesSection.jsx'))).toBeTruthy();
  });

  test('staff schedule import requires manager session', async ({ request }) => {
    const res = await request.post('/api/staff-shifts/import', {
      data: { filename: 'schedule.csv', contentBase64: Buffer.from('Name,Date\nA,2026-01-01\n').toString('base64') },
    });
    expect([403, 429]).toContain(res.status());
  });
});
