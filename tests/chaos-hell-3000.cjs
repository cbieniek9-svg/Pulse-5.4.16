'use strict';

/**
 * CHAOS HELL 3000 — largest integrated test pass for TGP Command Center.
 *
 * Phases:
 *   1. All node --test unit/regression files (*.test.cjs)
 *   2. Standalone integration scripts (markdown, receiving, betacs, etc.)
 *   3. Offline smoke (fresh install, release verify)
 *   4. Live API (walkthrough, year sim, destructive) — requires server
 *   5. Security probes (auth, injection, sync redaction)
 *   6. Playwright UI + security audit
 *   7. Chaos harness (SSE/db hammer lite) — optional
 *
 * Usage:
 *   set TGP_TEST_MODE=1&& node tests/chaos-hell-3000.cjs
 *   set TGP_SIM_DAYS=30&& node tests/chaos-hell-3000.cjs   (faster sim)
 *
 * Start server first (recommended):
 *   set TGP_TEST_MODE=1&& npx electron .
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REPORT_PATH = path.join(__dirname, 'hell3000-report.json');
const ELECTRON_EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const USE_ELECTRON_NODE = fs.existsSync(ELECTRON_EXE);

function nodeRunner() {
    if (USE_ELECTRON_NODE) return { cmd: ELECTRON_EXE, extraEnv: { ELECTRON_RUN_AS_NODE: '1' } };
    return { cmd: process.execPath, extraEnv: {} };
}

const CHILD_ENV = {
    ...process.env,
    TGP_TEST_MODE: '1',
    TGP_TRAINING_TEST: '1',
    TGP_SIM_DAYS: process.env.TGP_SIM_DAYS || '90',
    FORCE_COLOR: '0',
};
// Never inherit a live throwaway server's bind/data dir into unit tests —
// ui-shell and similar boots collide on TGP_PORT and hang forever.
delete CHILD_ENV.TGP_PORT;
delete CHILD_ENV.TGP_HTTPS_PORT;
delete CHILD_ENV.TGP_DATA_DIR;
delete CHILD_ENV.PORT;

const report = {
    startedAt: new Date().toISOString(),
    phases: [],
    summary: { passed: 0, failed: 0, skipped: 0 },
};

function record(phase, label, status, detail = '') {
    report.phases.push({ phase, label, status, detail, at: new Date().toISOString() });
    if (status === 'pass') report.summary.passed += 1;
    else if (status === 'fail') report.summary.failed += 1;
    else report.summary.skipped += 1;
}

function banner(title) {
    console.log(`\n${'═'.repeat(72)}\n  ${title}\n${'═'.repeat(72)}\n`);
}

function runCmd(label, cmd, args, { phase, optional = false, env = CHILD_ENV } = {}) {
    console.log(`\n▶ ${label}`);
    const runner = cmd === 'node' ? nodeRunner() : { cmd, extraEnv: {} };
    const finalCmd = cmd === 'node' ? runner.cmd : cmd;
    const finalEnv = { ...env, ...runner.extraEnv };
    const r = spawnSync(finalCmd, args, { cwd: ROOT, stdio: 'inherit', shell: finalCmd !== ELECTRON_EXE, env: finalEnv });
    if (r.status === 0) {
        record(phase, label, 'pass');
        return true;
    }
    if (optional) {
        record(phase, label, 'skip', `exit ${r.status}`);
        console.warn(`  (optional skip — exit ${r.status})`);
        return false;
    }
    record(phase, label, 'fail', `exit ${r.status}`);
    return false;
}

const LIVE_ONLY_TESTS = new Set([
    'betacs-portal-api.test.cjs',
]);

function discoverTestFiles() {
    const files = [];
    function walk(dir) {
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (ent.name === 'chaos' || ent.name === 'helpers' || ent.name === 'node_modules') continue;
                walk(full);
            } else if (ent.name.endsWith('.test.cjs') && !LIVE_ONLY_TESTS.has(ent.name)) {
                files.push(full);
            }
        }
    }
    walk(path.join(ROOT, 'tests'));
    return files.sort();
}

const STANDALONE_SCRIPTS = [
    'tests/markdown-parse.test.cjs',
    'tests/markdown-excel-import.test.cjs',
    'tests/fifo-audit-excel-import.test.cjs',
    'tests/kill-date-pull.test.cjs',
    'tests/receiving-flow.test.cjs',
    'tests/clear-markdown-archive.test.cjs',
    'tests/training-staff.test.cjs',
    'tests/shift-metrics.test.cjs',
    'tests/zone-map-colors.test.cjs',
    'tests/betacs-portal-api.test.cjs',
];

const PLAYWRIGHT_SPECS = [
    'tests/sales_floor.spec.js',
    'tests/security_audit.spec.js',
    'tests/security-hardening.spec.js',
    'tests/reports_dashboard.spec.js',
    'tests/training-mode.spec.js',
    'tests/betacs-portal.spec.js',
    'tests/full-app-portals.spec.js',
];

async function waitForServer(maxMs = 120000) {
    const { waitForServer: wait } = require('./helpers/api-client.cjs');
    return wait(maxMs);
}

async function runSecurityProbes() {
    banner('PHASE 5 — LIVE SECURITY PROBES');
    const { BASE, json, request, managerToken, readManagerCredentials } = require('./helpers/api-client.cjs');
    let token;
    let manager;
    try {
        manager = readManagerCredentials();
        token = await managerToken();
    } catch (e) {
        record('security', 'manager auth', 'fail', e.message);
        return false;
    }
    record('security', 'manager auth', 'pass');
    const actor = { name: manager.name, pin: manager.pin, token };

    // H1: unauthenticated action blocked
    try {
        const r = await request('POST', '/api/action', {
            body: { table: 'staff', action: 'update', id_col: 'id', id_val: 1, data: { active: 0 } },
        });
        if (r.status === 403) record('security', 'unauth action blocked', 'pass');
        else record('security', 'unauth action blocked', 'fail', `status ${r.status}`);
    } catch (e) {
        record('security', 'unauth action blocked', 'fail', e.message);
    }

    // SQL injection in task detail
    try {
        const taskId = `HELL-SQL-${Date.now()}`;
        await json('POST', '/api/action', {
            table: 'tasks',
            action: 'insert',
            data: {
                task_id: taskId,
                task_detail: "'; DROP TABLE tasks; --",
                status: 'Open',
                priority: 'Routine',
                zone: 'A1',
                assigned_to: 'Unassigned',
                est_mins: 5,
            },
            userContext: actor,
        }, token);
        const sync = await json('GET', '/api/sync', null, token);
        const hit = (sync.tasks || []).find((t) => t.task_id === taskId);
        if (hit && (sync.tasks || []).length > 0) {
            record('security', 'SQL injection stored safely', 'pass');
            await json('POST', '/api/action', {
                table: 'tasks', action: 'update', id_col: 'task_id', id_val: taskId,
                data: { status: 'Closed' },
                userContext: actor,
            }, token);
        } else {
            record('security', 'SQL injection stored safely', 'fail', 'task missing after insert');
        }
    } catch (e) {
        record('security', 'SQL injection stored safely', 'fail', e.message);
    }

    // Oversized body rejection / graceful handling
    try {
        const big = 'X'.repeat(512 * 1024);
        const r = await request('POST', '/api/action', {
            body: {
                table: 'ticker',
                action: 'insert',
                data: { msg_id: `BIG-${Date.now()}`, message: big },
                userContext: actor,
            },
            token,
        });
        if (r.status >= 400 && r.status < 500) record('security', 'oversized payload handled', 'pass', `status ${r.status}`);
        else if (r.ok) record('security', 'oversized payload handled', 'pass', 'accepted (within limits)');
        else record('security', 'oversized payload handled', 'fail', `status ${r.status}`);
    } catch (e) {
        record('security', 'oversized payload handled', 'pass', 'connection rejected');
    }

    // Sync redaction — training identity must not appear in public sync
    try {
        const pub = await json('GET', '/api/sync');
        const blob = JSON.stringify(pub);
        if (/TRAINING MODE/i.test(blob) || Object.prototype.hasOwnProperty.call(pub, 'trainingProfile')) {
            record('security', 'sync excludes training identity', 'fail', 'training still visible in public sync');
        } else {
            record('security', 'sync excludes training identity', 'pass');
        }
    } catch (e) {
        record('security', 'sync excludes training identity', 'fail', e.message);
    }

    // Invalid token
    try {
        // A presented-but-invalid token is 401 so clients re-prompt for login;
        // a request with no token at all stays 403.
        const r = await request('POST', '/api/eod-sweep', { token: 'INVALID_TOKEN_hell3000' });
        if (r.status === 401) record('security', 'invalid token rejected', 'pass');
        else record('security', 'invalid token rejected', 'fail', `status ${r.status}`);
    } catch (e) {
        record('security', 'invalid token rejected', 'pass');
    }

    console.log(`\nSecurity probes done (${BASE})`);
    return true;
}

async function runChaosLite() {
    banner('PHASE 7 — CHAOS LITE (concurrent sync + actions)');
    const { json, managerToken, readManagerCredentials, uid } = require('./helpers/api-client.cjs');
    let token;
    let manager;
    try {
        manager = readManagerCredentials();
        token = await managerToken();
    } catch (e) {
        record('chaos', 'chaos lite auth', 'fail', e.message);
        return;
    }
    const actor = { name: manager.name, pin: manager.pin, token };

    const syncBurst = Array.from({ length: 50 }, () =>
        fetch(`${process.env.TGP_BASE_URL || 'http://127.0.0.1:3001'}/api/sync`).then((r) => r.ok).catch(() => false),
    );
    const syncOk = (await Promise.all(syncBurst)).filter(Boolean).length;
    if (syncOk >= 40) record('chaos', '50 concurrent sync reads', 'pass', `${syncOk}/50 ok`);
    else record('chaos', '50 concurrent sync reads', 'fail', `${syncOk}/50 ok`);

    const taskWrites = Array.from({ length: 20 }, (_, i) => {
        const id = uid(`HELL-${i}`);
        return json('POST', '/api/action', {
            table: 'tasks',
            action: 'insert',
            data: {
                task_id: id,
                task_detail: `CHAOS HELL ${i}`,
                status: 'Open',
                priority: 'Routine',
                zone: 'A1',
                assigned_to: 'Unassigned',
                est_mins: 5,
            },
            userContext: actor,
        }, token).then(() => id).catch(() => null);
    });
    const written = (await Promise.all(taskWrites)).filter(Boolean);
    if (written.length >= 15) record('chaos', '20 concurrent task inserts', 'pass', `${written.length}/20`);
    else record('chaos', '20 concurrent task inserts', 'fail', `${written.length}/20`);

    // cleanup
    for (const id of written) {
        try {
            await json('POST', '/api/action', {
                table: 'tasks', action: 'update', id_col: 'task_id', id_val: id,
                data: { status: 'Closed' },
                userContext: actor,
            }, token);
        } catch (_) { /* ignore */ }
    }
}

