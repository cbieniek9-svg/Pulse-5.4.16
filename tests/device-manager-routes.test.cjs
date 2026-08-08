'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

const { registerDeviceRoutes } = require('../src/routes/manager/devices.cjs');
const {
    createDeviceToken,
    findAuthorizedTrustedDevice,
    hashDeviceToken,
} = require('../src/lib/trusted-device-tokens.cjs');
const { logManagerAudit } = require('../src/lib/audit-log.cjs');

function makeHarness() {
    const sqlite = new Database(':memory:');
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
        CREATE TABLE manager_audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            actor_staff_id INTEGER,
            actor_name TEXT,
            action TEXT NOT NULL,
            target_type TEXT,
            target_id TEXT,
            summary TEXT,
            metadata_json TEXT,
            ip_address TEXT,
            user_agent TEXT,
            source_event_id TEXT NOT NULL DEFAULT ''
        );
        CREATE UNIQUE INDEX idx_manager_audit_source_event
            ON manager_audit_log(source_event_id)
            WHERE source_event_id != '';
    `);
    let failingDeviceWrite = null;
    let auditFailure = null;
    let beforeTransaction = null;
    const db = {
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run(sql, ...params) {
            if (failingDeviceWrite && failingDeviceWrite.test(sql)) {
                failingDeviceWrite = null;
                throw new Error('SQLITE_INTERNAL_SECRET_DETAIL');
            }
            return sqlite.prepare(sql).run(...params);
        },
        transaction(fn) {
            const transaction = sqlite.transaction(fn);
            return (...args) => {
                if (beforeTransaction) {
                    const callback = beforeTransaction;
                    beforeTransaction = null;
                    callback();
                }
                return transaction(...args);
            };
        },
    };
    const sessions = new Map([
        ['manager-session', { id: 7, name: 'MORGAN', role: 'Manager' }],
        ['staff-session', { id: 8, name: 'CASEY', role: 'Clerk' }],
    ]);
    const app = express();
    app.use(express.json());
    const fail = (res, status, message, code = null) => res.status(status).json({
        error: message,
        ...(code ? { code } : {}),
    });
    const requireSession = (req, res, needManager = false) => {
        const presented = req.headers['x-session-token'] || req.body?.token;
        const session = sessions.get(presented);
        if (!session) {
            fail(res, presented ? 401 : 403, presented ? 'Session expired.' : 'Manager session required.');
            return null;
        }
        if (needManager && session.role !== 'Manager') {
            fail(res, 403, 'Manager session required.');
            return null;
        }
        return session;
    };
    const wrap = (fn) => async (req, res) => {
        try {
            await fn(req, res);
        } catch (error) {
            if (!res.headersSent) fail(res, error.status || 500, error.message, error.code);
        }
    };
    const injectedAudit = (...args) => {
        if (auditFailure) {
            auditFailure.calls -= 1;
            if (auditFailure.calls === 0) {
                const mode = auditFailure.mode;
                auditFailure = null;
                if (mode === 'throw') throw new Error('AUDIT_INTERNAL_SECRET_DETAIL');
                return false;
            }
        }
        return logManagerAudit(...args);
    };
    registerDeviceRoutes(app, {
        wrap,
        fail,
        requireSession,
        db,
        broadcastUpdate() {},
        logManagerAudit: injectedAudit,
    });

    let server;
    async function post(path, body = {}, session = 'manager-session') {
        if (!server) {
            await new Promise((resolve) => {
                server = app.listen(0, '127.0.0.1', resolve);
            });
        }
        const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(session ? { 'x-session-token': session } : {}),
            },
            body: JSON.stringify(body),
        });
        return {
            status: response.status,
            body: await response.json(),
            headers: Object.fromEntries(response.headers.entries()),
        };
    }

    return {
        db,
        post,
        failNextDeviceWrite(pattern) {
            failingDeviceWrite = pattern;
        },
        failAudit(mode, calls = 1) {
            auditFailure = { mode, calls };
        },
        beforeNextTransaction(callback) {
            beforeTransaction = callback;
        },
        insertDevice(fields = {}) {
            const info = db.run(
                `INSERT INTO trusted_devices (
                    ip_address, label, status, device_purpose, device_token_hash
                ) VALUES (?, ?, ?, ?, ?)`,
                fields.ip_address ?? '10.0.0.25',
                fields.label ?? null,
                fields.status ?? 'Pending',
                fields.device_purpose ?? '',
                fields.device_token_hash ?? null,
            );
            return Number(info.lastInsertRowid);
        },
        authorize(token, purpose) {
            return findAuthorizedTrustedDevice(db, {
                headers: { 'x-device-token': token },
                ip: '10.0.0.50',
            }, purpose ? { requiredPurpose: purpose } : {});
        },
        async close() {
            if (server) await new Promise((resolve) => server.close(resolve));
            sqlite.close();
        },
    };
}

test('staff cannot mutate any manager device lifecycle endpoint', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const id = harness.insertDevice();
    const before = harness.db.all('SELECT * FROM trusted_devices');
    const attempts = [
        ['/api/devices/create', { label: 'Desk', purpose: 'cs_desk' }],
        ['/api/devices/authorize', { id, label: 'TV', purpose: 'tv' }],
        ['/api/devices/issue-token', { id, purpose: 'tv' }],
        ['/api/devices/rotate-token', { id, purpose: 'tv' }],
        ['/api/devices/repurpose', { id, purpose: 'markdown' }],
        ['/api/devices/revoke-token', { id }],
        ['/api/devices/delete', { id }],
    ];
    for (const [path, body] of attempts) {
        const result = await harness.post(path, body, 'staff-session');
        assert.equal(result.status, 403, path);
    }
    assert.deepEqual(harness.db.all('SELECT * FROM trusted_devices'), before);
});

test('device routes return stable validation and lookup errors', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const id = harness.insertDevice();

    const missingId = await harness.post('/api/devices/issue-token', {});
    assert.deepEqual(
        { status: missingId.status, code: missingId.body.code },
        { status: 400, code: 'DEVICE_ID_REQUIRED' },
    );
    const invalidPurpose = await harness.post('/api/devices/authorize', {
        id,
        label: 'Station',
        purpose: 'manager',
    });
    assert.deepEqual(
        { status: invalidPurpose.status, code: invalidPurpose.body.code },
        { status: 400, code: 'DEVICE_PURPOSE_INVALID' },
    );
    const missingLabel = await harness.post('/api/devices/create', { purpose: 'tv' });
    assert.deepEqual(
        { status: missingLabel.status, code: missingLabel.body.code },
        { status: 400, code: 'DEVICE_LABEL_REQUIRED' },
    );
    const missing = await harness.post('/api/devices/delete', { id: 9999 });
    assert.deepEqual(
        { status: missing.status, code: missing.body.code },
        { status: 404, code: 'DEVICE_NOT_FOUND' },
    );
});

test('device ids accept only positive integers and canonical digit strings', async (t) => {
    const invalidIds = [
        true, false, [], [1], {}, null, '', ' 1', '1 ', '01', '+1', '-1', '1.0', '1e0', 0, -1, 1.25,
    ];
    for (const id of invalidIds) {
        await t.test(`reject ${JSON.stringify(id)}`, async (tt) => {
            const harness = makeHarness();
            tt.after(() => harness.close());
            harness.insertDevice({
                label: 'Desk', status: 'Authorized', device_purpose: 'cs_desk',
            });
            const before = harness.db.all('SELECT * FROM trusted_devices');
            const result = await harness.post('/api/devices/issue-token', { id });
            assert.equal(result.status, 400);
            assert.equal(result.body.code, 'DEVICE_ID_REQUIRED');
            assert.deepEqual(harness.db.all('SELECT * FROM trusted_devices'), before);
            assert.deepEqual(harness.db.all('SELECT * FROM manager_audit_log'), []);
        });
    }
    for (const id of [1, '1']) {
        await t.test(`accept ${JSON.stringify(id)}`, async (tt) => {
            const harness = makeHarness();
            tt.after(() => harness.close());
            harness.insertDevice({
                label: 'Desk', status: 'Authorized', device_purpose: 'cs_desk',
            });
            const result = await harness.post('/api/devices/issue-token', { id });
            assert.equal(result.status, 200, JSON.stringify(result.body));
        });
    }
});

test('blank-purpose migrated devices stay unauthorized until explicit manager assignment', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const id = harness.insertDevice({ status: 'Authorized', device_purpose: '' });

    const denied = await harness.post('/api/devices/issue-token', { id });
    assert.equal(denied.status, 400);
    assert.equal(denied.body.code, 'DEVICE_PURPOSE_INVALID');
    assert.equal(harness.db.get('SELECT device_purpose FROM trusted_devices WHERE id=?', id).device_purpose, '');

    const wrongEndpoint = await harness.post('/api/devices/issue-token', { id, purpose: 'cs_desk' });
    assert.equal(wrongEndpoint.status, 400);
    assert.equal(wrongEndpoint.body.code, 'USE_REPURPOSE_ENDPOINT');
    const assigned = await harness.post('/api/devices/repurpose', { id, purpose: 'cs_desk' });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(assigned.body.device.device_purpose, 'cs_desk');
    assert.equal(harness.authorize(assigned.body.device_token, 'cs_desk').authorized, true);
});

test('issue and rotate reject every supplied purpose field without mutation', async (t) => {
    for (const path of ['/api/devices/issue-token', '/api/devices/rotate-token']) {
        for (const supplied of ['cs_desk', 'tv', '', null]) {
            await t.test(`${path} purpose=${String(supplied)}`, async (tt) => {
                const harness = makeHarness();
                tt.after(() => harness.close());
                const token = createDeviceToken();
                const id = harness.insertDevice({
                    label: 'Desk',
                    status: 'Authorized',
                    device_purpose: 'cs_desk',
                    device_token_hash: hashDeviceToken(token),
                });
                const beforeDevices = harness.db.all('SELECT * FROM trusted_devices ORDER BY id');
                const beforeAudits = harness.db.all('SELECT * FROM manager_audit_log ORDER BY id');
                const result = await harness.post(path, { id, purpose: supplied });
                assert.equal(result.status, 400);
                assert.equal(result.body.code, 'USE_REPURPOSE_ENDPOINT');
                assert.deepEqual(harness.db.all('SELECT * FROM trusted_devices ORDER BY id'), beforeDevices);
                assert.deepEqual(harness.db.all('SELECT * FROM manager_audit_log ORDER BY id'), beforeAudits);
                assert.equal(harness.authorize(token, 'cs_desk').authorized, true);
            });
        }
    }
});

test('manager creates a non-discovered device with label, purpose, and one-time token', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const created = await harness.post('/api/devices/create', {
        label: 'Customer service desk',
        purpose: 'cs_desk',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.match(created.body.device_token, /^tgpdt_/);
    assert.deepEqual(
        {
            ip: created.body.device.ip_address,
            label: created.body.device.label,
            purpose: created.body.device.device_purpose,
            paired: created.body.device.has_device_token,
        },
        {
            ip: null,
            label: 'Customer service desk',
            purpose: 'cs_desk',
            paired: true,
        },
    );
    const stored = harness.db.get('SELECT * FROM trusted_devices WHERE id=?', created.body.device.id);
    assert.equal(stored.ip_address, null);
    assert.equal(stored.device_token_hash, hashDeviceToken(created.body.device_token));
    assert.equal(JSON.stringify(created.body.device).includes('device_token_hash'), false);
});

test('authorizing a pending device requires label and purpose and atomically issues its token', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const id = harness.insertDevice({ label: null, status: 'Pending' });

    const missingLabel = await harness.post('/api/devices/authorize', { id, purpose: 'tv' });
    assert.equal(missingLabel.status, 400);
    assert.equal(missingLabel.body.code, 'DEVICE_LABEL_REQUIRED');

    const result = await harness.post('/api/devices/authorize', {
        id,
        label: 'Front TV',
        purpose: 'tv',
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.device.label, 'Front TV');
    assert.equal(result.body.device.device_purpose, 'tv');
    assert.equal(result.body.device.has_device_token, true);
    assert.equal(harness.authorize(result.body.device_token, 'tv').authorized, true);
});

test('pending devices cannot bypass label-required authorization through issue or repurpose', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const id = harness.insertDevice({ label: null, status: 'Pending' });
    for (const path of ['/api/devices/issue-token', '/api/devices/rotate-token']) {
        const result = await harness.post(path, { id });
        assert.equal(result.status, 409, path);
        assert.equal(result.body.code, 'DEVICE_NOT_AUTHORIZED', path);
    }
    const repurpose = await harness.post('/api/devices/repurpose', { id, purpose: 'tv' });
    assert.equal(repurpose.status, 409);
    assert.equal(repurpose.body.code, 'DEVICE_NOT_AUTHORIZED');
    assert.deepEqual(
        harness.db.get('SELECT label, status, device_purpose, device_token_hash FROM trusted_devices WHERE id=?', id),
        { label: null, status: 'Pending', device_purpose: '', device_token_hash: null },
    );
});

test('rotate preserves purpose and repurpose invalidates old capability atomically', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const created = await harness.post('/api/devices/create', {
        label: 'CS desk',
        purpose: 'cs_desk',
    });
    const first = created.body.device_token;
    const id = created.body.device.id;

    const rotated = await harness.post('/api/devices/rotate-token', { id });
    assert.equal(rotated.status, 200, JSON.stringify(rotated.body));
    assert.equal(rotated.body.device.device_purpose, 'cs_desk');
    assert.equal(harness.authorize(first).authorized, false);
    assert.equal(harness.authorize(rotated.body.device_token, 'cs_desk').authorized, true);

    const repurposed = await harness.post('/api/devices/repurpose', { id, purpose: 'markdown' });
    assert.equal(repurposed.status, 200, JSON.stringify(repurposed.body));
    assert.equal(repurposed.body.device.device_purpose, 'markdown');
    assert.equal(harness.authorize(rotated.body.device_token).authorized, false);
    assert.equal(harness.authorize(repurposed.body.device_token, 'markdown').authorized, true);
    assert.equal(harness.authorize(repurposed.body.device_token, 'cs_desk').authorized, false);
});

test('no-op repurpose is rejected without token or audit mutation', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const token = createDeviceToken();
    const id = harness.insertDevice({
        label: 'Desk',
        status: 'Authorized',
        device_purpose: 'cs_desk',
        device_token_hash: hashDeviceToken(token),
    });
    const before = harness.db.all('SELECT * FROM trusted_devices');
    const result = await harness.post('/api/devices/repurpose', { id, purpose: 'CS_DESK' });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'DEVICE_PURPOSE_UNCHANGED');
    assert.equal(result.body.device_token, undefined);
    assert.deepEqual(harness.db.all('SELECT * FROM trusted_devices'), before);
    assert.deepEqual(harness.db.all('SELECT * FROM manager_audit_log'), []);
});

test('revoke and delete stop token authorization and return not-found consistently', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const created = await harness.post('/api/devices/create', { label: 'TV', purpose: 'tv' });
    const { device_token: token, device } = created.body;

    const revoked = await harness.post('/api/devices/revoke-token', { id: device.id });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.already_revoked, false);
    assert.equal(revoked.body.device.has_device_token, false);
    assert.equal(harness.authorize(token).authorized, false);

    const auditCount = harness.db.get('SELECT COUNT(*) AS c FROM manager_audit_log').c;
    const repeated = await harness.post('/api/devices/revoke-token', { id: device.id });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.already_revoked, true);
    assert.equal(repeated.body.device.has_device_token, false);
    assert.equal(harness.db.get('SELECT COUNT(*) AS c FROM manager_audit_log').c, auditCount);

    const deleted = await harness.post('/api/devices/delete', { id: device.id });
    assert.equal(deleted.status, 200);
    assert.equal(harness.db.get('SELECT * FROM trusted_devices WHERE id=?', device.id), undefined);
    const deletedAgain = await harness.post('/api/devices/delete', { id: device.id });
    assert.equal(deletedAgain.status, 404);
    assert.equal(deletedAgain.body.code, 'DEVICE_NOT_FOUND');
});

test('tokenless revoke revalidates its snapshot inside the transaction', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const id = harness.insertDevice({
        label: 'Initially tokenless',
        status: 'Authorized',
        device_purpose: 'cs_desk',
        device_token_hash: null,
    });
    const concurrentHash = hashDeviceToken(createDeviceToken());
    let concurrentState;
    harness.beforeNextTransaction(() => {
        harness.db.run(
            `UPDATE trusted_devices
                SET device_purpose='markdown', device_token_hash=?, token_created_at='2026-08-04T12:00:00.000Z'
              WHERE id=?`,
            concurrentHash,
            id,
        );
        concurrentState = harness.db.get('SELECT * FROM trusted_devices WHERE id=?', id);
    });

    const result = await harness.post('/api/devices/revoke-token', { id });

    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'DEVICE_CHANGED_RETRY');
    assert.equal(result.body.already_revoked, undefined);
    assert.deepEqual(harness.db.get('SELECT * FROM trusted_devices WHERE id=?', id), concurrentState);
    assert.equal(harness.db.get('SELECT * FROM trusted_devices WHERE id=?', id).device_token_hash, concurrentHash);
    assert.deepEqual(harness.db.all('SELECT * FROM manager_audit_log'), []);
});

test('one-time token responses disable HTTP caching', async (t) => {
    const cases = [
        ['/api/devices/create', { label: 'Desk', purpose: 'cs_desk' }],
        ['/api/devices/authorize', null],
        ['/api/devices/issue-token', null],
        ['/api/devices/rotate-token', null],
        ['/api/devices/repurpose', null],
    ];
    for (const [path, initialBody] of cases) {
        await t.test(path, async (tt) => {
            const harness = makeHarness();
            tt.after(() => harness.close());
            let body = initialBody;
            if (path === '/api/devices/authorize') {
                const id = harness.insertDevice({ label: null, status: 'Pending' });
                body = { id, label: 'TV', purpose: 'tv' };
            } else if (path !== '/api/devices/create') {
                const id = harness.insertDevice({
                    label: 'Desk',
                    status: 'Authorized',
                    device_purpose: 'cs_desk',
                    device_token_hash: path.includes('issue-token') ? null : hashDeviceToken(createDeviceToken()),
                });
                body = path === '/api/devices/repurpose' ? { id, purpose: 'markdown' } : { id };
            }
            const result = await harness.post(path, body);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.match(result.headers['cache-control'] || '', /\bno-store\b/);
            assert.match(result.headers['cache-control'] || '', /\bprivate\b/);
            assert.equal(result.headers.pragma, 'no-cache');
        });
    }
});

test('concurrent device lifecycle changes return retry without audit or token', async (t) => {
    const cases = [
        {
            name: 'authorize',
            path: '/api/devices/authorize',
            setup: (h) => h.insertDevice({ label: null, status: 'Pending' }),
            body: (id) => ({ id, label: 'TV', purpose: 'tv' }),
        },
        {
            name: 'issue',
            path: '/api/devices/issue-token',
            setup: (h) => h.insertDevice({
                label: 'Desk', status: 'Authorized', device_purpose: 'cs_desk',
            }),
            body: (id) => ({ id }),
        },
        {
            name: 'rotate',
            path: '/api/devices/rotate-token',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id }),
        },
        {
            name: 'repurpose',
            path: '/api/devices/repurpose',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id, purpose: 'markdown' }),
        },
        {
            name: 'revoke',
            path: '/api/devices/revoke-token',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id }),
        },
        {
            name: 'delete',
            path: '/api/devices/delete',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id }),
        },
    ];
    for (const item of cases) {
        await t.test(item.name, async (tt) => {
            const harness = makeHarness();
            tt.after(() => harness.close());
            const id = item.setup(harness);
            let concurrentState;
            harness.beforeNextTransaction(() => {
                harness.db.run(
                    `UPDATE trusted_devices
                        SET status='Authorized', label='Concurrent manager',
                            device_purpose='tv', device_token_hash=?
                      WHERE id=?`,
                    hashDeviceToken(createDeviceToken()),
                    id,
                );
                concurrentState = harness.db.get('SELECT * FROM trusted_devices WHERE id=?', id);
            });
            const result = await harness.post(item.path, item.body(id));
            assert.equal(result.status, 409);
            assert.equal(result.body.code, 'DEVICE_CHANGED_RETRY');
            assert.equal(result.body.device_token, undefined);
            assert.deepEqual(harness.db.get('SELECT * FROM trusted_devices WHERE id=?', id), concurrentState);
            assert.deepEqual(harness.db.all('SELECT * FROM manager_audit_log'), []);
        });
    }
});

test('device lifecycle audits actor, identity, purpose transition, and outcome without secrets', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    const created = await harness.post('/api/devices/create', {
        label: 'Station Alpha',
        purpose: 'cs_desk',
    });
    const secrets = [created.body.device_token];
    const id = created.body.device.id;
    const rotated = await harness.post('/api/devices/issue-token', { id });
    secrets.push(rotated.body.device_token);
    const repurposed = await harness.post('/api/devices/repurpose', { id, purpose: 'markdown' });
    secrets.push(repurposed.body.device_token);
    await harness.post('/api/devices/revoke-token', { id });
    await harness.post('/api/devices/delete', { id });

    const audits = harness.db.all('SELECT * FROM manager_audit_log ORDER BY id');
    const actions = audits.map((row) => row.action);
    for (const required of [
        'trusted_device_created',
        'trusted_device_token_issued',
        'trusted_device_purpose_changed',
        'trusted_device_token_rotated',
        'trusted_device_token_revoked',
        'trusted_device_deleted',
    ]) {
        assert.ok(actions.includes(required), required);
    }
    for (const row of audits) {
        assert.equal(row.actor_name, 'MORGAN');
        assert.equal(row.target_id, String(id));
        const metadata = JSON.parse(row.metadata_json);
        assert.equal(metadata.device_id, id);
        assert.equal(metadata.label, 'Station Alpha');
        assert.equal(metadata.outcome, 'success');
    }
    const serialized = JSON.stringify(audits);
    for (const token of secrets) {
        assert.equal(serialized.includes(token), false);
        assert.equal(serialized.includes(hashDeviceToken(token)), false);
    }
});

test('device routes do not expose database internals', async (t) => {
    const harness = makeHarness();
    t.after(() => harness.close());
    harness.failNextDeviceWrite(/INSERT INTO trusted_devices/);
    const failedCreate = await harness.post('/api/devices/create', {
        label: 'Desk',
        purpose: 'cs_desk',
    });
    assert.equal(failedCreate.status, 500);
    assert.equal(failedCreate.body.code, 'DEVICE_OPERATION_FAILED');
    assert.doesNotMatch(JSON.stringify(failedCreate.body), /SQLITE|SECRET|INSERT/i);

    const id = harness.insertDevice();
    harness.failNextDeviceWrite(/DELETE FROM trusted_devices/);
    const failedDelete = await harness.post('/api/devices/delete', { id });
    assert.equal(failedDelete.status, 500);
    assert.equal(failedDelete.body.code, 'DEVICE_OPERATION_FAILED');
    assert.doesNotMatch(JSON.stringify(failedDelete.body), /SQLITE|SECRET|DELETE/i);
});

test('audit false or throw rolls back every device lifecycle mutation', async (t) => {
    const cases = [
        {
            name: 'create',
            path: '/api/devices/create',
            body: { label: 'Desk', purpose: 'cs_desk' },
            auditCall: 2,
        },
        {
            name: 'authorize',
            path: '/api/devices/authorize',
            setup: (h) => h.insertDevice({ label: null, status: 'Pending' }),
            body: (id) => ({ id, label: 'Front TV', purpose: 'tv' }),
            auditCall: 2,
        },
        {
            name: 'issue',
            path: '/api/devices/issue-token',
            setup: (h) => h.insertDevice({
                label: 'Desk', status: 'Authorized', device_purpose: 'cs_desk',
            }),
            body: (id) => ({ id }),
        },
        {
            name: 'rotate',
            path: '/api/devices/rotate-token',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id }),
        },
        {
            name: 'repurpose',
            path: '/api/devices/repurpose',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id, purpose: 'markdown' }),
            auditCall: 2,
        },
        {
            name: 'revoke',
            path: '/api/devices/revoke-token',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id }),
        },
        {
            name: 'delete',
            path: '/api/devices/delete',
            setup: (h) => h.insertDevice({
                label: 'Desk',
                status: 'Authorized',
                device_purpose: 'cs_desk',
                device_token_hash: hashDeviceToken(createDeviceToken()),
            }),
            body: (id) => ({ id }),
        },
    ];

    for (const mode of ['false', 'throw']) {
        for (const item of cases) {
            await t.test(`${item.name} audit ${mode}`, async (tt) => {
                const harness = makeHarness();
                tt.after(() => harness.close());
                const id = item.setup ? item.setup(harness) : undefined;
                const beforeDevices = harness.db.all('SELECT * FROM trusted_devices ORDER BY id');
                const beforeAudits = harness.db.all('SELECT * FROM manager_audit_log ORDER BY id');
                harness.failAudit(mode, item.auditCall || 1);

                const result = await harness.post(
                    item.path,
                    typeof item.body === 'function' ? item.body(id) : item.body,
                );

                assert.equal(result.status, 500);
                assert.equal(result.body.code, 'DEVICE_AUDIT_FAILED');
                assert.equal(result.body.device_token, undefined);
                assert.doesNotMatch(JSON.stringify(result.body), /AUDIT_INTERNAL|SECRET|SQLITE/i);
                assert.deepEqual(harness.db.all('SELECT * FROM trusted_devices ORDER BY id'), beforeDevices);
                assert.deepEqual(harness.db.all('SELECT * FROM manager_audit_log ORDER BY id'), beforeAudits);
            });
        }
    }
});
