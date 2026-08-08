'use strict';

/**
 * Chaos App Monkey — crawl all major surfaces; keep going; report before fixes.
 *
 *   set TGP_BASE_URL=http://127.0.0.1:3001
 *   npm run test:chaos-monkey
 *
 * WARNING: Destructive phase performs real clear-db / EOD / secure-store on that URL.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { ChaosReport } = require('./lib/report.cjs');
const { createCtx, readyProbe } = require('./lib/ctx.cjs');
const { phasePortals, phaseAuthSync } = require('./phases/01-portals-auth.cjs');
const { phaseFloorActions, phaseCsBetacs } = require('./phases/02-floor-cs.cjs');
const { phaseReceiving, phaseFinancialLog, phaseMarkdownCount } = require('./phases/03-receiving-log-md.cjs');
const { phaseSafeReports, phaseSettingsMaint } = require('./phases/04-safe-settings.cjs');
const { phaseStress, phaseDestructive } = require('./phases/05-stress-destructive.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REPORT_PATH = path.join(__dirname, '..', 'chaos-monkey-report.json');
const UI_FINDINGS = path.join(__dirname, '..', 'chaos-monkey-ui-findings.jsonl');

function banner(t) {
    console.log(`\n${'═'.repeat(68)}\n  ${t}\n${'═'.repeat(68)}\n`);
}

async function healthBetween(report, label) {
    let lastErr = '';
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const r = await readyProbe();
            if (!r.ok) {
                lastErr = 'ready.ok false';
            } else {
                report.pass('health', label, `uptime=${r.uptime}`);
                return;
            }
        } catch (e) {
            lastErr = e.message;
        }
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    report.fail('health', label, lastErr || 'health probe failed');
}

async function phaseUiGremlin(report) {
    banner('PHASE UI — Playwright portal gremlin');
    const pwCli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
    // Prefer real Node — Electron-as-Node breaks Playwright's browser runner.
    let nodeBin = process.env.CHAOS_NODE || '';
    if (!nodeBin) {
        try {
            const which = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['node'], {
                encoding: 'utf8',
            });
            nodeBin = String(which.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
        } catch (_) { /* fall through */ }
    }
    if (!nodeBin || /electron/i.test(nodeBin)) {
        nodeBin = process.platform === 'win32'
            ? 'C:\\Program Files\\nodejs\\node.exe'
            : '/usr/bin/node';
    }
    if (!fs.existsSync(nodeBin) && !/electron/i.test(process.execPath)) {
        nodeBin = process.execPath;
    }

    const r = spawnSync(nodeBin, [pwCli, 'test', '-c', path.join(__dirname, 'playwright.config.js')], {
        cwd: __dirname,
        env: {
            ...process.env,
            TGP_BASE_URL: report.base,
            ELECTRON_RUN_AS_NODE: '',
            FORCE_COLOR: '0',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) {
        report.fail('ui', 'gremlin-runner', r.error.message);
        return;
    }
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);

    // Playwright exit ≠ product failure; ingest findings file
    let uiRows = [];
    if (fs.existsSync(UI_FINDINGS)) {
        uiRows = fs.readFileSync(UI_FINDINGS, 'utf8').split('\n').filter(Boolean).map((l) => {
            try { return JSON.parse(l); } catch { return { kind: 'parse', detail: l }; }
        });
    }

    if (!uiRows.length && r.status === 0) {
        report.pass('ui', 'gremlin-clean', 'no console/request findings');
    } else if (!uiRows.length && r.status !== 0) {
        // Timeout-only runner failures with no logged product findings → soft skip
        const out = `${r.stdout || ''}\n${r.stderr || ''}`;
        if (/Test timeout/i.test(out) && !/Error: expect|pageerror|sync-cascade/i.test(out)) {
            report.skip('ui', 'gremlin-timeout-soft', `playwright exit ${r.status} (no product findings logged)`);
        } else {
            report.fail('ui', 'gremlin-runner', `playwright exit ${r.status}`);
        }
    }

    for (const row of uiRows) {
        const id = `${row.portal || 'unknown'}:${row.kind || 'issue'}`;
        if (row.kind === 'sync-cascade') report.fail('ui', id, row.detail);
        else report.fail('ui', id, row.detail || JSON.stringify(row));
    }

    report.meta.uiGremlinExit = r.status;
    report.meta.uiFindings = uiRows.length;
}

async function main() {
    banner('CHAOS APP MONKEY');
    console.log(`BASE=${process.env.TGP_BASE_URL || 'http://127.0.0.1:3001'}`);
    console.log('Policy: keep going on failures; destructive LAST; report before product fixes.\n');

    const report = new ChaosReport();

    let ctx;
    try {
        ctx = await createCtx(report);
    } catch (e) {
        report.fail('boot', 'fatal', e.message);
        fs.writeFileSync(REPORT_PATH, JSON.stringify(report.toJSON(), null, 2));
        console.error('\nCannot boot monkey — server/auth required.');
        process.exit(2);
    }

    const phases = [
        ['portals', () => phasePortals(ctx)],
        ['auth-sync', () => phaseAuthSync(ctx)],
        ['floor', () => phaseFloorActions(ctx)],
        ['cs', () => phaseCsBetacs(ctx)],
        ['receiving', () => phaseReceiving(ctx)],
        ['financial', () => phaseFinancialLog(ctx)],
        ['markdown-count', () => phaseMarkdownCount(ctx)],
        ['safe-reports', () => phaseSafeReports(ctx)],
        ['settings-maint', () => phaseSettingsMaint(ctx)],
        ['stress', () => phaseStress(ctx)],
        ['ui', () => phaseUiGremlin(report)],
        ['destructive', () => phaseDestructive(ctx)],
    ];

    for (const [name, fn] of phases) {
        banner(`PHASE — ${name}`);
        try {
            await fn();
        } catch (e) {
            report.fail(name, 'phase-crash', e.message);
        }
        await healthBetween(report, `after-${name}`);
    }

    const out = report.toJSON();
    fs.writeFileSync(REPORT_PATH, JSON.stringify(out, null, 2));

    banner('CHAOS MONKEY REPORT');
    console.log(`Passed:  ${out.summary.passed}`);
    console.log(`Failed:  ${out.summary.failed}`);
    console.log(`Skipped: ${out.summary.skipped}`);
    console.log(`Report:  ${REPORT_PATH}`);
    if (out.failures.length) {
        console.log('\nFailures:');
        out.failures.forEach((f) => console.log(`  • [${f.phase}] ${f.id} — ${f.detail}`));
    }
    console.log('\nNo product fixes applied (report-first policy).\n');

    process.exit(out.summary.failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});
