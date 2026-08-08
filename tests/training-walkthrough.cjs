'use strict';

/**
 * Pulse 5.4.11 — TRAINING MODE fail-closed walkthrough.
 * Asserts the retired PoC training identity cannot authenticate or appear in
 * public sync. Requires Command Center on TGP_BASE_URL (default loopback HTTP).
 */
const BASE = process.env.TGP_BASE_URL || 'http://127.0.0.1:3001';
const TRAINING = { name: 'TRAINING MODE', pin: '1234' };

const results = [];

function ok(step, detail) {
    results.push({ step, ok: true, detail });
    console.log(`  OK  ${step}${detail ? ` — ${detail}` : ''}`);
}

function bad(step, err) {
    const msg = err?.message || String(err);
    results.push({ step, ok: false, detail: msg });
    console.error(` FAIL ${step} — ${msg}`);
}

async function waitForServer(maxMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(`${BASE}/api/sync`);
            if (r.ok) return;
        } catch (_) { /* retry */ }
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Server not reachable at ${BASE} after ${maxMs}ms`);
}

async function run() {
    console.log('\n=== TGP TRAINING MODE FAIL-CLOSED WALKTHROUGH (5.4.11) ===\n');
    console.log(`Target: ${BASE}\n`);

    try {
        await waitForServer();
        ok('Server reachable');
    } catch (e) {
        bad('Server reachable', e);
        return summarize();
    }

    let sync;
    try {
        const r = await fetch(`${BASE}/api/sync`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        sync = await r.json();
        if (Object.prototype.hasOwnProperty.call(sync, 'trainingProfile')) {
            throw new Error('public sync must not expose trainingProfile');
        }
        if (sync.features?.trainingMode === true) {
            throw new Error('features.trainingMode must not be true on public sync');
        }
        ok('Public sync omits trainingProfile / trainingMode');
    } catch (e) {
        bad('Public sync omits trainingProfile / trainingMode', e);
    }

    try {
        const names = (sync?.staff || []).map((s) => String(s.name || '').toUpperCase().trim());
        if (names.includes('TRAINING MODE')) {
            throw new Error('TRAINING MODE still listed in public staff');
        }
        ok('Public staff list excludes TRAINING MODE');
    } catch (e) {
        bad('Public staff list excludes TRAINING MODE', e);
    }

    try {
        const r = await fetch(`${BASE}/api/mobile-auth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(TRAINING),
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok || body.token) {
            throw new Error(`expected denial, got HTTP ${r.status} with token=${Boolean(body.token)}`);
        }
        if (r.status !== 403) {
            throw new Error(`expected HTTP 403, got ${r.status}`);
        }
        ok('TRAINING MODE / 1234 mobile-auth denied', `code=${body.code || 'n/a'}`);
    } catch (e) {
        bad('TRAINING MODE / 1234 mobile-auth denied', e);
    }

    try {
        const r = await fetch(`${BASE}/public/tv/tv-dashboard.html`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const html = await r.text();
        if (!html.includes('tv-map-svg')) throw new Error('TV map shell missing');
        ok('TV dashboard HTML shell still loads without training auth');
    } catch (e) {
        bad('TV dashboard HTML shell still loads without training auth', e);
    }

    return summarize();
}

function summarize() {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    console.log('\n--- SUMMARY ---');
    console.log(`${passed}/${results.length} steps passed`);
    if (failed.length) {
        console.log('\nFailed steps:');
        failed.forEach((f) => console.log(`  • ${f.step}: ${f.detail}`));
    }
    console.log('');
    process.exit(failed.length ? 1 : 0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
