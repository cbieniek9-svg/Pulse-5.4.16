'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');
const express = require('express');

const {
    DEVICE_PURPOSES,
    normalizeDevicePurpose,
    canDevicePerform,
} = require('../src/lib/device-access-policy.cjs');
const { registerActionRoutes } = require('../src/routes/action.cjs');
const {
    createDeviceToken,
    hashDeviceToken,
} = require('../src/lib/trusted-device-tokens.cjs');

const ALLOWED = [
    ['cs_desk', 'special_orders', 'insert'],
    ['cs_desk', 'special_orders', 'update'],
    ['receiving', 'expected_orders', 'receiving_mark_arrived'],
    ['receiving', 'expected_orders', 'receiving_mark_departed'],
    ['receiving', 'expected_orders', 'receiving_log_arrival'],
    ['markdown', 'kill_dates', 'insert'],
];

test('device purposes normalize case and whitespace and reject blank or unknown values', () => {
    assert.deepEqual([...DEVICE_PURPOSES], ['tv', 'cs_desk', 'receiving', 'markdown']);
    assert.equal(normalizeDevicePurpose(' TV '), 'tv');
    assert.equal(normalizeDevicePurpose('Cs_DeSk'), 'cs_desk');
    assert.equal(normalizeDevicePurpose(' RECEIVING '), 'receiving');
    assert.equal(normalizeDevicePurpose('Markdown'), 'markdown');
    assert.equal(normalizeDevicePurpose(''), '');
    assert.equal(normalizeDevicePurpose('   '), '');
    assert.equal(normalizeDevicePurpose('manager'), '');
    assert.equal(normalizeDevicePurpose(null), '');
});

test('fixed station capability matrix allows every exact tuple and denies cross-purpose borrowing', () => {
    for (const purpose of DEVICE_PURPOSES) {
        for (const [owner, table, action] of ALLOWED) {
            assert.equal(
                canDevicePerform(purpose, table, action),
                purpose === owner,
                `${purpose} ${table}.${action}`,
            );
        }
    }
});

test('capability checks normalize purpose but require exact table and action semantics', () => {
    assert.equal(canDevicePerform(' CS_DESK ', 'special_orders', 'insert'), true);
    assert.equal(canDevicePerform('RECEIVING', 'expected_orders', 'receiving_mark_arrived'), true);
    assert.equal(canDevicePerform('MARKDOWN', 'kill_dates', 'insert'), true);

    assert.equal(canDevicePerform('receiving', '', 'receiving_mark_arrived'), false);
    assert.equal(canDevicePerform('receiving', 'special_orders', 'receiving_mark_arrived'), false);
    assert.equal(canDevicePerform('receiving', 'expected_orders', 'insert'), false);
    assert.equal(canDevicePerform('markdown', 'kill_dates', 'update'), false);
    assert.equal(canDevicePerform('cs_desk', 'special_orders', 'delete'), false);
    assert.equal(canDevicePerform('cs_desk', ' special_orders ', 'insert'), false);
    assert.equal(canDevicePerform('cs_desk', 'special_orders', ' INSERT '), false);
});

test('tv and invalid purposes receive no station-write capability', () => {
    for (const [, table, action] of ALLOWED) {
        assert.equal(canDevicePerform('tv', table, action), false);
        assert.equal(canDevicePerform('', table, action), false);
        assert.equal(canDevicePerform('unknown', table, action), false);
    }
    assert.equal(canDevicePerform('tv', '', 'tv_page'), false);
    assert.equal(canDevicePerform('tv', '', 'tv_sync'), false);
    assert.equal(canDevicePerform('tv', '', 'tv_stream'), false);
});

