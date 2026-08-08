'use strict';
/**
 * Preflight before copying resources/app to the store PC (run at home with Node).
 * Exit 0 = safe to copy. Non-zero = fix before deploy.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const appRoot = path.join(__dirname, '..');
let failed = 0;

function ok(msg) {
    console.log(`  OK  ${msg}`);
}

function bad(msg) {
    console.error(`  FAIL  ${msg}`);
    failed += 1;
}

function mustExist(rel, label) {
    const p = path.join(appRoot, rel);
    if (!fs.existsSync(p)) bad(`${label || rel} missing: ${rel}`);
    else ok(`${label || rel}`);
    return p;
}

console.log('\n=== TGP verify-store-deploy ===\n');

mustExist('main.cjs', 'Electron main');
mustExist('server.cjs', 'Headless Node server');
mustExist('src/lib/app-boot.cjs', 'Shared app boot');
mustExist('service/TGP-CommandCenter.xml', 'WinSW service config');
mustExist('service/TGP-CommandCenter.xml.template', 'WinSW service XML template');
mustExist('service/tgp-service-install.cmd', 'Service install script');
mustExist('service/README.txt', 'Service README');

{
    const xmlLive = fs.readFileSync(path.join(appRoot, 'service/TGP-CommandCenter.xml'), 'utf8');
    const xmlTpl = fs.readFileSync(path.join(appRoot, 'service/TGP-CommandCenter.xml.template'), 'utf8');
    if (!xmlTpl.includes('__TGP_APP_ROOT__') || !xmlTpl.includes('__TGP_ELECTRON_EXE__')) {
        bad('TGP-CommandCenter.xml.template missing install placeholders');
    } else {
        ok('WinSW XML template has install placeholders');
    }
    const appRootNorm = path.resolve(appRoot).replace(/\\/g, '/').toLowerCase();
    const liveNorm = xmlLive.replace(/\\/g, '/').toLowerCase();
    if (xmlLive.includes('__TGP_')) {
        bad('TGP-CommandCenter.xml still has placeholders — run Install-TGP-Service.ps1 before starting the service');
    } else if (liveNorm.includes(appRootNorm)) {
        ok('WinSW XML absolute paths match this app tree');
    } else {
        // This preflight is normally run on the build PC, while the checked-in live
        // XML was generated on a different Windows installation. The mandatory
        // store installer rewrites it from the validated template for the target.
        console.log('  NOTE  WinSW XML targets another app root; service/Install-TGP-Service.ps1 must regenerate it on the store PC');
    }
}
mustExist('src/db.cjs', 'Database layer');
mustExist('src/app-version.cjs', 'App version');
// Floor + portals are React (dist/ui). Legacy mobile/settings HTML/JS are orphaned
// (301 redirects only) — do not treat them as the live UI. TV is the remaining legacy surface.
mustExist('public/tv/tv-dashboard.html', 'TV dashboard (legacy)');
mustExist('public/css/mobile.css', 'Shared floor CSS (still loaded by React SPA)');
mustExist('store-templates/default/rhythm-tasks.json', 'Store template');
mustExist('store-templates/default/Template-Rec-Document.xlsx', 'Store transfer Rec template');
mustExist('store-templates/default/Template-Manifest.xlsx', 'Store transfer Manifest template');
mustExist('store-templates/default/Template-Edmonton-Wholesale-Market-Receiving-Report.xlsx', 'Edmonton receiving report template');
mustExist('store-templates/default/Sample-Edmonton-Wholesale-Market-Receiving-Report-2026Aug22.xlsx', 'Edmonton receiving report sample Aug 2026');
mustExist('scripts/PHASE0_DEPLOY_CHECKLIST.txt', 'Phase 0 checklist');
mustExist('scripts/STORE_INSTANCE_SETUP.txt', 'Store #2 setup guide');
mustExist('scripts/verify-backup.cjs', 'Backup restore drill');
mustExist('scripts/verify-release.cjs', 'Release verification suite');
mustExist('scripts/check-syntax.cjs', 'Syntax checker');
mustExist('scripts/fresh-install-smoke.cjs', 'Fresh install smoke test');
mustExist('scripts/upgrade-smoke.cjs', 'Existing store upgrade smoke test');
mustExist('release-manifest.json', 'Release manifest');
mustExist('client/vite.config.js', 'React UI Vite config');
mustExist('client/src/components/floor/FloorApp.jsx', 'React floor app');
mustExist('client/src/App.jsx', 'React router (floor + portals)');

const uiIndex = path.join(appRoot, 'dist/ui/index.html');
if (!fs.existsSync(uiIndex)) {
    console.log('\n--- React UI build ---\n');
    const uiBuild = spawnSync(process.execPath, [
        path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
        'build',
        '--config',
        'client/vite.config.js',
    ], {
        cwd: appRoot,
        stdio: 'inherit',
        shell: false,
    });
    if (uiBuild.status !== 0) bad('build:ui failed');
    else ok('dist/ui built');
}
mustExist('dist/ui/index.html', 'React UI build output');

const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const { APP_VERSION } = require(path.join(appRoot, 'src/app-version.cjs'));
if (pkg.version !== APP_VERSION) {
    bad(`version mismatch: package.json ${pkg.version} vs app-version ${APP_VERSION}`);
} else {
    ok(`version ${APP_VERSION}`);
}

[
    'STORE_DEPLOY.txt',
    'scripts/PHASE0_DEPLOY_CHECKLIST.txt',
    'scripts/STORE_INSTANCE_SETUP.txt',
].forEach((rel) => {
    const docPath = path.join(appRoot, rel);
    const body = fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
    if (!body.includes(APP_VERSION)) bad(`${rel} does not mention current version ${APP_VERSION}`);
    else ok(`${rel} version reference`);
});

try {
    const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'release-manifest.json'), 'utf8'));
    if (manifest.appVersion !== APP_VERSION) bad(`release-manifest version ${manifest.appVersion} does not match ${APP_VERSION}`);
    else ok('release-manifest version');
    if (!Array.isArray(manifest.verificationScripts) || !manifest.verificationScripts.includes('verify:release')) {
        bad('release-manifest missing verify:release');
    } else {
        ok('release-manifest verification scripts');
    }
} catch (e) {
    bad(`release-manifest invalid: ${e.message}`);
}

const nativeMod = path.join(appRoot, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
if (!fs.existsSync(nativeMod)) {
    bad('better_sqlite3.node not built — run npm run rebuild:electron (required — ABI 145 for service + .exe)');
} else {
    ok('better_sqlite3.node present');
}

// Windows service + desktop share Electron ABI 145 (service runs ELECTRON_RUN_AS_NODE).
// System Node (137) may fail to load — that is OK for store deploys.
try {
    require('better-sqlite3');
    ok(`better-sqlite3 also loads under this Node (ABI ${process.versions.modules})`);
} catch (e) {
    console.log(`  NOTE  better-sqlite3 does not load under system Node (${e.message}) — expected when built for Electron 145.`);
}

const electronExe = path.join(appRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronCli = path.join(appRoot, 'node_modules', 'electron', 'cli.js');
const sqliteProbe = "try { require('better-sqlite3'); console.log('OK', process.versions.modules); process.exit(0); } catch (e) { console.error(e.message || e); process.exit(1); }";
if (fs.existsSync(electronExe) || fs.existsSync(electronCli)) {
    const el = fs.existsSync(electronExe)
        ? spawnSync(electronExe, ['-e', sqliteProbe], {
            cwd: appRoot,
            encoding: 'utf8',
            windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        })
        : spawnSync(process.execPath, [electronCli, '-e', sqliteProbe], {
            cwd: appRoot,
            encoding: 'utf8',
            windowsHide: true,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        });
    if (el.status === 0) {
        ok(`better-sqlite3 loads under Electron-as-Node (ABI 145) — Windows service + .exe OK`);
        const out = String(el.stdout || '').trim();
        if (out && !out.includes('145')) {
            console.log(`  NOTE  Electron probe output: ${out}`);
        }
    } else {
        bad(`better-sqlite3 require failed under Electron ABI 145: ${(el.stderr || el.stdout || '').toString().trim() || 'exit ' + el.status}`);
        console.log('        Fix: npm run rebuild:electron');
    }
} else {
    bad('electron package missing — run npm install (service needs node_modules/electron/dist/electron.exe)');
}

const electronPkg = path.join(appRoot, 'node_modules', 'electron', 'package.json');
if (fs.existsSync(electronPkg)) {
    const ev = JSON.parse(fs.readFileSync(electronPkg, 'utf8')).version;
    const want = pkg.devDependencies && pkg.devDependencies.electron;
    if (!want) {
        bad('package.json does not pin an Electron version');
    }
    if (ev !== want) bad(`Electron ${ev} (expected ${want})`);
    else ok(`Electron ${ev}`);
} else {
    bad('electron package missing');
}

console.log('\n--- unit tests ---\n');
const unit = spawnSync(process.execPath, [
    '--test',
    path.join(appRoot, 'tests', 'order-finish.test.cjs'),
    path.join(appRoot, 'tests', 'shift-metrics.test.cjs'),
    path.join(appRoot, 'tests', 'store-timezone.test.cjs'),
    path.join(appRoot, 'tests', 'rhythm-task-expand.test.cjs'),
    path.join(appRoot, 'tests', 'zone-map-general.test.cjs'),
    path.join(appRoot, 'tests', 'daily-rhythm.test.cjs'),
    path.join(appRoot, 'tests', 'task-estimates.test.cjs'),
    path.join(appRoot, 'tests', 'order-history-regression.test.cjs'),
    path.join(appRoot, 'tests', 'order-weekly-scorecard.test.cjs'),
    path.join(appRoot, 'tests', 'zone-owners.test.cjs'),
    path.join(appRoot, 'tests', 'order-day-briefing.test.cjs'),
    path.join(appRoot, 'tests', 'manager-exceptions.test.cjs'),
    path.join(appRoot, 'tests', 'store-template.test.cjs'),
    path.join(appRoot, 'tests', 'migrations.test.cjs'),
    path.join(appRoot, 'tests', 'kill-zone-map.test.cjs'),
    path.join(appRoot, 'tests', 'store-hours.test.cjs'),
    path.join(appRoot, 'tests', 'order-store-date.test.cjs'),
    path.join(appRoot, 'tests', 'comms-center.test.cjs'),
    path.join(appRoot, 'tests', 'reports-analytics.test.cjs'),
    path.join(appRoot, 'tests', 'presence-engine.test.cjs'),
    path.join(appRoot, 'tests', 'backup-health.test.cjs'),
    path.join(appRoot, 'tests', 'db-health.test.cjs'),
    path.join(appRoot, 'tests', 'verify-backup.test.cjs'),
    path.join(appRoot, 'tests', 'presence-ultimate.test.cjs'),
    path.join(appRoot, 'tests', 'manager-hub-meta.test.cjs'),
], {
    cwd: appRoot,
    stdio: 'inherit',
    env: { ...process.env, NODE_TEST: '1' },
});
if (unit.status !== 0) bad('core unit tests failed');
else ok('order-finish + shift-metrics + daily-rhythm + task-estimates + order-history tests');

console.log('\n--- TV bundle (legacy React — deprecated) ---\n');
const tvCheck = spawnSync(process.execPath, [path.join(appRoot, 'scripts', 'check-tv-index.cjs')], {
    cwd: appRoot,
    stdio: 'inherit',
});
if (tvCheck.status !== 0) bad('check:tv failed');
else ok('TV index check');

console.log('');
if (failed) {
    console.error(`=== VERIFY FAILED (${failed} issue(s)) ===\n`);
    process.exit(1);
}
console.log(`=== VERIFY OK — safe to copy v${APP_VERSION} ===\n`);
