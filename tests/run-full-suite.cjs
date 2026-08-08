'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { waitForServer, BASE } = require('./helpers/api-client.cjs');

const ROOT = path.join(__dirname, '..');

/** Propagate test-mode flags to child processes (server must also use TGP_TEST_MODE=1). */
const CHILD_ENV = {
    ...process.env,
    TGP_TEST_MODE: '1',
    TGP_TRAINING_TEST: '1',
    TGP_SIM_DAYS: process.env.TGP_SIM_DAYS || '365',
};

function run(label, cmd, args) {
    console.log(`\n${'='.repeat(60)}\n${label}\n${'='.repeat(60)}\n`);
    const isElectronSeed = String(cmd).includes('electron.exe') && String(args[0] || '').includes('playwright-seed');
    const r = spawnSync(cmd, args, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: !isElectronSeed,
        env: isElectronSeed ? { ...CHILD_ENV, ELECTRON_RUN_AS_NODE: '1' } : CHILD_ENV,
    });
    if (r.status !== 0) {
        console.error(`\nFAILED: ${label} (exit ${r.status})\n`);
        process.exit(r.status || 1);
    }
}

const UNIT_TESTS = [
    'tests/order-history-regression.test.cjs',
    'tests/markdown-parse.test.cjs',
    'tests/markdown-excel-import.test.cjs',
    'tests/fifo-audit-excel-import.test.cjs',
    'tests/kill-date-pull.test.cjs',
    'tests/receiving-flow.test.cjs',
    'tests/clear-markdown-archive.test.cjs',
    'tests/training-staff.test.cjs',
    'tests/store-time.test.cjs',
    'tests/shift-metrics.test.cjs',
    'tests/store-scheduler.test.cjs',
    'tests/zone-map-colors.test.cjs',
    'tests/betacs.test.cjs',
    'tests/cs-full-hub.test.cjs',
    'tests/cs-customers.test.cjs',
    'tests/cs-order-print.test.cjs',
    'tests/betacs-portal-api.test.cjs',
];

const PLAYWRIGHT_SPECS = [
    'tests/sales_floor.spec.js',
    'tests/security_audit.spec.js',
    'tests/reports_dashboard.spec.js',
    'tests/training-mode.spec.js',
    'tests/betacs-portal.spec.js',
    'tests/full-app-portals.spec.js',
];

async function main() {
    console.log('\nTGP FULL TEST SUITE (incl. year simulation + destructive)');
    console.log(`Server: ${BASE}`);
    console.log(`Sim days: ${CHILD_ENV.TGP_SIM_DAYS}`);
    console.log('Tip: restart Command Center with TGP_TEST_MODE=1 for higher API limits.\n');

    try {
        await waitForServer();
        console.log('Server is up.\n');
    } catch (e) {
        console.error(e.message);
        console.error('\nStart Command Center first: set TGP_TEST_MODE=1&& npx electron . (from resources/app)\n');
        process.exit(1);
    }

    const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    const seedScript = path.join(ROOT, 'tests', 'playwright-seed.cjs');
    if (require('fs').existsSync(electronExe)) {
        run('Seed: Playwright E2E staff', electronExe, [seedScript]);
    }

    for (const t of UNIT_TESTS) {
        run(`Unit: ${path.basename(t)}`, 'node', [t]);
    }

    run('API: full-app-walkthrough', 'node', ['tests/full-app-walkthrough.cjs']);
    run('API: year simulation (multi-user)', 'node', ['tests/year-simulation.cjs']);
    run('API: destructive maintenance', 'node', ['tests/destructive-maintenance.cjs']);

    run('Playwright: install browsers', 'npx', ['playwright', 'install', 'chromium']);
    run('Playwright: full UI suite', 'npx', ['playwright', 'test', ...PLAYWRIGHT_SPECS]);

    console.log('\n' + '='.repeat(60));
    console.log('ALL FULL SUITE TESTS PASSED');
    console.log('='.repeat(60) + '\n');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
