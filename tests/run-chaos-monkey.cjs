'use strict';

/**
 * Chaos monkey against an isolated API (default :3101).
 * Does not use the live store DB — set TGP_BASE_URL / start throwaway instance first.
 *
 * Usage:
 *   set TGP_BASE_URL=http://127.0.0.1:3101&& node tests/run-chaos-monkey.cjs
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const BASE = process.env.TGP_BASE_URL || 'http://127.0.0.1:3101';
const CHAOS_DIR = path.join(__dirname, 'chaos');
const REPORT = path.join(CHAOS_DIR, 'chaos_report.txt');
const SUMMARY = path.join(__dirname, 'chaos-monkey-summary.json');

const SSE_ZOMBIES = Number(process.env.CHAOS_SSE_ZOMBIES || 80);
const SSE_SURGE = Number(process.env.CHAOS_SSE_SURGE || 200);
const DB_HAMMER = Number(process.env.CHAOS_DB_HAMMER || 300);
const LONG_HAUL_DAYS = Number(process.env.CHAOS_LONG_HAUL_DAYS || 14);

function banner(t) {
    console.log(`\n${'═'.repeat(64)}\n  ${t}\n${'═'.repeat(64)}\n`);
}

async function ready() {
    const r = await fetch(`${BASE}/api/ready`);
    if (!r.ok) throw new Error(`ready ${r.status}`);
    return r.json();
}

async function authToken() {
    const { readManagerCredentials } = require('./helpers/api-client.cjs');
    const manager = readManagerCredentials();
    const r = await fetch(`${BASE}/api/mobile-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: manager.name, pin: manager.pin }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.token) throw new Error(`auth failed: ${data.error || r.status}`);
    return data.token;
}

async function healthSnapshot(label) {
    try {
        const [readyBody, sync] = await Promise.all([
            fetch(`${BASE}/api/ready`).then((r) => r.json()),
            fetch(`${BASE}/api/sync`).then(async (r) => ({ status: r.status, ok: r.ok, bytes: Number(r.headers.get('content-length') || 0) || (await r.arrayBuffer()).byteLength })),
        ]);
        return { label, at: new Date().toISOString(), ready: readyBody, sync };
    } catch (e) {
        return { label, at: new Date().toISOString(), error: e.message };
    }
}

async function main() {
    banner('CHAOS MONKEY — isolated instance');
    console.log(`BASE=${BASE}`);
    console.log(`SSE zombies=${SSE_ZOMBIES} surge=${SSE_SURGE} dbHammer=${DB_HAMMER} longHaulDays=${LONG_HAUL_DAYS}`);

    process.chdir(CHAOS_DIR);

    // Load chaos modules from their own node_modules (axios/eventsource).
    const modulePaths = [path.join(CHAOS_DIR, 'node_modules'), ...module.paths];
    const Module = require('module');
    const orig = Module._nodeModulePaths;
    Module._nodeModulePaths = (from) => [...modulePaths, ...orig(from)];

    const stressSSE = require(path.join(CHAOS_DIR, 'stress-sse.js'));
    const hammerDB = require(path.join(CHAOS_DIR, 'db-hammer.js'));
    const timeWarp = require(path.join(CHAOS_DIR, 'time-warp.js'));
    const longHaul = require(path.join(CHAOS_DIR, 'long-haul.js'));

    fs.writeFileSync(REPORT, `--- CHAOS MONKEY: ${new Date().toISOString()} BASE=${BASE} ---\n\n`);

    const health = [];
    const failures = [];

    let before = await healthSnapshot('before');
    health.push(before);
    if (before.error) {
        console.error('API unreachable before chaos:', before.error);
        process.exit(1);
    }
    console.log('API ready before chaos:', before.ready?.ok, 'uptime', before.ready?.uptime);

    const token = await authToken();
    console.log('Auth OK (TRAINING MODE)');

    try {
        banner('Phase 1 — SSE thundering herd');
        await stressSSE(BASE, token, SSE_SURGE);
        // stress-sse hardcodes 100 zombies internally; surge uses count arg
        health.push(await healthSnapshot('after-sse'));
        if (health.at(-1).error) failures.push({ phase: 'sse', detail: health.at(-1).error });
    } catch (e) {
        failures.push({ phase: 'sse', detail: e.message });
        fs.appendFileSync(REPORT, `[FATAL] SSE phase: ${e.message}\n`);
    }

    try {
        banner('Phase 2 — DB hammer');
        await hammerDB(BASE, token, DB_HAMMER);
        health.push(await healthSnapshot('after-db-hammer'));
        if (health.at(-1).error) failures.push({ phase: 'db-hammer', detail: health.at(-1).error });
    } catch (e) {
        failures.push({ phase: 'db-hammer', detail: e.message });
        fs.appendFileSync(REPORT, `[FATAL] DB hammer: ${e.message}\n`);
    }

    try {
        banner(`Phase 3 — Long haul (${LONG_HAUL_DAYS} days)`);
        await longHaul(BASE, token, LONG_HAUL_DAYS);
        health.push(await healthSnapshot('after-long-haul'));
        if (health.at(-1).error) failures.push({ phase: 'long-haul', detail: health.at(-1).error });
    } catch (e) {
        failures.push({ phase: 'long-haul', detail: e.message });
        fs.appendFileSync(REPORT, `[FATAL] Long haul: ${e.message}\n`);
    }

    try {
        banner('Phase 4 — Time warp');
        await timeWarp(BASE);
        health.push(await healthSnapshot('after-time-warp'));
        if (health.at(-1).error) failures.push({ phase: 'time-warp', detail: health.at(-1).error });
    } catch (e) {
        failures.push({ phase: 'time-warp', detail: e.message });
        fs.appendFileSync(REPORT, `[FATAL] Time warp: ${e.message}\n`);
    }

    banner('Phase 5 — UI gremlin (Playwright)');
    const pw = spawnSync(
        process.platform === 'win32' ? 'npx.cmd' : 'npx',
        ['playwright', 'test', 'ui-gremlin.spec.js', '--config=playwright.config.js'],
        { cwd: CHAOS_DIR, stdio: 'inherit', env: { ...process.env, TGP_BASE_URL: BASE, BASE_URL: BASE } },
    );
    if (pw.status !== 0) {
        failures.push({ phase: 'ui-gremlin', detail: `exit ${pw.status}` });
        fs.appendFileSync(REPORT, `[UI Gremlin] exit ${pw.status} (chaos-expected failures OK if API still up)\n`);
    }

    const after = await healthSnapshot('final');
    health.push(after);

    const cascaded = Boolean(after.error) || after.ready?.ok !== true;
    if (cascaded) failures.push({ phase: 'cascade', detail: after.error || 'ready.ok !== true' });

    const summary = {
        base: BASE,
        startedAt: before.at,
        finishedAt: after.at,
        cascaded,
        failures,
        health,
        reportPath: REPORT,
        sseSurge: SSE_SURGE,
        dbHammer: DB_HAMMER,
        longHaulDays: LONG_HAUL_DAYS,
    };
    fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 2));

    banner('CHAOS MONKEY SUMMARY');
    console.log(`Cascaded (API dead): ${cascaded}`);
    console.log(`Failures: ${failures.length}`);
    failures.forEach((f) => console.log(`  • [${f.phase}] ${f.detail}`));
    console.log(`Report: ${REPORT}`);
    console.log(`Summary: ${SUMMARY}`);

    if (cascaded) process.exit(2);
    process.exit(failures.some((f) => f.phase !== 'ui-gremlin') ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
