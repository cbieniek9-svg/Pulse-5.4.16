'use strict';
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.TGP_BASE_URL || 'http://127.0.0.1:3001';

/** Retired PoC identity — must not authenticate under 5.4.11 fail-closed defaults. */
const TRAINING = { name: 'TRAINING MODE', pin: '1234' };

function readStaffCache() {
    try {
        return JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', '.playwright-staff-cache.json'), 'utf8'),
        );
    } catch {
        return {};
    }
}

function readManagerCredentials() {
    const cache = readStaffCache();
    if (cache?.managerA?.name && cache?.managerA?.pin) {
        return {
            name: cache.managerA.name,
            pin: cache.managerA.pin,
            role: cache.managerA.role || 'Manager',
        };
    }
    throw new Error(
        'Playwright manager credentials unavailable. Run tests/playwright-seed.cjs under Electron first.',
    );
}

function readCsDeviceToken() {
    if (process.env.TGP_TEST_CS_DEVICE_TOKEN) return process.env.TGP_TEST_CS_DEVICE_TOKEN;
    return readStaffCache().csDeviceToken || '';
}

const CS = { deviceToken: readCsDeviceToken() };

async function waitForServer(maxMs = 90000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const r = await fetch(`${BASE}/api/sync`);
            if (r.ok) return BASE;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1500));
    }
    throw new Error(`Server not reachable at ${BASE} after ${maxMs}ms`);
}

async function request(method, path, {
    body, token, deviceToken, raw = false, retries = 5,
} = {}) {
    const headers = {};
    let requestBody = body;
    const fixtureDeviceToken = deviceToken || body?.userContext?.deviceToken || '';
    if (body?.userContext?.deviceToken) {
        requestBody = { ...body };
        delete requestBody.userContext;
    }
    if (requestBody != null) headers['Content-Type'] = 'application/json';
    if (token) headers['x-session-token'] = token;
    if (fixtureDeviceToken) headers['x-device-token'] = fixtureDeviceToken;

    for (let attempt = 0; attempt <= retries; attempt++) {
        const r = await fetch(`${BASE}${path}`, {
            method,
            headers,
            body: requestBody != null ? JSON.stringify(requestBody) : undefined,
            redirect: raw ? 'manual' : 'follow',
        });
        if (r.status === 429 && attempt < retries) {
            await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
            continue;
        }
        if (raw) return { status: r.status, headers: r.headers, text: await r.text() };
        const text = await r.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        return { ok: r.ok, status: r.status, data, text };
    }
    throw new Error(`Rate limited after ${retries} retries: ${method} ${path}`);
}

async function json(method, path, body, token) {
    const r = await request(method, path, { body, token });
    if (!r.ok) {
        const err = new Error(r.data?.error || r.data?.raw || r.text || `HTTP ${r.status}`);
        err.status = r.status;
        throw err;
    }
    return r.data;
}

async function managerCredentials() {
    return readManagerCredentials();
}

async function managerToken() {
    const manager = readManagerCredentials();
    const auth = await json('POST', '/api/mobile-auth', {
        name: manager.name,
        pin: manager.pin,
    });
    if (!auth.token) throw new Error('No manager token');
    return auth.token;
}

function uid(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

class WalkthroughRunner {
    constructor() {
        this.results = [];
    }

    ok(step, detail = '') {
        this.results.push({ step, ok: true, detail });
        console.log(`  OK  ${step}${detail ? ` — ${detail}` : ''}`);
    }

    bad(step, err) {
        const msg = err?.message || String(err);
        this.results.push({ step, ok: false, detail: msg });
        console.error(` FAIL ${step} — ${msg}`);
    }

    summarize(label = 'FULL APP WALKTHROUGH') {
        const passed = this.results.filter((r) => r.ok).length;
        const failed = this.results.filter((r) => !r.ok);
        console.log(`\n--- ${label} ---`);
        console.log(`${passed}/${this.results.length} steps passed`);
        if (failed.length) {
            console.log('\nFailed:');
            failed.forEach((f) => console.log(`  • ${f.step}: ${f.detail}`));
        }
        console.log('');
        return failed.length;
    }
}

module.exports = {
    BASE,
    TRAINING,
    CS,
    waitForServer,
    request,
    json,
    managerCredentials,
    managerToken,
    readManagerCredentials,
    uid,
    WalkthroughRunner,
};
