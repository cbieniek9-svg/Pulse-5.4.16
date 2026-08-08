'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    createDeviceToken,
    normalizeDeviceToken,
    hashDeviceToken,
    extractDeviceToken,
    findAuthorizedTrustedDevice,
    issueDeviceTokenForDevice,
    revokeDeviceToken,
    sanitizeTrustedDevice,
    assertCurrentDeviceAuthorization,
} = require('../src/lib/trusted-device-tokens.cjs');

function makeDb() {
    const rows = [
        { id: 1, ip_address: '192.168.1.10', label: 'TV 1', status: 'Authorized', device_purpose: 'tv', last_seen: null, last_seen_at: null, device_token_hash: null },
        { id: 2, ip_address: '192.168.1.11', label: 'Pending device', status: 'Pending', device_purpose: '', last_seen: null, last_seen_at: null, device_token_hash: null },
        { id: 3, ip_address: '192.168.1.12', label: 'Revoked desk', status: 'Revoked', device_purpose: 'cs_desk', last_seen: null, last_seen_at: null, device_token_hash: null },
    ];
    return {
        rows,
        transaction(fn) {
            return (...args) => fn(...args);
        },
        get(sql, ...params) {
            if (sql.includes('WHERE id=? AND device_token_hash=?')) {
                return rows.find((r) => (
                    r.id === Number(params[0])
                    && r.device_token_hash === params[1]
                    && r.status === 'Authorized'
                )) || null;
            }
            if (sql.includes('WHERE device_token_hash=?')) return rows.find((r) => r.device_token_hash === params[0] && r.status === 'Authorized') || null;
            if (sql.includes('WHERE id=')) {
                const row = rows.find((r) => r.id === Number(params[0])) || null;
                if (row && sql.includes('AS has_device_token')) {
                    return { ...row, has_device_token: row.device_token_hash ? 1 : 0 };
                }
                return row;
            }
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('device_token_hash=NULL')) {
                const [id, expectedStatus, expectedPurpose, expectedHash] = params;
                const row = rows.find((r) => (
                    r.id === Number(id)
                    && r.status === expectedStatus
                    && r.device_purpose === expectedPurpose
                    && r.device_token_hash === expectedHash
                ));
                if (row) { row.device_token_hash = null; row.token_created_at = null; }
                return { changes: row ? 1 : 0 };
            }
            if (sql.includes('SET status=?, label=?, device_purpose=?, device_token_hash=?')) {
                const [status, label, purpose, hash, tokenCreatedAt, lastSeenAt, id, expectedStatus, expectedPurpose, expectedHash] = params;
                const row = rows.find((r) => (
                    r.id === Number(id)
                    && r.status === expectedStatus
                    && r.device_purpose === expectedPurpose
                    && r.device_token_hash === expectedHash
                ));
                if (row) Object.assign(row, { status, label, device_purpose: purpose, device_token_hash: hash, token_created_at: tokenCreatedAt, last_seen_at: row.last_seen_at || lastSeenAt });
                return { changes: row ? 1 : 0 };
            }
            if (sql.includes('SET status=?, device_purpose=?, device_token_hash=?')) {
                const [status, purpose, hash, tokenCreatedAt, lastSeenAt, id, expectedStatus, expectedPurpose, expectedHash] = params;
                const row = rows.find((r) => (
                    r.id === Number(id)
                    && r.status === expectedStatus
                    && r.device_purpose === expectedPurpose
                    && r.device_token_hash === expectedHash
                ));
                if (row) Object.assign(row, { status, device_purpose: purpose, device_token_hash: hash, token_created_at: tokenCreatedAt, last_seen_at: row.last_seen_at || lastSeenAt });
                return { changes: row ? 1 : 0 };
            }
            if (sql.includes('SET last_seen=?, last_seen_at=? WHERE id=?')) {
                const [last_seen, last_seen_at, id] = params;
                const row = rows.find((r) => r.id === Number(id));
                if (row) Object.assign(row, { last_seen, last_seen_at });
                return { changes: row ? 1 : 0 };
            }
            if (sql.includes('SET ip_address=? WHERE id=?')) {
                const [ip, id] = params;
                const row = rows.find((r) => r.id === Number(id));
                if (row) row.ip_address = ip;
                return { changes: row ? 1 : 0 };
            }
            return { changes: 0 };
        },
    };
}