const STATIONS = [
    {
        key: 'cs-insert',
        purpose: 'cs_desk',
        actor: 'CS_DESK',
        table: 'special_orders',
        action: 'insert',
        body: {
            data: {
                order_id: 'ORDER-1',
                customer: 'ALICE',
                item: '1X ITEM',
                status: 'Open',
                logged_by: 'CLIENT_CHOSEN',
            },
        },
        assertMutation(state, actor) {
            const row = state.special_orders.find((item) => item.order_id === 'ORDER-1');
            assert.ok(row);
            assert.deepEqual(
                { customer: row.customer, item: row.item, status: row.status, logged_by: row.logged_by },
                { customer: 'ALICE', item: '1X ITEM', status: 'Open', logged_by: actor },
            );
            assert.match(row.time_logged, /^\d{4}-\d{2}-\d{2}T/);
        },
    },
    {
        key: 'cs-update',
        purpose: 'cs_desk',
        actor: 'CS_DESK',
        table: 'special_orders',
        action: 'update',
        body: {
            data: { status: 'Closed' },
            id_col: 'order_id',
            id_val: 'ORDER-UPDATE',
        },
        assertMutation(state, actor) {
            const row = state.special_orders.find((item) => item.order_id === 'ORDER-UPDATE');
            assert.deepEqual(
                { customer: row.customer, status: row.status, closed_by: row.closed_by },
                { customer: 'BEFORE UPDATE', status: 'Closed', closed_by: actor },
            );
            assert.match(row.time_closed, /^\d{4}-\d{2}-\d{2}T/);
        },
    },
    {
        key: 'receiving-arrived',
        purpose: 'receiving',
        actor: 'RECEIVING_STATION',
        table: 'expected_orders',
        action: 'receiving_mark_arrived',
        body: {
            data: {},
            id_col: 'exp_id',
            id_val: 'EXP-ARRIVE',
        },
        assertMutation(state, actor) {
            const row = state.expected_orders.find((item) => item.exp_id === 'EXP-ARRIVE');
            assert.deepEqual(
                { vendor: row.vendor, status: row.status, arrived: row.arrived, arrived_by: row.arrived_by },
                { vendor: 'ARRIVAL VENDOR', status: 'Arrived', arrived: 1, arrived_by: actor },
            );
            assert.match(row.arrived_at, /^\d{4}-\d{2}-\d{2}T/);
        },
    },
    {
        key: 'receiving-departed',
        purpose: 'receiving',
        actor: 'RECEIVING_STATION',
        table: 'expected_orders',
        action: 'receiving_mark_departed',
        body: {
            data: { invoice_ref: 'INV-42' },
            id_col: 'exp_id',
            id_val: 'EXP-DEPART',
        },
        assertMutation(state, actor) {
            const row = state.expected_orders.find((item) => item.exp_id === 'EXP-DEPART');
            assert.deepEqual(
                {
                    vendor: row.vendor,
                    status: row.status,
                    arrived: row.arrived,
                    departed_by: row.departed_by,
                    closed_by: row.closed_by,
                    invoice_ref: row.invoice_ref,
                },
                {
                    vendor: 'DEPARTURE VENDOR',
                    status: 'Closed',
                    arrived: 1,
                    departed_by: actor,
                    closed_by: actor,
                    invoice_ref: 'INV-42',
                },
            );
            assert.match(row.departed_at, /^\d{4}-\d{2}-\d{2}T/);
            assert.equal(row.time_closed, row.departed_at);
        },
    },
    {
        key: 'receiving-log-arrival',
        purpose: 'receiving',
        actor: 'RECEIVING_STATION',
        table: 'expected_orders',
        action: 'receiving_log_arrival',
        body: {
            data: { vendor: 'UNSCHEDULED VENDOR', expected_day: 'Tuesday' },
        },
        assertMutation(state, actor) {
            const row = state.expected_orders.find((item) => item.exp_id === 'EXP-LOGGED');
            assert.deepEqual(
                {
                    vendor: row.vendor,
                    expected_day: row.expected_day,
                    status: row.status,
                    arrived: row.arrived,
                    logged_by: row.logged_by,
                    arrived_by: row.arrived_by,
                },
                {
                    vendor: 'UNSCHEDULED VENDOR',
                    expected_day: 'Tuesday',
                    status: 'Arrived',
                    arrived: 1,
                    logged_by: actor,
                    arrived_by: actor,
                },
            );
            assert.match(row.arrived_at, /^\d{4}-\d{2}-\d{2}T/);
        },
    },
    {
        key: 'markdown-insert',
        purpose: 'markdown',
        actor: 'MARKDOWN_STATION',
        table: 'kill_dates',
        action: 'insert',
        body: {
            data: {
                id: 'KILL-1',
                item: 'MILK',
                kill_date: '2026-08-10',
                status: 'Active',
                logged_by: 'CLIENT_CHOSEN',
            },
        },
        assertMutation(state, actor) {
            const row = state.kill_dates.find((item) => item.id === 'KILL-1');
            assert.deepEqual(
                { item: row.item, kill_date: row.kill_date, status: row.status, logged_by: row.logged_by },
                { item: 'MILK', kill_date: '2026-08-10', status: 'Active', logged_by: actor },
            );
        },
    },
];

