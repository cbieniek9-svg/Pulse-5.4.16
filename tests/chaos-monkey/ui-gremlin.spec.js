'use strict';

const { test } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const BASE = process.env.TGP_BASE_URL || 'http://127.0.0.1:3001';
const FINDINGS = path.join(__dirname, '..', 'chaos-monkey-ui-findings.jsonl');

function logFinding(row) {
    fs.appendFileSync(FINDINGS, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`);
}

/** Noise from SPA navigation / CDN — not product failures. */
function isNoiseFailure(url, errorText) {
    const u = String(url || '');
    const e = String(errorText || '');
    if (/ERR_ABORTED|NS_BINDING_ABORTED/i.test(e)) return true;
    if (/\/api\/stream/i.test(u)) return true;
    if (/fonts\.g(oogle|static)|fonts\.googleapis/i.test(u)) return true;
    return false;
}

function isNoiseConsole(text) {
    const t = String(text || '');
    if (/Failed to load resource.*403/i.test(t) && /\/tv/i.test(t)) return true;
    if (/net::ERR_ABORTED/i.test(t)) return true;
    return false;
}

function flushFindings(portal, consoleErrors, failedRequests) {
    const syncFails = failedRequests.filter((u) => /\/api\/sync/i.test(u) && /Failed to fetch|ERR_CONNECTION/i.test(u));
    if (consoleErrors.length) {
        logFinding({
            portal,
            kind: 'console-error',
            detail: consoleErrors.slice(0, 8).join(' | '),
            count: consoleErrors.length,
        });
    }
    if (failedRequests.length) {
        logFinding({
            portal,
            kind: 'request-failed',
            detail: failedRequests.slice(0, 8).join(' | '),
            count: failedRequests.length,
        });
    }
    if (syncFails.length) {
        logFinding({ portal, kind: 'sync-cascade', detail: syncFails.join(' | ') });
    }
}

const PORTALS = [
    { path: '/', name: 'floor' },
    { path: '/cs', name: 'cs' },
    { path: '/rec', name: 'receiving' },
    { path: '/markdown', name: 'markdown' },
    { path: '/reports', name: 'reports' },
    { path: '/settings', name: 'settings' },
    { path: '/safe', name: 'safe' },
    { path: '/financial', name: 'financial' },
    { path: '/count', name: 'count' },
    { path: '/tv', name: 'tv' },
];

test.describe('Chaos monkey UI crawl', () => {
    test.beforeAll(() => {
        try { fs.unlinkSync(FINDINGS); } catch (_) { /* ok */ }
    });

    for (const portal of PORTALS) {
        test(`crawl ${portal.name}`, async ({ page }) => {
            test.setTimeout(portal.name === 'floor' ? 20_000 : 35_000);
            const consoleErrors = [];
            const failedRequests = [];

            page.on('console', (msg) => {
                if (msg.type() === 'error') {
                    const text = msg.text();
                    if (!isNoiseConsole(text)) consoleErrors.push(text);
                }
            });
            page.on('pageerror', (err) => consoleErrors.push(String(err.message || err)));
            page.on('requestfailed', (req) => {
                const err = req.failure()?.errorText || '';
                if (isNoiseFailure(req.url(), err)) return;
                failedRequests.push(`${req.method()} ${req.url()} ${err}`);
            });

            const res = await page.goto(`${BASE}${portal.path}`, {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            }).catch((e) => {
                logFinding({ portal: portal.name, kind: 'navigation', detail: e.message });
                return null;
            });
            if (!res) return;

            if (portal.name === 'tv' && res.status() === 403) return;
            if (res.status() >= 400) {
                logFinding({ portal: portal.name, kind: 'navigation', detail: `HTTP ${res.status()}` });
            }

            // Floor: load + shallow probe only — deep click storms hang on login/dialogs.
            if (portal.name === 'floor') {
                await page.waitForTimeout(300).catch(() => {});
                const bodyText = await page.locator('body').innerText().catch(() => '');
                if (!bodyText || bodyText.length < 5) {
                    logFinding({ portal: 'floor', kind: 'empty-shell', detail: 'body empty after load' });
                }
                flushFindings(portal.name, consoleErrors, failedRequests);
                return;
            }

            try {
                const pin = page.locator('input[type="password"], input[name="pin"], #pin, [data-testid="pin"]');
                if (await pin.count() > 0) {
                    await pin.first().fill('1234', { timeout: 2000 }).catch(() => {});
                    const nameSel = page.locator('select, [data-testid="staff-select"]').first();
                    if (await nameSel.count() > 0) {
                        await nameSel.selectOption({ index: 1 }).catch(() => {});
                    }
                    const loginBtn = page.getByRole('button', { name: /log\s*in|sign\s*in|submit/i }).first();
                    if (await loginBtn.count() > 0) {
                        await Promise.race([
                            loginBtn.click({ timeout: 2500 }),
                            page.waitForTimeout(2500),
                        ]).catch(() => {});
                    }
                    await page.waitForTimeout(400).catch(() => {});
                }
            } catch (_) { /* navigate away */ }

            if (page.isClosed()) return;

            try {
                const buttons = page.locator('button:visible');
                const n = Math.min(await buttons.count(), 12);
                for (let i = 0; i < n; i++) {
                    if (page.isClosed()) break;
                    await buttons.nth(i).click({ timeout: 400, force: true }).catch(() => {});
                }
            } catch (_) { /* ignore */ }

            if (page.isClosed()) return;

            try {
                const inputs = page.locator('input[type="text"]:visible, textarea:visible');
                const inCount = Math.min(await inputs.count(), 5);
                const fuzz = ['chaos', 'A'.repeat(80), '🔥'];
                for (let i = 0; i < inCount; i++) {
                    await inputs.nth(i).fill(fuzz[i % fuzz.length], { timeout: 500 }).catch(() => {});
                }
            } catch (_) { /* ignore */ }

            await page.waitForTimeout(200).catch(() => {});
            flushFindings(portal.name, consoleErrors, failedRequests);
        });
    }
});