function makeSqliteDb(t) {
    let Database;
    try {
        Database = require('better-sqlite3');
        const probe = new Database(':memory:');
        probe.close();
    } catch (error) {
        t.skip(`better-sqlite3 is not loadable in this runtime: ${error.message || error}`);
        return null;
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-device-token-'));
    const sqlite = new Database(path.join(tempDir, 'tokens.db'));
    sqlite.exec(`
        CREATE TABLE trusted_devices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ip_address TEXT UNIQUE,
            label TEXT,
            status TEXT DEFAULT 'Pending',
            last_seen TEXT,
            device_token_hash TEXT,
            token_created_at TEXT,
            last_seen_at TEXT,
            device_purpose TEXT NOT NULL DEFAULT ''
        );
    `);
    t.after(() => {
        sqlite.close();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    return {
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run: (sql, ...params) => sqlite.prepare(sql).run(...params),
        exec: (sql) => sqlite.exec(sql),
        transaction: (fn) => sqlite.transaction(fn),
    };
}

test('device tokens accept only the exact generated string format', () => {
    const token = createDeviceToken();
    assert.equal(token.length, 49);
    assert.equal(normalizeDeviceToken(token), token);
    assert.equal(normalizeDeviceToken(` ${token} `), '');
    assert.equal(normalizeDeviceToken(token.replace('tgpdt_', 'wrong_')), '');
    assert.equal(normalizeDeviceToken(token.slice(0, -1)), '');
    assert.equal(normalizeDeviceToken(`${token}A`), '');
    assert.equal(normalizeDeviceToken({ toString: () => token }), '');
    assert.equal(normalizeDeviceToken(123), '');
});

test('token extraction gives a presented header precedence over body credentials', () => {
    const db = makeDb();
    const headerToken = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' }).deviceToken;
    const bodyToken = createDeviceToken();

    assert.equal(extractDeviceToken({
        headers: { 'x-device-token': headerToken },
        body: { deviceToken: bodyToken },
    }), headerToken);

    const malformedHeader = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': 'not-a-device-token' },
        body: { deviceToken: headerToken },
    });
    assert.equal(malformedHeader.via, 'token');
    assert.equal(malformedHeader.reason, 'invalid_token');
});

test('token extraction preserves malformed-present distinction for body values', () => {
    const db = makeDb();
    const validToken = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' }).deviceToken;

    for (const req of [
        { body: { deviceToken: { token: validToken }, device_token: validToken } },
        { body: { deviceToken: 123 } },
        { body: { device_token: validToken.slice(0, -1) } },
    ]) {
        const result = findAuthorizedTrustedDevice(db, req);
        assert.equal(result.authorized, false);
        assert.equal(result.via, 'token');
        assert.equal(result.reason, 'invalid_token');
    }
});

test('issueDeviceTokenForDevice stores only a hash and returns a raw token once', () => {
    const db = makeDb();
    const issued = issueDeviceTokenForDevice(db, 2, { label: 'Front Desk', purpose: ' CS_DESK ' });

    assert.match(issued.deviceToken, /^tgpdt_/);
    const row = db.rows.find((r) => r.id === 2);
    assert.equal(row.status, 'Authorized');
    assert.equal(row.label, 'Front Desk');
    assert.equal(row.device_purpose, 'cs_desk');
    assert.equal(issued.devicePurpose, 'cs_desk');
    assert.equal(row.device_token_hash, hashDeviceToken(issued.deviceToken));
    assert.notEqual(row.device_token_hash, issued.deviceToken);
});

test('findAuthorizedTrustedDevice prefers token auth and touches last_seen', () => {
    const db = makeDb();
    const issued = issueDeviceTokenForDevice(db, 1, { label: 'TV 1', purpose: 'tv' });
    const result = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': issued.deviceToken },
        ip: '192.168.1.99',
        body: {},
    }, { requiredPurpose: ' TV ' });

    assert.equal(result.authorized, true);
    assert.equal(result.via, 'token');
    assert.equal(result.device.id, 1);
    assert.ok(db.rows[0].last_seen_at);
    assert.equal(db.rows[0].ip_address, '192.168.1.99');
});

test('findAuthorizedTrustedDevice denies an authorized matching IP even with compatibility fallback enabled', () => {
    const db = makeDb();
    const result = findAuthorizedTrustedDevice(db, {
        headers: {},
        ip: '192.168.1.10',
        body: {},
    }, { allowIpFallback: true });

    assert.deepEqual(result, {
        authorized: false,
        device: null,
        via: null,
        reason: 'missing_token',
        code: 'DEVICE_TOKEN_REQUIRED',
    });
});