function makeRouteHarness() {
    const state = {
        special_orders: [{
            order_id: 'ORDER-UPDATE',
            customer: 'BEFORE UPDATE',
            item: 'ORIGINAL ITEM',
            status: 'Open',
            closed_by: '',
        }],
        expected_orders: [
            {
                exp_id: 'EXP-ARRIVE',
                vendor: 'ARRIVAL VENDOR',
                status: 'Pending',
                arrived: 0,
                arrived_by: '',
            },
            {
                exp_id: 'EXP-DEPART',
                vendor: 'DEPARTURE VENDOR',
                status: 'Arrived',
                arrived: 1,
                arrived_at: '2026-08-04T10:00:00.000Z',
                departed_at: null,
                departed_by: '',
                closed_by: '',
            },
        ],
        kill_dates: [],
        audits: [],
    };
    const devices = [];
    const sessions = new Map();
    let beforeTransaction = null;

    const snapshot = () => JSON.parse(JSON.stringify({ state, devices }));
    const restore = (saved) => {
        for (const key of Object.keys(state)) state[key] = saved.state[key];
        devices.splice(0, devices.length, ...saved.devices);
    };

    const db = {
        get(sql, ...params) {
            if (sql.includes('FROM trusted_devices') && sql.includes('device_token_hash=?')) {
                if (sql.includes('WHERE id=?')) {
                    const [id, tokenHash] = params;
                    const row = devices.find((device) => (
                        device.id === Number(id)
                        && device.device_token_hash === tokenHash
                        && device.status === 'Authorized'
                    ));
                    return row ? { ...row, has_device_token: 1 } : null;
                }
                const [tokenHash] = params;
                const row = devices.find((device) => (
                    device.device_token_hash === tokenHash && device.status === 'Authorized'
                ));
                return row ? { ...row, has_device_token: 1 } : null;
            }
            if (sql.includes('FROM special_orders')) {
                return state.special_orders.find((row) => row.order_id === params[0]) || null;
            }
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE trusted_devices SET last_seen=')) {
                const device = devices.find((row) => row.id === Number(params[2]));
                if (device) {
                    device.last_seen = params[0];
                    device.last_seen_at = params[1];
                }
                return { changes: device ? 1 : 0 };
            }
            if (sql.includes('UPDATE trusted_devices SET ip_address=')) return { changes: 1 };
            return { changes: 0 };
        },
        transaction(fn) {
            return (...args) => {
                if (beforeTransaction) {
                    const change = beforeTransaction;
                    beforeTransaction = null;
                    change();
                }
                const saved = snapshot();
                try {
                    return fn(...args);
                } catch (error) {
                    restore(saved);
                    throw error;
                }
            };
        },
        upsertAudit(id, timestamp, actor, action, table, detail) {
            state.audits.push({ id, timestamp, actor, action, table, detail });
        },
    };

    const actionHandlers = {
        special_orders_insert({ workingData }) {
            state.special_orders.push({ ...workingData });
        },
        special_orders_update({ workingData, id_val }) {
            const row = state.special_orders.find((item) => item.order_id === id_val);
            Object.assign(row, workingData);
        },
        expected_orders_receiving_mark_arrived({ id_val, actorName, serverTime }) {
            const row = state.expected_orders.find((item) => item.exp_id === id_val);
            row.status = 'Arrived';
            row.arrived = 1;
            row.arrived_at = serverTime;
            row.arrived_by = actorName;
        },
        expected_orders_receiving_mark_departed({
            id_val, workingData, actorName, serverTime,
        }) {
            const row = state.expected_orders.find((item) => item.exp_id === id_val);
            row.status = 'Closed';
            row.departed_at = serverTime;
            row.departed_by = actorName;
            row.time_closed = serverTime;
            row.closed_by = actorName;
            row.invoice_ref = workingData.invoice_ref;
        },
        expected_orders_receiving_log_arrival({ workingData, actorName, serverTime }) {
            state.expected_orders.push({
                exp_id: 'EXP-LOGGED',
                vendor: workingData.vendor,
                expected_day: workingData.expected_day,
                status: 'Arrived',
                arrived: 1,
                arrived_at: serverTime,
                logged_by: actorName,
                arrived_by: actorName,
            });
        },
        kill_dates_insert({ workingData }) {
            state.kill_dates.push({ ...workingData });
        },
    };

    const auth = {
        getSession(token) {
            return sessions.get(token) || null;
        },
        async resolveActionActor({ token }) {
            return sessions.get(token)?.name || null;
        },
        destroySessionsForStaff() {},
    };

    const app = express();
    app.use(express.json());
    const fail = (res, status, message, code = null) => res.status(status).json({
        error: message,
        ...(code ? { code } : {}),
    });
    const wrap = (fn) => async (req, res) => {
        try {
            await fn(req, res);
        } catch (error) {
            if (!res.headersSent) fail(res, error.status || 500, error.message, error.code);
        }
    };
    registerActionRoutes(app, {
        wrap,
        fail,
        db,
        auth,
        actionHandlers,
        checkSettingPermission: async () => true,
    });

    let server;
    return {
        state,
        devices,
        sessions,
        db,
        setBeforeTransaction(fn) {
            beforeTransaction = fn;
        },
        addDevice(purpose, status = 'Authorized') {
            const token = createDeviceToken();
            devices.push({
                id: devices.length + 1,
                label: `${purpose} fixture`,
                ip_address: '127.0.0.1',
                status,
                device_purpose: purpose,
                device_token_hash: hashDeviceToken(token),
            });
            return token;
        },
        async post(payload, headers = {}) {
            if (!server) {
                await new Promise((resolve) => {
                    server = app.listen(0, '127.0.0.1', resolve);
                });
            }
            const address = server.address();
            const response = await fetch(`http://127.0.0.1:${address.port}/api/action`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify(payload),
            });
            return { status: response.status, body: await response.json() };
        },
        async close() {
            if (server) await new Promise((resolve) => server.close(resolve));
        },
    };
}

