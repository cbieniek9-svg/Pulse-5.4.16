'use strict';

const PORTALS = [
    ['/', 'floor'],
    ['/cs', 'cs'],
    ['/rec', 'receiving'],
    ['/count', 'count'],
    ['/markdown', 'markdown'],
    ['/reports', 'reports'],
    ['/settings', 'settings'],
    ['/safe', 'safe'],
    ['/financial', 'financial-log'],
    ['/log', 'financial-log-alias'],
    ['/tv', 'tv'],
    ['/public/tv/tv-dashboard.html', 'tv-native'],
];

async function phasePortals(ctx) {
    const { report, request, expectStatusAnon } = ctx;
    const phase = 'portals';

    await report.check(phase, 'load:tv', async () => {
        const r = await fetch(`${ctx.BASE}/tv`, { redirect: 'follow' });
        // Tokenless off after secure-store → 403 pairing page is expected
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    for (const [path, name] of PORTALS.filter(([p]) => p !== '/tv')) {
        await report.check(phase, `load:${name}`, async () => {
            const r = await fetch(`${ctx.BASE}${path}`, { redirect: 'follow' });
            if (!r.ok && r.status !== 304) throw new Error(`HTTP ${r.status}`);
            return String(r.status);
        });
    }

    await report.check(phase, 'betacs-redirect', async () => {
        const r = await request('GET', '/betacs', { raw: true });
        if (r.status !== 301 && r.status !== 302) {
            throw new Error(`expected 301/302, got ${r.status}`);
        }
        return String(r.status);
    });

    await report.check(phase, 'legacy-mobile-redirect', async () => {
        const r = await request('GET', '/mobile.html', { raw: true });
        if (![301, 302].includes(r.status)) throw new Error(`expected redirect, got ${r.status}`);
    });
}

async function phaseAuthSync(ctx) {
    const { report, request, json, token, expectStatusAnon } = ctx;
    const phase = 'auth-sync';

    await report.check(phase, 'anon-sync-shape', async () => {
        const sync = await json('GET', '/api/sync');
        for (const key of ['appVersion', 'tasks', 'oos', 'orders', 'orders_tv', 'staff', 'settings', 'kpis', 'features']) {
            if (sync[key] === undefined) throw new Error(`missing ${key}`);
        }
        return `${sync.appVersion} audience=${sync.syncAudience || '?'}`;
    });

    await report.check(phase, 'privileged-action-blocked', async () => {
        await expectStatusAnon('POST', '/api/action', {
            body: { table: 'staff', action: 'update', id_col: 'id', id_val: 1, data: { active: 0 }, userContext: { name: 'CHRIS' } },
        }, 403);
    });

    await report.check(phase, 'health-requires-session', async () => {
        await expectStatusAnon('GET', '/api/health', {}, 403);
    });

    await report.check(phase, 'reports-requires-session', async () => {
        await expectStatusAnon('GET', '/api/reports', {}, 403);
    });

    await report.check(phase, 'invalid-token-rejected', async () => {
        const r = await request('POST', '/api/eod-sweep', { token: 'INVALID_CHAOS_MONKEY' });
        if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
    });

    await report.check(phase, 'stream-token', async () => {
        const r = await request('POST', '/api/stream-token', {
            body: { token },
            token,
        });
        if (!r.ok || !r.data?.streamToken) throw new Error(`stream-token failed ${r.status}`);
    });

    await report.check(phase, 'sync-excludes-training-identity', async () => {
        const pub = await json('GET', '/api/sync');
        const blob = JSON.stringify(pub);
        if (/TRAINING MODE/i.test(blob) || Object.prototype.hasOwnProperty.call(pub, 'trainingProfile')) {
            throw new Error('training identity still visible in public sync');
        }
    });
}

module.exports = { phasePortals, phaseAuthSync };