test('findAuthorizedTrustedDevice treats a malformed presented token as invalid token auth', () => {
    const db = makeDb();
    const result = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': 'bad token!' },
        ip: '192.168.1.10',
        body: {},
    }, { allowIpFallback: true });

    assert.equal(result.authorized, false);
    assert.equal(result.via, 'token');
    assert.equal(result.reason, 'invalid_token');
    assert.equal(result.code, 'INVALID_DEVICE_TOKEN');
});

test('findAuthorizedTrustedDevice rejects a valid token with the wrong required purpose', () => {
    const db = makeDb();
    const issued = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' });
    const result = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': issued.deviceToken },
        ip: '192.168.1.10',
        body: {},
    }, { requiredPurpose: 'receiving' });

    assert.equal(result.authorized, false);
    assert.equal(result.via, 'token');
    assert.equal(result.reason, 'wrong_purpose');
    assert.equal(result.code, 'DEVICE_CAPABILITY_FORBIDDEN');
    assert.equal(result.device.id, 1);
});

test('authorization queries and results never expose token hashes', () => {
    const db = makeDb();
    const queries = [];
    const get = db.get;
    db.get = (sql, ...params) => {
        queries.push(sql);
        return get(sql, ...params);
    };
    const issued = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' });

    const authorized = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': issued.deviceToken },
        body: {},
    }, { requiredPurpose: 'tv' });
    const wrongPurpose = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': issued.deviceToken },
        body: {},
    }, { requiredPurpose: 'receiving' });

    assert.equal(queries.filter((sql) => sql.includes('device_token_hash=?')).every((sql) => !/SELECT\s+\*/i.test(sql)), true);
    for (const result of [authorized, wrongPurpose]) {
        assert.equal(Object.hasOwn(result.device, 'device_token_hash'), false);
        assert.equal(Object.hasOwn(result.device, 'pairing_code_hash'), false);
    }
});

test('findAuthorizedTrustedDevice rejects a valid token when requiredPurpose is blank', () => {
    const db = makeDb();
    const issued = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' });
    const result = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': issued.deviceToken },
        body: {},
    }, { requiredPurpose: '' });

    assert.equal(result.authorized, false);
    assert.equal(result.via, 'token');
    assert.equal(result.reason, 'wrong_purpose');
    assert.equal(result.code, 'DEVICE_CAPABILITY_FORBIDDEN');
    assert.equal(result.device.id, 1);
});

test('findAuthorizedTrustedDevice rejects a valid token on a blank-purpose device', () => {
    const db = makeDb();
    const token = createDeviceToken();
    db.rows[1].status = 'Authorized';
    db.rows[1].device_token_hash = hashDeviceToken(token);

    const result = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': token },
        body: {},
    }, { requiredPurpose: 'receiving' });

    assert.equal(result.authorized, false);
    assert.equal(result.reason, 'wrong_purpose');
    assert.equal(result.code, 'DEVICE_CAPABILITY_FORBIDDEN');
});

test('findAuthorizedTrustedDevice requires Authorized token status', () => {
    const db = makeDb();
    const token = createDeviceToken();
    db.rows[2].device_token_hash = hashDeviceToken(token);

    const result = findAuthorizedTrustedDevice(db, {
        headers: { 'x-device-token': token },
        body: {},
    });

    assert.equal(result.authorized, false);
    assert.equal(result.via, 'token');
    assert.equal(result.code, 'INVALID_DEVICE_TOKEN');
});

test('issueDeviceTokenForDevice requires an explicit valid purpose for first issue', () => {
    const db = makeDb();

    assert.throws(() => issueDeviceTokenForDevice(db, 2), /valid device purpose/i);
    assert.throws(() => issueDeviceTokenForDevice(db, 2, { purpose: 'unknown' }), /valid device purpose/i);
    assert.equal(db.rows[1].device_token_hash, null);
    assert.equal(db.rows[1].device_purpose, '');
});

test('issueDeviceTokenForDevice preserves an existing valid purpose on rotation', () => {
    const db = makeDb();
    const first = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' });
    const firstHash = db.rows[0].device_token_hash;
    const rotated = issueDeviceTokenForDevice(db, 1);

    assert.equal(rotated.devicePurpose, 'tv');
    assert.equal(db.rows[0].device_purpose, 'tv');
    assert.notEqual(rotated.deviceToken, first.deviceToken);
    assert.notEqual(db.rows[0].device_token_hash, firstHash);
});

test('issueDeviceTokenForDevice always authorizes issuance and ignores caller status input', () => {
    const db = makeDb();
    const issued = issueDeviceTokenForDevice(db, 2, {
        purpose: 'receiving',
        status: 'Pending',
    });

    assert.match(issued.deviceToken, /^tgpdt_/);
    assert.equal(db.rows[1].status, 'Authorized');
});