function payloadFor(station, userContext) {
    return {
        table: station.table,
        action: station.action,
        ...station.body,
        ...(userContext ? { userContext } : {}),
    };
}

test('all bare station names are denied with no business mutation', async (t) => {
    for (const station of STATIONS) {
        await t.test(station.key, async (tt) => {
            const harness = makeRouteHarness();
            tt.after(() => harness.close());
            const before = JSON.stringify(harness.state);
            const result = await harness.post(payloadFor(station, { name: station.actor, pin: '' }));
            assert.equal(result.status, 401);
            assert.equal(result.body.code, 'STATION_DEVICE_AUTH_REQUIRED');
            assert.equal(JSON.stringify(harness.state), before);
        });
    }
});

test('correct-purpose tokens perform each exact station mutation with server-derived actors', async (t) => {
    for (const station of STATIONS) {
        await t.test(station.key, async (tt) => {
            const harness = makeRouteHarness();
            tt.after(() => harness.close());
            const deviceToken = harness.addDevice(station.purpose);
            const result = await harness.post(
                payloadFor(station, { name: 'CLIENT_CHOSEN', pin: '' }),
                { 'x-device-token': deviceToken },
            );
            assert.equal(result.status, 200, JSON.stringify(result.body));
            station.assertMutation(harness.state, station.actor);
            assert.equal(harness.state.audits.at(-1).actor, station.actor);
            assert.doesNotMatch(JSON.stringify(harness.state.audits), new RegExp(deviceToken));
            assert.doesNotMatch(JSON.stringify(harness.state.audits), new RegExp(hashDeviceToken(deviceToken)));
        });
    }
});