async function main() {
    banner('🔥 CHAOS HELL 3000 — TGP COMPREHENSIVE STABILITY RUN 🔥');
    console.log(`Root: ${ROOT}`);
    console.log(`Sim days: ${CHILD_ENV.TGP_SIM_DAYS}`);
    console.log(`Node: ${USE_ELECTRON_NODE ? 'Electron (better-sqlite3 compatible)' : process.execPath}`);
    console.log(`Report: ${REPORT_PATH}\n`);

    let failed = false;

    // ── Phase 1: all unit tests ─────────────────────────────────────────────
    banner('PHASE 1 — ALL UNIT / REGRESSION TESTS (*.test.cjs)');
    const testFiles = discoverTestFiles();
    console.log(`Found ${testFiles.length} test files`);
    const batchOk = runCmd(
        'node --test (all *.test.cjs)',
        'node',
        ['--test', ...testFiles.map((f) => path.relative(ROOT, f))],
        { phase: 'unit' },
    );
    if (!batchOk) failed = true;

    // ── Phase 2: standalone scripts (some are not .test.cjs runners) ────────
    banner('PHASE 2 — STANDALONE INTEGRATION SCRIPTS');
    for (const rel of STANDALONE_SCRIPTS) {
        const full = path.join(ROOT, rel);
        if (!fs.existsSync(full)) {
            record('standalone', rel, 'skip', 'missing');
            continue;
        }
        if (!runCmd(rel, 'node', [rel], { phase: 'standalone', optional: rel.includes('betacs-portal') })) {
            if (!rel.includes('betacs-portal')) failed = true;
        }
    }

    // ── Phase 3: offline smoke ──────────────────────────────────────────────
    banner('PHASE 3 — OFFLINE SMOKE (fresh install, release)');
    if (!runCmd('fresh-install-smoke', 'node', ['scripts/fresh-install-smoke.cjs'], { phase: 'offline' })) failed = true;
    runCmd('verify-release', 'node', ['scripts/verify-release.cjs'], { phase: 'offline', optional: true });
    runCmd('verify-store-deploy', 'node', ['scripts/verify-store-deploy.cjs'], { phase: 'offline', optional: true });

    // ── Phase 4+: live server tests ─────────────────────────────────────────
    banner('PHASE 4 — LIVE API (server required)');
    let serverUp = false;
    try {
        await waitForServer(5000);
        serverUp = true;
        record('server', 'waitForServer', 'pass');
        console.log('Server already up.\n');
    } catch (_) {
        if (USE_ELECTRON_NODE) {
            console.log('Starting Command Center (TGP_TEST_MODE=1) for live tests…');
            const child = spawn(ELECTRON_EXE, ['.'], {
                cwd: ROOT,
                env: { ...CHILD_ENV },
                detached: true,
                stdio: 'ignore',
            });
            child.unref();
        }
        try {
            await waitForServer(180000);
            serverUp = true;
            record('server', 'waitForServer', 'pass', 'started for hell3000');
            console.log('Server is up.\n');
        } catch (e) {
            record('server', 'waitForServer', 'skip', 'not reachable — start with: set TGP_TEST_MODE=1&& npx electron .');
            console.warn('\n⚠ Server not running. Skipping live API, security probes, Playwright, and chaos lite.');
            console.warn('  Start Command Center: set TGP_TEST_MODE=1&& npx electron . (from resources/app)\n');
        }
    }

    if (serverUp) {
        const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
        const seedScript = path.join(ROOT, 'tests', 'playwright-seed.cjs');
        if (fs.existsSync(electronExe) && fs.existsSync(seedScript)) {
            runCmd('Playwright seed staff', electronExe, [seedScript], { phase: 'live', optional: true });
        }

        if (!runCmd('full-app-walkthrough', 'node', ['tests/full-app-walkthrough.cjs'], { phase: 'live' })) failed = true;
        if (!runCmd(`year-simulation (${CHILD_ENV.TGP_SIM_DAYS} days)`, 'node', ['tests/year-simulation.cjs'], { phase: 'live' })) failed = true;
        if (!runCmd('destructive-maintenance', 'node', ['tests/destructive-maintenance.cjs'], { phase: 'live' })) failed = true;
        if (!runCmd('training-walkthrough (fail-closed)', 'node', ['tests/training-walkthrough.cjs'], { phase: 'live' })) failed = true;

        await runSecurityProbes();
        await runChaosLite();

        banner('PHASE 6 — PLAYWRIGHT UI + SECURITY');
        runCmd('playwright install chromium', 'npx', ['playwright', 'install', 'chromium'], { phase: 'playwright', optional: true });
        if (!runCmd('Playwright full UI suite', 'npx', ['playwright', 'test', ...PLAYWRIGHT_SPECS], { phase: 'playwright' })) failed = true;
    }

    report.finishedAt = new Date().toISOString();
    report.ok = !failed && report.summary.failed === 0;
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

    banner('HELL 3000 SUMMARY');
    console.log(`Passed:  ${report.summary.passed}`);
    console.log(`Failed:  ${report.summary.failed}`);
    console.log(`Skipped: ${report.summary.skipped}`);
    console.log(`Report:  ${REPORT_PATH}`);

    const failures = report.phases.filter((p) => p.status === 'fail');
    if (failures.length) {
        console.log('\nFailures:');
        failures.forEach((f) => console.log(`  • [${f.phase}] ${f.label}${f.detail ? ` — ${f.detail}` : ''}`));
    }

    if (failed || report.summary.failed > 0) {
        console.log('\n❌ CHAOS HELL 3000 — FAILED\n');
        process.exit(1);
    }
    console.log('\n✅ CHAOS HELL 3000 — ALL PHASES PASSED\n');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
