'use strict';

/**
 * Run the unit suite one file at a time under the Electron runtime.
 *
 * better-sqlite3 is rebuilt against Electron's ABI (see the `rebuild:electron` script),
 * so plain `node --test` cannot load it and every SQLite-backed test errors out.
 * Running each file in its own process also means a single hanging test reports which
 * file stalled instead of freezing the whole run.
 *
 * Usage:
 *   node scripts/run-unit-electron.cjs                 # every discovered unit file
 *   node scripts/run-unit-electron.cjs receiving auth  # only files matching a substring
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TIMEOUT_MS = Number(process.env.UNIT_TIMEOUT_MS || 120000);
const FAIL_ON_SKIP = process.env.UNIT_FAIL_ON_SKIP === '1';
const appDir = path.resolve(__dirname, '..');
const testsDir = path.join(appDir, 'tests');

/**
 * Integration files that talk to a Command Center on a real port. They belong to the
 * `test:api` run; inside the unit runner they would just burn their connect timeout.
 */
const NEEDS_LIVE_SERVER = new Set([
    'betacs-portal-api.test.cjs',
]);

function discoverTestFiles() {
    return fs.readdirSync(testsDir)
        .filter((name) => name.endsWith('.test.cjs'))
        .filter((name) => !NEEDS_LIVE_SERVER.has(name))
        .sort()
        .map((name) => path.posix.join('tests', name));
}

function resolveRuntime() {
    const bundled = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
    if (process.platform === 'win32' && fs.existsSync(bundled)) {
        return { exe: bundled, label: 'Electron' };
    }
    try {
        const electron = require(path.join(appDir, 'node_modules', 'electron'));
        if (electron && fs.existsSync(electron)) return { exe: electron, label: 'Electron' };
    } catch (_) { /* fall through */ }
    const mac = path.join(appDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
    const linux = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron');
    for (const candidate of [mac, linux]) {
        if (fs.existsSync(candidate)) return { exe: candidate, label: 'Electron' };
    }
    if (FAIL_ON_SKIP) {
        throw new Error('Electron runtime is required when UNIT_FAIL_ON_SKIP=1. Run npm install before the release gate.');
    }
    console.warn('! Electron not found — falling back to node; SQLite-backed tests may skip.\n');
    return { exe: process.execPath, label: 'node' };
}

function main() {
    const filters = process.argv.slice(2);
    const all = discoverTestFiles();
    const files = filters.length
        ? all.filter((f) => filters.some((needle) => f.includes(needle)))
        : all;

    if (!files.length) {
        console.error(`No unit test files matched ${JSON.stringify(filters)}`);
        process.exit(1);
    }

    let runtime;
    try {
        runtime = resolveRuntime();
    } catch (error) {
        console.error(error.message || error);
        process.exit(1);
    }
    const { exe, label } = runtime;
    const failed = [];
    const timedOut = [];
    let totalPass = 0;
    let totalSkip = 0;
    const startedAll = Date.now();

    console.log(`Running ${files.length} unit test files under ${label}\n`);

    for (const file of files) {
        const started = Date.now();
        const res = spawnSync(exe, ['--test', file], {
            cwd: appDir,
            timeout: TIMEOUT_MS,
            encoding: 'utf8',
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
        const ms = Date.now() - started;
        const out = `${res.stdout || ''}${res.stderr || ''}`;

        if (res.error && res.error.code === 'ETIMEDOUT') {
            timedOut.push(file);
            console.log(`HANG  ${file} (>${TIMEOUT_MS}ms)`);
            continue;
        }
        if (res.status !== 0) {
            failed.push({ file, out });
            console.log(`FAIL  ${file} (${ms}ms)`);
            continue;
        }
        // The spec reporter prefixes counts with a glyph ("i pass 12"), TAP with "# pass 12".
        const pass = Number((out.match(/^\W*pass (\d+)/m) || [])[1] || 0);
        const skip = Number((out.match(/^\W*skipped (\d+)/m) || [])[1] || 0);
        totalPass += pass;
        totalSkip += skip;
        console.log(`ok    ${file} (${pass} pass${skip ? `, ${skip} skipped` : ''}, ${ms}ms)`);
    }

    console.log(`\n${'='.repeat(64)}`);
    console.log(
        `files ${files.length}  assertions ${totalPass} passed`
        + `${totalSkip ? `, ${totalSkip} skipped` : ''}`
        + `  failed ${failed.length}  hung ${timedOut.length}`
        + `  (${Math.round((Date.now() - startedAll) / 1000)}s)`,
    );

    for (const { file, out } of failed) {
        console.log(`\n${'-'.repeat(64)}\nFAILED ${file}\n${'-'.repeat(64)}`);
        console.log(out.split(/\r?\n/).slice(-60).join('\n'));
    }
    for (const file of timedOut) console.log(`\nHUNG ${file}`);

    if (FAIL_ON_SKIP && totalSkip) {
        console.error(`\nFAIL  ${totalSkip} skipped assertion(s) are not allowed in the release gate.`);
    }
    process.exit(failed.length || timedOut.length || (FAIL_ON_SKIP && totalSkip) ? 1 : 0);
}

if (require.main === module) main();