test('wrong-purpose and revoked tokens deny every station mutation', async (t) => {
    for (const station of STATIONS) {
        await t.test(station.key, async (tt) => {
            const wrong = makeRouteHarness();
            tt.after(() => wrong.close());
            const wrongToken = wrong.addDevice(station.purpose === 'markdown' ? 'receiving' : 'markdown');
            const wrongBefore = JSON.stringify(wrong.state);
            const forbidden = await wrong.post(payloadFor(station), { 'x-device-token': wrongToken });
            assert.equal(forbidden.status, 403);
            assert.equal(forbidden.body.code, 'DEVICE_CAPABILITY_FORBIDDEN');
            assert.equal(JSON.stringify(wrong.state), wrongBefore);

            const revoked = makeRouteHarness();
            tt.after(() => revoked.close());
            const revokedToken = revoked.addDevice(station.purpose, 'Revoked');
            const revokedBefore = JSON.stringify(revoked.state);
            const invalid = await revoked.post(payloadFor(station), { 'x-device-token': revokedToken });
            assert.equal(invalid.status, 401);
            assert.equal(invalid.body.code, 'INVALID_DEVICE_TOKEN');
            assert.equal(JSON.stringify(revoked.state), revokedBefore);
        });
    }
});

test('malformed presented device token is invalid rather than missing', async (t) => {
    const harness = makeRouteHarness();
    t.after(() => harness.close());
    const before = JSON.stringify(harness.state);
    const result = await harness.post(payloadFor(STATIONS[0]), { 'x-device-token': 'not-a-token' });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'INVALID_DEVICE_TOKEN');
    assert.equal(JSON.stringify(harness.state), before);
});

for (const race of ['rotation', 'revocation']) {
    test(`transaction-time ${race} denies CS and receiving mutations`, async (t) => {
        for (const station of [
            STATIONS.find((item) => item.key === 'cs-insert'),
            STATIONS.find((item) => item.key === 'receiving-departed'),
        ]) {
            await t.test(station.key, async (tt) => {
                const harness = makeRouteHarness();
                tt.after(() => harness.close());
                const before = JSON.stringify(harness.state);
                const token = harness.addDevice(station.purpose);
                harness.setBeforeTransaction(() => {
                    const device = harness.devices[0];
                    if (race === 'rotation') device.device_token_hash = hashDeviceToken(createDeviceToken());
                    else device.status = 'Revoked';
                });
                const result = await harness.post(payloadFor(station), { 'x-device-token': token });
                assert.equal(result.status, 401);
                assert.equal(result.body.code, 'INVALID_DEVICE_TOKEN');
                assert.equal(JSON.stringify(harness.state), before);
                assert.equal(harness.state.audits.length, 0);
            });
        }
    });
}

test('receiving action text on an arbitrary table is rejected before mutation', async (t) => {
    const harness = makeRouteHarness();
    t.after(() => harness.close());
    const before = JSON.stringify(harness.state);
    const token = harness.addDevice('receiving');
    const result = await harness.post({
        table: 'special_orders',
        action: 'receiving_mark_arrived',
        data: {},
    }, { 'x-device-token': token });
    assert.equal(result.status, 400);
    assert.equal(JSON.stringify(harness.state), before);
});

test('live receiving staff sessions preserve receiving and markdown station workflows', async (t) => {
    const stationWorkflows = STATIONS.filter(
        (station) => station.purpose === 'receiving' || station.purpose === 'markdown',
    );
    for (const station of stationWorkflows) {
        await t.test(station.key, async (tt) => {
            const harness = makeRouteHarness();
            tt.after(() => harness.close());
            harness.sessions.set('live-session', {
                name: 'ASHLEY',
                role: 'Clerk',
                permissions: 'receiving',
            });
            const allowed = await harness.post(
                payloadFor(station),
                { 'x-session-token': 'live-session' },
            );
            assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
            station.assertMutation(harness.state, 'ASHLEY');
            assert.equal(harness.state.audits.at(-1).actor, 'ASHLEY');
        });
    }
});