test('issueDeviceTokenForDevice validates an explicit replacement purpose', () => {
    const db = makeDb();

    assert.throws(() => issueDeviceTokenForDevice(db, 1, { purpose: 'not-real' }), /valid device purpose/i);
    assert.equal(db.rows[0].device_purpose, 'tv');
    assert.equal(db.rows[0].device_token_hash, null);

    const issued = issueDeviceTokenForDevice(db, 1, { purpose: ' MARKDOWN ' });
    assert.equal(issued.devicePurpose, 'markdown');
    assert.equal(db.rows[0].device_purpose, 'markdown');
});

test('issueDeviceTokenForDevice returns no token when its conditional update changes zero rows', () => {
    const db = makeDb();
    const run = db.run;
    db.run = (sql, ...params) => {
        if (sql.includes('SET status=?')) return { changes: 0 };
        return run(sql, ...params);
    };

    assert.throws(
        () => issueDeviceTokenForDevice(db, 1, { purpose: 'tv' }),
        /changed|conflict|no longer exists/i,
    );
});

test('issueDeviceTokenForDevice detects a concurrent rotation instead of overwriting it', () => {
    const db = makeDb();
    const run = db.run;
    db.run = (sql, ...params) => {
        if (sql.includes('SET status=?')) db.rows[0].device_token_hash = hashDeviceToken(createDeviceToken());
        return run(sql, ...params);
    };

    assert.throws(
        () => issueDeviceTokenForDevice(db, 1, { purpose: 'tv' }),
        /changed|conflict/i,
    );
});

test('sanitizeTrustedDevice allowlists public fields and token presence only', () => {
    const token = createDeviceToken();
    const safe = sanitizeTrustedDevice({
        id: 1,
        ip_address: '192.168.1.10',
        label: 'TV',
        device_purpose: 'tv',
        device_token_hash: hashDeviceToken(token),
        pairing_code_hash: 'also-secret',
        status: 'Authorized',
        unexpected_secret: 'never expose me',
    });
    assert.deepEqual(safe, {
        id: 1,
        ip_address: '192.168.1.10',
        label: 'TV',
        status: 'Authorized',
        last_seen: null,
        last_seen_at: null,
        token_created_at: null,
        device_purpose: 'tv',
        has_device_token: true,
    });
});

test('revokeDeviceToken clears the token immediately but preserves purpose', () => {
    const db = makeDb();
    const issued = issueDeviceTokenForDevice(db, 1, { label: 'TV 1', purpose: 'tv' });
    assert.ok(hashDeviceToken(issued.deviceToken));
    revokeDeviceToken(db, 1);
    assert.equal(db.rows[0].device_token_hash, null);
    assert.equal(db.rows[0].token_created_at, null);
    assert.equal(db.rows[0].device_purpose, 'tv');
});

test('revokeDeviceToken is idempotent for an existing revoked device but throws for a missing row', () => {
    const db = makeDb();

    assert.deepEqual(revokeDeviceToken(db, 1), { changes: 0, alreadyRevoked: true });
    assert.throws(() => revokeDeviceToken(db, 999), /not found/i);
});

test('assertCurrentDeviceAuthorization revalidates status purpose and revocation', () => {
    assert.equal(typeof assertCurrentDeviceAuthorization, 'function');
    const db = makeDb();
    const issued = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' });
    const req = {
        headers: { 'x-device-token': issued.deviceToken },
        body: {},
    };
    const authorization = findAuthorizedTrustedDevice(db, req, { requiredPurpose: 'tv' });

    const current = assertCurrentDeviceAuthorization(db, authorization, req, 'tv');
    assert.equal(current.id, 1);
    assert.equal(Object.hasOwn(current, 'device_token_hash'), false);

    db.rows[0].status = 'Revoked';
    assert.throws(
        () => assertCurrentDeviceAuthorization(db, authorization, req, 'tv'),
        (error) => error.code === 'INVALID_DEVICE_TOKEN',
    );

    db.rows[0].status = 'Authorized';
    db.rows[0].device_purpose = 'receiving';
    assert.throws(
        () => assertCurrentDeviceAuthorization(db, authorization, req, 'tv'),
        (error) => error.code === 'DEVICE_CAPABILITY_FORBIDDEN',
    );

    db.rows[0].device_purpose = 'tv';
    db.rows[0].device_token_hash = null;
    assert.throws(
        () => assertCurrentDeviceAuthorization(db, authorization, req, 'tv'),
        (error) => error.code === 'INVALID_DEVICE_TOKEN',
    );
});

