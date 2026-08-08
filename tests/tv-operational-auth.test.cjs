'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    resolveStreamCredential,
    issueOneTimeStreamToken,
    consumeOneTimeStreamToken,
    projectStreamEvent,
    isStreamPrincipalCurrent,
    createStreamSecurity,
} = require('../src/lib/app-boot.cjs');
const { createDeviceToken, hashDeviceToken } = require('../src/lib/trusted-device-tokens.cjs');

function makeDeviceHarness(purpose = 'tv') {
    const token = createDeviceToken();
    const row = {
        id: 7,
        ip_address: '192.168.1.7',
        label: 'TV 7',
        status: 'Authorized',
        device_purpose: purpose,
        device_token_hash: hashDeviceToken(token),
    };
    const db = {
        get(sql, ...params) {
            if (sql.includes('id=?') && sql.includes('device_token_hash=?')) {
                return Number(params[0]) === row.id
                    && params[1] === row.device_token_hash
                    && row.status === 'Authorized'
                    && row.device_purpose === 'tv'
                    ? { id: row.id }
                    : null;
            }
            if (sql.includes('device_token_hash=?')
                && params[0] === row.device_token_hash
                && row.status === 'Authorized') return { ...row };
            return null;
        },
        run() { return { changes: 1 }; },
    };
    const req = (presented = token, extra = {}) => ({
        headers: presented ? { 'x-device-token': presented } : {},
        body: {},
        ip: row.ip_address,
        query: {},
        ...extra,
    });
    return { db, row, token, req };
}

test('stream credential requires a live staff session or current tv-purpose token', () => {
    const harness = makeDeviceHarness();
    const auth = { getSession: (token) => token === 'live-staff' ? { name: 'Clerk', role: 'Clerk' } : null };

    assert.equal(resolveStreamCredential({
        db: harness.db,
        auth,
        req: harness.req('', { body: { token: 'live-staff' } }),
    }).kind, 'staff');
    assert.equal(resolveStreamCredential({
        db: harness.db,
        auth,
        req: harness.req(),
    }).kind, 'tv');

    harness.row.device_purpose = 'receiving';
    assert.equal(resolveStreamCredential({ db: harness.db, auth, req: harness.req() }), null);
    harness.row.device_purpose = 'tv';
    harness.row.status = 'Revoked';
    assert.equal(resolveStreamCredential({ db: harness.db, auth, req: harness.req() }), null);
    harness.row.status = 'Authorized';
    assert.equal(resolveStreamCredential({ db: harness.db, auth, req: harness.req('') }), null);
});

test('stream credentials retain only minimal revalidation metadata and audience', () => {
    const harness = makeDeviceHarness();
    const auth = {
        getSession: (token) => token === 'manager-session'
            ? { name: 'Manager', role: 'Manager', staff_id: 9 }
            : null,
    };
    const staff = resolveStreamCredential({
        db: harness.db,
        auth,
        req: harness.req('', { body: { token: 'manager-session' } }),
    });
    assert.deepEqual(staff, {
        kind: 'staff',
        audience: 'manager',
        sessionToken: 'manager-session',
    });
    const tv = resolveStreamCredential({ db: harness.db, auth, req: harness.req() });
    assert.deepEqual(tv, {
        kind: 'tv',
        audience: 'tv',
        deviceId: 7,
        deviceTokenHash: hashDeviceToken(harness.token),
    });
    assert.equal(JSON.stringify(tv).includes(harness.token), false);
});

test('TV, staff, and manager streams receive only refresh signals', () => {
    const sensitive = {
        table: 'staff',
        action: 'update',
        data: {
            pin: 'MANAGER-PIN-SECRET',
            contact: '780-555-0123',
        },
    };
    const refresh = { type: 'REFRESH' };
    assert.deepEqual(projectStreamEvent({ audience: 'tv' }, sensitive), refresh);
    assert.deepEqual(projectStreamEvent({ audience: 'staff' }, sensitive), refresh);
    assert.deepEqual(projectStreamEvent({ audience: 'manager' }, sensitive), refresh);
});