test('expired staff sessions on station tuples remain generic 401', async (t) => {
    const harness = makeRouteHarness();
    t.after(() => harness.close());
    const before = JSON.stringify(harness.state);
    const station = STATIONS.find((item) => item.key === 'cs-insert');
    const expired = await harness.post(payloadFor({
        ...station,
        body: { data: { ...station.body.data, order_id: 'ORDER-EXPIRED' } },
    }), { 'x-session-token': 'expired-session' });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.code, undefined);
    assert.equal(JSON.stringify(harness.state), before);
});

test('CS client imports only fragment pairing tokens and strips them before requests or history', async (t) => {
    const modulePath = path.join(__dirname, '../client/src/cs/csApi.js');
    const source = fs.readFileSync(modulePath, 'utf8');
    assert.match(source, /tgp\.cs\.deviceToken/);
    assert.match(source, /url\.hash/);
    assert.match(source, /hashParams\.get\(['"]deviceToken['"]\)/);
    assert.match(source, /history\.replaceState/);
    assert.match(source, /hashParams\.delete\(['"]deviceToken['"]\)/);
    assert.doesNotMatch(source, /url\.searchParams\.get\(['"]deviceToken['"]\)/);
    assert.match(source, /['"]x-device-token['"]/);
    assert.match(source, /pairing required/i);
    assert.doesNotMatch(source, /CS_DESK_CTX|userContext:\s*\{\s*name:\s*['"]CS_DESK/);

    const originalWindow = global.window;
    const originalSessionStorage = global.sessionStorage;
    const originalFetch = global.fetch;
    t.after(() => {
        global.window = originalWindow;
        global.sessionStorage = originalSessionStorage;
        global.fetch = originalFetch;
    });

    async function importAt(href) {
        const stored = new Map();
        const historyUrls = [];
        const requestUrls = [];
        global.window = {
            location: { href },
            localStorage: {
                getItem: (key) => stored.get(key) || null,
                setItem: (key, value) => stored.set(key, value),
            },
            history: {
                state: null,
                replaceState: (_state, _title, url) => historyUrls.push(url),
            },
        };
        global.sessionStorage = {
            getItem: () => null,
            setItem() {},
            removeItem() {},
        };
        global.fetch = async (url) => {
            requestUrls.push(String(url));
            throw new Error('unexpected request');
        };
        await import(`${pathToFileURL(modulePath).href}?case=${Math.random()}`);
        return { stored, historyUrls, requestUrls };
    }

    const legacyQuery = await importAt('http://store.local/cs?deviceToken=QUERY-SECRET');
    assert.equal(legacyQuery.stored.has('tgp.cs.deviceToken'), false);
    assert.deepEqual(legacyQuery.historyUrls, []);
    assert.deepEqual(legacyQuery.requestUrls, []);

    const fragment = await importAt(
        'http://store.local/cs?safe=1#deviceToken=FRAGMENT-SECRET&view=legacy',
    );
    assert.equal(fragment.stored.get('tgp.cs.deviceToken'), 'FRAGMENT-SECRET');
    assert.deepEqual(fragment.historyUrls, ['/cs?safe=1#view=legacy']);
    assert.equal(fragment.historyUrls.some((url) => url.includes('FRAGMENT-SECRET')), false);
    assert.deepEqual(fragment.requestUrls, []);
});

test('CS API fixtures persist and send a cs_desk device token instead of a bare actor', () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
    const apiTest = read('betacs-portal-api.test.cjs');
    const seed = read('playwright-seed.cjs');
    const apiClient = read('helpers/api-client.cjs');
    const simUsers = read('helpers/sim-users.cjs');
    const browserFixture = read('betacs-portal.spec.js');

    assert.match(seed, /issueDeviceTokenForDevice/);
    assert.match(seed, /purpose:\s*['"]cs_desk['"]/);
    assert.match(apiTest, /['"]x-device-token['"]/);
    assert.match(apiClient, /['"]x-device-token['"]/);
    assert.match(simUsers, /deviceToken/);
    assert.match(browserFixture, /['"]x-device-token['"]/);
    assert.match(browserFixture, /#deviceToken=/);
    assert.doesNotMatch(browserFixture, /\?deviceToken=/);
    for (const source of [apiTest, apiClient, simUsers]) {
        assert.doesNotMatch(source, /\{\s*name:\s*['"]CS_DESK['"]\s*,\s*pin:\s*['"]['"]\s*\}/);
    }
});

test('TV pairing URLs and importer use only an exact stripped fragment token', () => {
    const devicesTab = fs.readFileSync(
        path.join(__dirname, '../client/src/settings/tabs/DevicesTab.jsx'),
        'utf8',
    );
    const tvRuntime = fs.readFileSync(
        path.join(__dirname, '../public/tv/tv-dashboard.js'),
        'utf8',
    );

    assert.match(devicesTab, /tv:\s*['"]\/tv['"]/);
    assert.match(devicesTab, /#deviceToken=\$\{encodeURIComponent\(token\)\}/);
    assert.match(devicesTab, /public_https_base_url/);
    assert.doesNotMatch(devicesTab, /\/tv\?deviceToken=/);
    assert.match(tvRuntime, /url\.hash/);
    assert.match(tvRuntime, /hashParams\.get\(['"]deviceToken['"]\)/);
    assert.match(tvRuntime, /hashParams\.delete\(['"]deviceToken['"]\)/);
    assert.match(tvRuntime, /history\.replaceState/);
    assert.doesNotMatch(tvRuntime, /searchParams\.get\(['"](?:deviceToken|device_token|dt)['"]\)/);
    assert.doesNotMatch(tvRuntime, /hashParams\.get\(['"](?:device_token|dt)['"]\)/);

    function executeTvRuntime(href) {
        const stored = new Map();
        const historyUrls = [];
        const sandbox = {
            URL,
            URLSearchParams,
            Date,
            Math,
            CustomEvent: class CustomEvent {},
            console: { error() {}, warn() {}, log() {} },
            document: {
                title: 'TV',
                body: { dataset: {} },
                getElementById: () => null,
                querySelector: () => null,
                createElement: () => ({ classList: { add() {}, remove() {} } }),
            },
            fetch: async () => ({ ok: false, json: async () => ({}) }),
            setInterval: () => 0,
            setTimeout: () => 0,
            clearTimeout() {},
            window: {
                location: { href },
                localStorage: {
                    getItem: (key) => stored.get(key) || null,
                    setItem: (key, value) => stored.set(key, value),
                },
                history: {
                    replaceState: (_state, _title, url) => historyUrls.push(url),
                },
                addEventListener() {},
                dispatchEvent() {},
            },
        };
        vm.runInNewContext(tvRuntime, sandbox);
        return { stored, historyUrls };
    }

    const exact = executeTvRuntime(
        'http://store.local/tv?view=board#deviceToken=TV-FRAGMENT-SECRET&layout=wide',
    );
    assert.equal(exact.stored.get('tgp.tv.deviceToken'), 'TV-FRAGMENT-SECRET');
    assert.deepEqual(exact.historyUrls, ['/tv?view=board#layout=wide']);
    assert.equal(exact.historyUrls[0].includes('TV-FRAGMENT-SECRET'), false);

    const alias = executeTvRuntime('http://store.local/tv#dt=IGNORED-ALIAS');
    assert.equal(alias.stored.has('tgp.tv.deviceToken'), false);
    assert.deepEqual(alias.historyUrls, []);
});

test('settings UI does not distribute legacy TV access keys or query URLs', () => {
    const sources = [
        '../client/src/settings/tabs/DevicesTab.jsx',
        '../client/src/settings/tabs/StoreTvTab.jsx',
    ].map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'));

    for (const source of sources) {
        assert.doesNotMatch(source, /TV_ACCESS_KEY/);
        assert.doesNotMatch(source, /\/tv\?key=/);
        assert.doesNotMatch(source, /SECURE TV (?:URL|DASHBOARD LINK)/i);
    }
    assert.match(sources[0], /pairing link.*(?:authorize|token)/i);
    assert.match(sources[1], /Settings.*Devices/i);
});
