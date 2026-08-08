'use strict';

/**
 * Authenticated Lighthouse pass — seeded fixture manager session in the same tab, then
 * Lighthouse user-flow navigations (sessionStorage survives same-tab navigations).
 *
 * Usage: node tests/lighthouse-reports/run-authed.cjs
 * Env: TGP_BASE_URL (default http://127.0.0.1:3001)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { BASE, managerToken, readManagerCredentials } = require('../helpers/api-client.cjs');

const OUT = path.join(__dirname, 'authed');
const APP_ROOT = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const PORTALS = [
    { id: 'floor', path: '/' },
    { id: 'cs', path: '/cs' },
    { id: 'receiving', path: '/rec' },
    { id: 'markdown', path: '/markdown' },
    { id: 'reports', path: '/reports' },
    { id: 'settings', path: '/settings' },
    { id: 'safe', path: '/safe' },
    { id: 'financial', path: '/financial' },
    { id: 'count', path: '/count' },
    { id: 'tv', path: '/tv' },
];

function ensureDeps() {
    const need = ['lighthouse', 'puppeteer-core'];
    const missing = need.filter((n) => !fs.existsSync(path.join(APP_ROOT, 'node_modules', n)));
    if (!missing.length) return;
    console.log(`Installing ${missing.join(', ')}...`);
    const r = spawnSync(
        'npm',
        ['install', '--no-save', '--no-fund', 'lighthouse@13', 'puppeteer-core'],
        { cwd: APP_ROOT, stdio: 'inherit', shell: true },
    );
    if (r.status !== 0) throw new Error('npm install failed');
}

function scoreRow(id, portalPath, lhr, note) {
    if (!lhr || lhr.runtimeError) {
        return {
            id,
            path: portalPath,
            ok: false,
            note: lhr?.runtimeError?.message || note || 'no lhr',
            perf: null,
            a11y: null,
            bp: null,
            seo: null,
            fcp: null,
            lcp: null,
            tbt: null,
            cls: null,
        };
    }
    const cats = lhr.categories || {};
    return {
        id,
        path: portalPath,
        ok: true,
        note: note || 'authenticated fixture manager',
        perf: Math.round(100 * (cats.performance?.score ?? 0)),
        a11y: Math.round(100 * (cats.accessibility?.score ?? 0)),
        bp: Math.round(100 * (cats['best-practices']?.score ?? 0)),
        seo: Math.round(100 * (cats.seo?.score ?? 0)),
        fcp: Math.round((lhr.audits['first-contentful-paint']?.numericValue || 0) / 10) / 100,
        lcp: Math.round((lhr.audits['largest-contentful-paint']?.numericValue || 0) / 10) / 100,
        tbt: Math.round(lhr.audits['total-blocking-time']?.numericValue || 0),
        cls: Math.round((lhr.audits['cumulative-layout-shift']?.numericValue || 0) * 1000) / 1000,
        title: lhr.audits['document-title']?.displayValue || '',
    };
}

async function main() {
    ensureDeps();
    fs.mkdirSync(OUT, { recursive: true });

    // Resolve ESM/CJS deps from the app root (package.json has "type":"module").
    const puppeteer = require(path.join(APP_ROOT, 'node_modules', 'puppeteer-core'));
    const lhMod = await import(pathToFileUrl(path.join(APP_ROOT, 'node_modules', 'lighthouse', 'core', 'index.js')));
    const startFlow = lhMod.startFlow;
    // Desktop form factor, but skip artificial CPU/network throttle — store Chromebooks
    // are measured on-LAN; throttling inflated CLS races on late CSS/JS.
    const config = {
        ...(lhMod.desktopConfig || {}),
        settings: {
            ...((lhMod.desktopConfig && lhMod.desktopConfig.settings) || {}),
            formFactor: 'desktop',
            throttlingMethod: 'provided',
            throttling: {
                rttMs: 0,
                throughputKbps: 0,
                cpuSlowdownMultiplier: 1,
                requestLatencyMs: 0,
                downloadThroughputKbps: 0,
                uploadThroughputKbps: 0,
            },
            screenEmulation: {
                mobile: false,
                width: 1400,
                height: 900,
                deviceScaleFactor: 1,
                disabled: false,
            },
        },
    };

    console.log(`BASE=${BASE}`);
    const ready = await fetch(`${BASE}/api/ready`).then((r) => r.json());
    console.log(`ready v=${ready.appVersion} uptime=${ready.uptime}`);

    const manager = readManagerCredentials();
    const token = await managerToken();
    console.log(`Fixture manager token acquired (${manager.name})`);

    // CS full/CRM surfaces require a live staff session. The legacy form can use
    // this same session; paired-device coverage lives in the CS route tests.
    const csToken = token;
    const csUser = manager.name;

    const profile = path.join(OUT, '_chrome-profile');
    fs.mkdirSync(profile, { recursive: true });

    const browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: 'new',
        userDataDir: profile,
        defaultViewport: { width: 1400, height: 900 },
        args: ['--no-sandbox', '--disable-gpu'],
    });

    const page = await browser.newPage();
    // Inject session before every document (survives LH about:blank → URL navigations).
    await page.evaluateOnNewDocument(({ token, user, csToken, csUser }) => {
        try {
            sessionStorage.setItem('tgp_token', token);
            localStorage.setItem('tgp_user', user);
            localStorage.removeItem('tgp_token');
            if (csToken) {
                sessionStorage.setItem('tgp_cs_token', csToken);
                sessionStorage.setItem('tgp_cs_user', csUser);
            }
        } catch (_) { /* ignore */ }
    }, {
        token, user: manager.name, csToken, csUser,
    });

    const summary = [];

    try {
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await new Promise((r) => setTimeout(r, 1000));

        for (const p of PORTALS) {
            const url = BASE + p.path;
            console.log(`\n=== ${p.id} ${url} ===`);
            try {
                // Ensure token present before navigation (same tab keeps sessionStorage)
                await page.evaluate((t) => sessionStorage.setItem('tgp_token', t), token);

                const flow = await startFlow(page, {
                    name: `TGP authed ${p.id}`,
                    config: config || undefined,
                });

                // Re-seed immediately before navigate (LH may open cold document)
                await page.evaluate(({ token, user, csToken, csUser }) => {
                    sessionStorage.setItem('tgp_token', token);
                    localStorage.setItem('tgp_user', user);
                    if (csToken) {
                        sessionStorage.setItem('tgp_cs_token', csToken);
                        sessionStorage.setItem('tgp_cs_user', csUser);
                    }
                }, {
                    token, user: manager.name, csToken, csUser,
                });

                await flow.navigate(url, {
                    name: p.id,
                });

                const flowResult = await flow.createFlowResult();
                const steps = flowResult.steps || [];
                const navStep = steps.find((s) => s.lhr) || steps[0];
                const lhr = navStep?.lhr;

                const html = await flow.generateReport();
                fs.writeFileSync(path.join(OUT, `${p.id}.flow.report.html`), html);
                fs.writeFileSync(
                    path.join(OUT, `${p.id}.flow.report.json`),
                    JSON.stringify(flowResult, null, 2),
                );

                if (lhr) {
                    fs.writeFileSync(path.join(OUT, `${p.id}.report.json`), JSON.stringify(lhr, null, 2));
                }

                const bodyHint = await page.evaluate(() =>
                    (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100));
                const loggedIn = /LOGGED IN|LOGOUT|FINANCIAL LOG|TGP REPORTS|INBOUND FREIGHT|FIFO EXPIRY|WORKSITE SAFETY|CS DIRECT|CENTER STORE|Playwright Manager/i.test(bodyHint);
                const row = scoreRow(
                    p.id,
                    p.path,
                    lhr,
                    loggedIn ? `authenticated UI · ${bodyHint}` : `maybe-login · ${bodyHint}`,
                );
                row.authenticatedUi = loggedIn;
                summary.push(row);
                console.log(
                    `perf=${row.perf} a11y=${row.a11y} bp=${row.bp} seo=${row.seo} `
                    + `FCP=${row.fcp}s LCP=${row.lcp}s TBT=${row.tbt}ms CLS=${row.cls} | authUi=${loggedIn} | ${bodyHint}`,
                );
            } catch (e) {
                console.log(`FAIL ${p.id}: ${e.message}`);
                summary.push(scoreRow(p.id, p.path, null, e.message));
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }

    const summaryPath = path.join(OUT, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`\nWrote ${summaryPath}`);
    console.table(summary.map((r) => ({
        id: r.id, ok: r.ok, perf: r.perf, a11y: r.a11y, bp: r.bp, seo: r.seo, lcp: r.lcp, cls: r.cls,
    })));
}

function pathToFileUrl(p) {
    const { pathToFileURL } = require('url');
    return pathToFileURL(p).href;
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