test('stream principals revalidate device hash purpose status and staff access', () => {
    const harness = makeDeviceHarness();
    const sessions = new Set(['staff-session']);
    const auth = {
        getSession: (token) => sessions.has(token) ? { role: 'Clerk' } : null,
    };
    const tv = resolveStreamCredential({ db: harness.db, auth, req: harness.req() });
    const staff = resolveStreamCredential({
        db: harness.db,
        auth,
        req: harness.req('', { body: { token: 'staff-session' } }),
    });

    assert.equal(isStreamPrincipalCurrent({ db: harness.db, auth, principal: tv }), true);
    assert.equal(isStreamPrincipalCurrent({ db: harness.db, auth, principal: staff }), true);
    harness.row.device_token_hash = hashDeviceToken(createDeviceToken());
    assert.equal(isStreamPrincipalCurrent({ db: harness.db, auth, principal: tv }), false);
    harness.row.device_token_hash = tv.deviceTokenHash;
    harness.row.device_purpose = 'receiving';
    assert.equal(isStreamPrincipalCurrent({ db: harness.db, auth, principal: tv }), false);
    harness.row.device_purpose = 'tv';
    harness.row.status = 'Revoked';
    assert.equal(isStreamPrincipalCurrent({ db: harness.db, auth, principal: tv }), false);
    sessions.delete('staff-session');
    assert.equal(isStreamPrincipalCurrent({ db: harness.db, auth, principal: staff }), false);
});

test('TV access key and matching IP never authorize stream credentials', () => {
    const harness = makeDeviceHarness();
    const auth = { getSession: () => null };
    const req = harness.req('', { query: { key: 'TV-KEY-ONLY' } });
    assert.equal(resolveStreamCredential({ db: harness.db, auth, req }), null);
});

test('stream tokens are unexpired one-time credentials', () => {
    const tokens = new Map();
    const now = 1_000_000;
    const streamToken = issueOneTimeStreamToken(tokens, { kind: 'tv', deviceId: 7 }, now);

    assert.deepEqual(
        consumeOneTimeStreamToken(tokens, streamToken, now + 29_999),
        { kind: 'tv', deviceId: 7 },
    );
    assert.equal(consumeOneTimeStreamToken(tokens, streamToken, now + 30_000), null);

    const expired = issueOneTimeStreamToken(tokens, { kind: 'staff', sessionToken: 'staff' }, now);
    assert.equal(consumeOneTimeStreamToken(tokens, expired, now + 30_001), null);
    assert.equal(tokens.has(expired), false);
    assert.equal(consumeOneTimeStreamToken(tokens, '', now), null);
});

test('stream token issuance sweeps expiry and caps pending credentials', () => {
    const tokens = new Map();
    for (let i = 0; i < 4; i++) {
        issueOneTimeStreamToken(tokens, { kind: 'staff', sessionToken: `s${i}` }, 1000 + i, {
            maxSize: 3,
        });
    }
    assert.equal(tokens.size, 3);
    assert.equal([...tokens.values()].some((entry) => entry.principal.sessionToken === 's0'), false);

    issueOneTimeStreamToken(tokens, { kind: 'staff', sessionToken: 'fresh' }, 32_000, {
        maxSize: 3,
    });
    assert.equal(tokens.size, 1);
    assert.equal([...tokens.values()][0].principal.sessionToken, 'fresh');
});

test('broadcast revalidates clients, projects TV events, and closes revoked or old streams', () => {
    const harness = makeDeviceHarness();
    let now = 1000;
    const auth = { getSession: () => null };
    const security = createStreamSecurity({
        db: harness.db,
        auth,
        now: () => now,
        connectionLifetimeMs: 60_000,
        heartbeatMs: 0,
    });
    const writes = [];
    let ended = false;
    const res = {
        writableEnded: false,
        write: (chunk) => { writes.push(chunk); },
        end: () => { ended = true; res.writableEnded = true; },
    };
    const req = { on() {} };
    const principal = resolveStreamCredential({ db: harness.db, auth, req: harness.req() });
    security.attach(req, res, principal);
    security.broadcast({
        table: 'staff',
        action: 'update',
        data: { pin: 'NEVER-TV', customer: 'SECRET CUSTOMER' },
    });
    assert.equal(writes.length, 1);
    assert.equal(writes[0], 'data: {"type":"REFRESH"}\n\n');
    assert.equal(writes[0].includes('NEVER-TV'), false);
    assert.equal(writes[0].includes('SECRET CUSTOMER'), false);

    harness.row.status = 'Revoked';
    security.maintain();
    assert.equal(ended, true);
    assert.equal(security.stats().clientCount, 0);

    harness.row.status = 'Authorized';
    ended = false;
    res.writableEnded = false;
    security.attach(req, res, principal);
    now += 60_001;
    security.maintain();
    assert.equal(ended, true);
    security.stop();
});

test('TV shell is public for fragment import but operational routes have no tokenless fallback', () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../src/lib/app-boot.cjs'),
        'utf8',
    );
    assert.doesNotMatch(source, /isTokenlessStoreModeEnabled/);
    assert.match(source, /requiredPurpose:\s*['"]tv['"]/);
    assert.doesNotMatch(source, /allowIpFallback:\s*true/);
    assert.match(source, /const serveTv[\s\S]*res\.sendFile\(tvFile\)/);
    assert.doesNotMatch(source, /const serveTv[\s\S]*res\.status\(403\)/);
});
