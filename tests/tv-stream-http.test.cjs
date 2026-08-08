'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { registerStreamRoutes } = require('../src/lib/app-boot.cjs');
const { createDeviceToken, hashDeviceToken } = require('../src/lib/trusted-device-tokens.cjs');

async function startHarness(t, options = {}) {
    const deviceToken = createDeviceToken();
    const device = {
        id: 77,
        ip_address: '127.0.0.1',
        label: 'HTTP TV',
        status: 'Authorized',
        device_purpose: 'tv',
        device_token_hash: hashDeviceToken(deviceToken),
    };
    const sessions = new Map([
        ['staff-live', { role: 'Clerk', name: 'HTTP Clerk' }],
        ['manager-live', { role: 'Manager', name: 'HTTP Manager' }],
    ]);
    const db = {
        get(sql, ...params) {
            if (sql.includes('WHERE device_token_hash=?')) {
                return params[0] === device.device_token_hash && device.status === 'Authorized'
                    ? { ...device }
                    : null;
            }
            if (sql.includes('WHERE id=? AND device_token_hash=?')) {
                return Number(params[0]) === device.id
                    && params[1] === device.device_token_hash
                    && device.status === 'Authorized'
                    && device.device_purpose === 'tv'
                    ? { id: device.id }
                    : null;
            }
            return null;
        },
        run() { return { changes: 1 }; },
    };
    const auth = { getSession: (token) => sessions.get(token) || null };
    let now = 1_000_000;
    const app = express();
    app.use(express.json());
    const streams = registerStreamRoutes(app, {
        db,
        auth,
        testMode: true,
        now: () => now,
        heartbeatMs: 0,
        tokenTtlMs: 1000,
        connectionLifetimeMs: 5000,
        maxPendingTokens: 3,
        ...options,
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    t.after(async () => {
        streams.stop();
        await new Promise((resolve) => server.close(resolve));
    });
    return {
        base,
        streams,
        device,
        deviceToken,
        sessions,
        advance: (ms) => { now += ms; },
    };
}

async function exchange(base, body = {}, headers = {}) {
    return fetch(`${base}/api/stream-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

test('HTTP TV stream consumes token once and projects sensitive delta to refresh', async (t) => {
    const h = await startHarness(t);
    const issued = await exchange(h.base, {}, { 'x-device-token': h.deviceToken });
    assert.equal(issued.status, 200);
    const { streamToken } = await issued.json();

    const stream = await fetch(`${h.base}/api/stream?st=${encodeURIComponent(streamToken)}`);
    assert.equal(stream.status, 200);
    const replay = await fetch(`${h.base}/api/stream?st=${encodeURIComponent(streamToken)}`);
    assert.equal(replay.status, 401);

    h.streams.broadcast({
        table: 'staff',
        action: 'update',
        data: { pin: 'HTTP-MANAGER-SECRET', phone: '780-555-0198' },
    });
    const reader = stream.body.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(chunk, /data: \{"type":"REFRESH"\}/);
    assert.equal(chunk.includes('HTTP-MANAGER-SECRET'), false);
    assert.equal(chunk.includes('780-555-0198'), false);
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(h.streams.stats().clientCount, 0);
});

test('HTTP stream closes promptly when device or staff principal is revoked', async (t) => {
    const h = await startHarness(t);
    const tvIssued = await exchange(h.base, {}, { 'x-device-token': h.deviceToken });
    const tvToken = (await tvIssued.json()).streamToken;
    const tvStream = await fetch(`${h.base}/api/stream?st=${encodeURIComponent(tvToken)}`);
    const tvReader = tvStream.body.getReader();
    h.device.status = 'Revoked';
    h.streams.maintain();
    assert.equal((await tvReader.read()).done, true);

    const staffIssued = await exchange(h.base, { token: 'staff-live' });
    const staffToken = (await staffIssued.json()).streamToken;
    const staffStream = await fetch(`${h.base}/api/stream?st=${encodeURIComponent(staffToken)}`);
    const staffReader = staffStream.body.getReader();
    h.sessions.delete('staff-live');
    h.streams.maintain();
    assert.equal((await staffReader.read()).done, true);
    assert.equal(h.streams.stats().clientCount, 0);
});

test('HTTP stream rejects expired tokens, sweeps pending entries, and denies invalid devices', async (t) => {
    const h = await startHarness(t);
    const first = await exchange(h.base, {}, { 'x-device-token': h.deviceToken });
    const expiredToken = (await first.json()).streamToken;
    h.advance(1001);
    assert.equal((await fetch(`${h.base}/api/stream?st=${encodeURIComponent(expiredToken)}`)).status, 401);
    assert.equal(h.streams.stats().pendingTokenCount, 0);

    h.device.device_purpose = 'receiving';
    assert.equal((await exchange(h.base, {}, { 'x-device-token': h.deviceToken })).status, 401);
    h.device.device_purpose = 'tv';
    h.device.status = 'Revoked';
    assert.equal((await exchange(h.base, {}, { 'x-device-token': h.deviceToken })).status, 401);
    assert.equal((await exchange(h.base)).status, 401);
});