test('assertCurrentDeviceAuthorization proves the originally presented token remains current', () => {
    const db = makeDb();
    const first = issueDeviceTokenForDevice(db, 1, { purpose: 'tv' });
    const oldReq = { headers: { 'x-device-token': first.deviceToken }, body: {} };
    const oldAuthorization = findAuthorizedTrustedDevice(db, oldReq, { requiredPurpose: 'tv' });

    const rotated = issueDeviceTokenForDevice(db, 1);
    assert.throws(
        () => assertCurrentDeviceAuthorization(db, oldAuthorization, oldReq, 'tv'),
        (error) => error.code === 'INVALID_DEVICE_TOKEN',
    );

    const newReq = { headers: { 'x-device-token': rotated.deviceToken }, body: {} };
    const currentAuthorization = findAuthorizedTrustedDevice(db, newReq, { requiredPurpose: 'tv' });
    const current = assertCurrentDeviceAuthorization(
        db,
        currentAuthorization,
        newReq,
        'tv',
    );
    assert.equal(current.id, 1);
    assert.equal(Object.hasOwn(current, 'device_token_hash'), false);
});

test('SQLite token lifecycle rotates and revokes immediately without exposing hashes', (t) => {
    const db = makeSqliteDb(t);
    if (!db) return;
    db.run(
        "INSERT INTO trusted_devices (id, ip_address, label, status, device_purpose) VALUES (1, '192.168.1.20', 'Dock', 'Pending', '')",
    );

    const first = issueDeviceTokenForDevice(db, 1, { purpose: 'receiving' });
    let stored = db.get('SELECT status, device_purpose, device_token_hash FROM trusted_devices WHERE id=1');
    assert.equal(stored.status, 'Authorized');
    assert.equal(stored.device_purpose, 'receiving');
    assert.equal(stored.device_token_hash, hashDeviceToken(first.deviceToken));

    const rotated = issueDeviceTokenForDevice(db, 1);
    assert.equal(findAuthorizedTrustedDevice(db, { headers: { 'x-device-token': first.deviceToken } }).authorized, false);
    const authorized = findAuthorizedTrustedDevice(
        db,
        { headers: { 'x-device-token': rotated.deviceToken } },
        { requiredPurpose: 'receiving' },
    );
    assert.equal(authorized.authorized, true);
    assert.equal(Object.hasOwn(authorized.device, 'device_token_hash'), false);

    assert.deepEqual(revokeDeviceToken(db, 1), { changes: 1, alreadyRevoked: false });
    assert.equal(findAuthorizedTrustedDevice(db, { headers: { 'x-device-token': rotated.deviceToken } }).authorized, false);
    stored = db.get('SELECT status, device_purpose, device_token_hash FROM trusted_devices WHERE id=1');
    assert.deepEqual(stored, {
        status: 'Authorized',
        device_purpose: 'receiving',
        device_token_hash: null,
    });
    assert.deepEqual(revokeDeviceToken(db, 1), { changes: 0, alreadyRevoked: true });
    assert.throws(() => issueDeviceTokenForDevice(db, 999, { purpose: 'tv' }), /not found/i);
    assert.throws(() => revokeDeviceToken(db, 999), /not found/i);
});

test('SQLite zero-row issue and revoke operations throw and return no credential', (t) => {
    const db = makeSqliteDb(t);
    if (!db) return;
    const token = createDeviceToken();
    db.run(
        `INSERT INTO trusted_devices
            (id, ip_address, label, status, device_purpose, device_token_hash)
         VALUES (4, '192.168.1.24', 'Issue Race', 'Authorized', 'tv', NULL)`,
    );
    db.run(
        `INSERT INTO trusted_devices
            (id, ip_address, label, status, device_purpose, device_token_hash)
         VALUES (5, '192.168.1.25', 'Revoke Race', 'Authorized', 'tv', ?)`,
        hashDeviceToken(token),
    );
    db.exec(`
        CREATE TRIGGER zero_issue BEFORE UPDATE ON trusted_devices
        WHEN OLD.id = 4
        BEGIN
            DELETE FROM trusted_devices WHERE id = OLD.id;
            SELECT RAISE(IGNORE);
        END;
        CREATE TRIGGER zero_revoke BEFORE UPDATE ON trusted_devices
        WHEN OLD.id = 5
        BEGIN
            DELETE FROM trusted_devices WHERE id = OLD.id;
            SELECT RAISE(IGNORE);
        END;
    `);

    assert.throws(() => issueDeviceTokenForDevice(db, 4), /changed|conflict|no longer exists/i);
    assert.throws(() => revokeDeviceToken(db, 5), /changed|conflict|no longer exists/i);
});
