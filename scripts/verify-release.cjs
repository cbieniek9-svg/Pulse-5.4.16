#!/usr/bin/env node
'use strict';

/**
 * One-command release confidence check.
 *
 * This is intentionally boring: syntax checks, core unit tests, fresh-install
 * smoke, upgrade-on-copy smoke, backup drill, and store-deploy verification.
 *
 * SQLite-backed smokes run under Electron-as-Node because better-sqlite3 is
 * rebuilt for Electron ABI 145 (the Windows service + .exe runtime). Plain
 * system Node (ABI 137) cannot load that native module.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.resolve(__dirname, '..');

function parseArgs(argv = process.argv.slice(2)) {
    const out = {
        json: false,
        skipStore: false,
        skipBackup: false,
        quick: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') out.json = true;
        else if (a === '--skip-store') out.skipStore = true;
        else if (a === '--skip-backup') out.skipBackup = true;
        else if (a === '--quick') out.quick = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return out;
}

/** Prefer Electron so better-sqlite3 (ABI 145) loads; fall back to system Node. */
function resolveSqliteRuntime() {
    try {
        const electron = require(path.join(appRoot, 'node_modules', 'electron'));
        if (electron && fs.existsSync(electron)) {
            return { exe: electron, env: { ELECTRON_RUN_AS_NODE: '1' } };
        }
    } catch (_) { /* fall through */ }
    return { exe: process.execPath, env: {} };
}

function runStep(name, command, args, opts = {}) {
    const started = Date.now();
    const res = spawnSync(command, args, {
        cwd: appRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, TGP_TEST_MODE: '1', ...(opts.env || {}) },
    });
    const stdout = (res.stdout || '').trim();
    const stderr = (res.stderr || '').trim();
    const output = `${stdout}\n${stderr}`;
    const reportedSkipped = [...output.matchAll(/^\W*skipped\s+(\d+)/gmi)]
        .reduce((total, match) => total + Number(match[1] || 0), 0);
    const skipDirectives = (output.match(/#\s*SKIP\b/gi) || []).length;
    const skipped = Math.max(reportedSkipped, skipDirectives);
    return {
        name,
        ok: res.status === 0 && (!opts.failOnSkip || skipped === 0),
        status: res.status,
        ms: Date.now() - started,
        command: [command, ...args].join(' '),
        stdout,
        stderr,
        skipped,
    };
}

function buildSteps(opts = {}) {
    const node = process.execPath;
    const sqlite = resolveSqliteRuntime();
    const steps = [
        {
            name: 'syntax-check',
            command: node,
            args: ['scripts/check-syntax.cjs'],
        },
        {
            name: 'production-runtime-probe',
            command: sqlite.exe,
            args: ['scripts/verify-production-runtime.cjs'],
            env: sqlite.env,
        },
        {
            name: 'core-unit-tests',
            // Several "core" tests open the inventory SQLite database during
            // module initialization. Run the entire gate under the same Electron
            // ABI as the packaged desktop and Windows service; using system Node
            // here makes a correctly rebuilt store package fail preflight.
            command: sqlite.exe,
            args: ['--test',
                'tests/daily-direction.test.cjs',
                'tests/eod-daily-direction-retention.test.cjs',
                'tests/backup-health.test.cjs',
                'tests/db-health.test.cjs',
                'tests/verify-backup.test.cjs',
                'tests/migration-safety.test.cjs',
                'tests/release-manifest.test.cjs',
                'tests/trusted-device-tokens.test.cjs',
                'tests/sync-payload-audience.test.cjs',
                'tests/production-readiness.test.cjs',
                'tests/manager-maintenance-ui.test.cjs',
                'tests/release-confidence.test.cjs',
                'tests/tokenless-store-mode.test.cjs',
                'tests/history-trends.test.cjs',
                'tests/history-export.test.cjs',
                'tests/eod-retention-snapshot.test.cjs',
                'tests/safety-blurbs.test.cjs',
            ],
            env: sqlite.env,
        },
        {
            name: 'fresh-install-smoke',
            command: sqlite.exe,
            args: ['scripts/fresh-install-smoke.cjs'],
            env: sqlite.env,
        },
        {
            name: 'upgrade-smoke-copy',
            command: sqlite.exe,
            args: ['scripts/upgrade-smoke.cjs', '--allow-missing-source'],
            env: sqlite.env,
        },
    ];

    if (!opts.skipBackup) {
        steps.push({
            name: 'backup-drill-current-data',
            command: sqlite.exe,
            args: ['scripts/verify-backup.cjs', '--allow-missing'],
            env: sqlite.env,
        });
    }

    if (!opts.skipStore && !opts.quick) {
        steps.push({
            name: 'store-deploy-preflight',
            command: node,
            args: ['scripts/verify-store-deploy.cjs'],
        });
    }

    return steps;
}

function runReleaseVerification(opts = {}) {
    const steps = [];
    for (const step of buildSteps(opts)) {
        const result = runStep(step.name, step.command, step.args, {
            env: step.env || {},
            failOnSkip: step.name === 'core-unit-tests',
        });
        steps.push(result);
        if (!result.ok && !opts.keepGoing) break;
    }

    return {
        ok: steps.every((s) => s.ok),
        checked_at: new Date().toISOString(),
        steps,
    };
}

function printHuman(result) {
    console.log('\n=== TGP verify-release ===\n');
    result.steps.forEach((s) => {
        console.log(`${s.ok ? 'OK  ' : 'FAIL'} ${s.name} (${s.ms}ms)`);
        if (!s.ok) {
            const detail = s.stderr || s.stdout || `exit ${s.status}`;
            console.error(detail.split('\n').slice(-12).join('\n'));
        }
    });
    console.log(result.ok ? '\nRelease confidence passed.\n' : '\nRelease confidence failed.\n');
}

function printHelp() {
    console.log(`
TGP release confidence check

Usage:
  node scripts/verify-release.cjs [--json] [--quick] [--skip-store] [--skip-backup]

Options:
  --json         Print machine-readable JSON.
  --quick        Skip heavier deploy preflight.
  --skip-store   Skip scripts/verify-store-deploy.cjs.
  --skip-backup  Skip current-data backup drill.
`);
}

if (require.main === module) {
    let args;
    try {
        args = parseArgs();
        if (args.help) {
            printHelp();
            process.exit(0);
        }
    } catch (e) {
        console.error(`FAIL ${e.message || e}`);
        process.exit(1);
    }

    const result = runReleaseVerification(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exit(result.ok ? 0 : 1);
}

module.exports = {
    parseArgs,
    buildSteps,
    runReleaseVerification,
    resolveSqliteRuntime,
    runStep,
};
