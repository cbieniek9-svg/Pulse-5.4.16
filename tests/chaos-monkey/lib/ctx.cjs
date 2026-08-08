'use strict';

const {
    BASE, TRAINING, CS, waitForServer, request, json, managerToken, uid,
} = require('../../helpers/api-client.cjs');

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function readyProbe() {
    const r = await request('GET', '/api/ready');
    if (!r.ok) throw new Error(`ready ${r.status}`);
    return r.data;
}

async function expectStatus(method, path, opts, allowed) {
    const r = await request(method, path, opts);
    const okList = Array.isArray(allowed) ? allowed : [allowed];
    if (!okList.includes(r.status)) {
        throw new Error(`expected ${okList.join('|')}, got ${r.status}: ${r.data?.error || r.text || ''}`);
    }
    return r;
}

async function action(token, body) {
    return json('POST', '/api/action', {
        ...body,
        userContext: body.userContext || { name: TRAINING.name, pin: TRAINING.pin, token },
        token,
    }, token);
}

/**
 * Build shared monkey context. Failures here are fatal only for missing server/auth.
 */
async function createCtx(report) {
    await waitForServer(60000);
    report.meta.base = BASE;
    const ready = await readyProbe();
    report.meta.ready = ready;
    report.pass('boot', 'api-ready', `v${ready.appVersion || '?'} uptime=${ready.uptime}`);

    let token;
    try {
        token = await managerToken();
        report.pass('boot', 'manager-auth', TRAINING.name);
    } catch (e) {
        report.fail('boot', 'manager-auth', e.message);
        throw e;
    }

    const sync = await json('GET', '/api/sync', null, token).catch((e) => {
        report.fail('boot', 'manager-sync', e.message);
        throw e;
    });
    report.pass('boot', 'manager-sync', `tasks=${(sync.tasks || []).length}`);

    return {
        BASE,
        TRAINING,
        CS,
        token,
        sync,
        report,
        uid,
        json,
        request,
        action: (body) => action(token, body),
        expectStatus: (method, path, opts, allowed) => expectStatus(method, path, { ...opts, token }, allowed),
        expectStatusAnon: expectStatus,
        readyProbe,
        sleep,
        features: sync.features || {},
        settings: sync.settings || {},
    };
}

module.exports = {
    createCtx,
    readyProbe,
    BASE,
    TRAINING,
    CS,
    uid,
    json,
    request,
};
