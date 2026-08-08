'use strict';

/**
 * Full Betacs / CS portal API integration test.
 * Requires Command Center on http://127.0.0.1:3001
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.TGP_BASE_URL || 'http://127.0.0.1:3001';

function readFixtureCache() {
    try {
        return JSON.parse(
            fs.readFileSync(path.join(__dirname, '.playwright-staff-cache.json'), 'utf8'),
        );
    } catch {
        return {};
    }
}

function readCsDeviceToken() {
    return process.env.TGP_TEST_CS_DEVICE_TOKEN || readFixtureCache().csDeviceToken || '';
}

function managerCredentials() {
    const manager = readFixtureCache().managerA;
    if (!manager?.name || !manager?.pin) {
        throw new Error(
            'Playwright manager credentials unavailable. Run tests/playwright-seed.cjs under Electron first.',
        );
    }
    return manager;
}

async function jfetch(path, opts = {}) {
    const res = await fetch(`${BASE}${path}`, opts);
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { res, body, status: res.status, ok: res.ok };
}

async function jfetchAuthed(path, token, opts = {}) {
    const headers = {
        ...(opts.headers || {}),
        'x-session-token': token || '',
    };
    return jfetch(path, { ...opts, headers });
}

async function waitForServer(maxMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
        try {
            const { ok } = await jfetch('/api/sync');
            if (ok) return;
        } catch { /* retry */ }
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Server not reachable at ${BASE} after ${maxMs}ms`);
}

async function managerToken() {
    const manager = managerCredentials();
    const { ok, body } = await jfetch('/api/mobile-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manager),
    });
    if (!ok) return null;
    return body.token;
}

async function floorStaffToken() {
    const cache = readFixtureCache();
    const { ok, body } = await jfetch('/api/mobile-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cache.name, pin: cache.pin }),
    });
    if (!ok) return null;
    return body.token;
}

async function setBetacs(enabled, token) {
    const manager = managerCredentials();
    for (const id_val of ['Cs_Full_Enabled', 'Betacs_Enabled']) {
        const { ok, body } = await jfetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': token || '' },
            body: JSON.stringify({
                table: 'settings',
                action: 'update',
                data: { setting_value: enabled ? '1' : '0' },
                id_col: 'setting_name',
                id_val,
                userContext: token ? { ...manager, token } : manager,
            }),
        });
        assert.ok(ok, `setBetacs ${id_val} failed: ${JSON.stringify(body)}`);
    }
    await jfetch('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': token || '' },
        body: JSON.stringify({
            table: 'settings',
            action: 'update',
            data: { setting_value: '0' },
            id_col: 'setting_name',
            id_val: 'Cs_Hub_Enabled',
            userContext: token ? { ...manager, token } : manager,
        }),
    });
}

async function csAction(payload) {
    const deviceToken = readCsDeviceToken();
    assert.ok(deviceToken, 'cs_desk fixture device token required; run tests/playwright-seed.cjs for the isolated fixture');
    return jfetch('/api/action', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-device-token': deviceToken,
        },
        body: JSON.stringify(payload),
    });
}

function tvOrderIds(sync) {
    return (sync.orders_tv || []).map((o) => o.order_id);
}

test('Betacs portal — full API walkthrough', async (t) => {
    try {
        await waitForServer(process.env.CI ? 5000 : 60000);
    } catch (e) {
        t.skip(`Live API not running at ${BASE} — start the app or use npm run test:betacs with webServer. (${e.message})`);
        return;
    }
    const token = await managerToken();
    assert.ok(token, 'Seeded fixture manager token required');
    const floorToken = await floorStaffToken();
    assert.ok(floorToken, 'Seeded fixture floor-staff token required');

    await setBetacs(false, token);

    await t.test('config and gates when Betacs off', async () => {
        const cfg = await jfetch('/api/cs/config');
        assert.ok(cfg.ok);
        assert.equal(cfg.body.betacs, false);
        assert.equal(cfg.body.csFull, false);
        assert.equal(cfg.body.hub, false);

        const routes = await jfetchAuthed('/api/betacs/routes', token);
        assert.equal(routes.status, 403);

        const unauth = await jfetch('/api/betacs/routes');
        assert.equal(unauth.status, 403);

        const redirect = await fetch(`${BASE}/betacs`, { redirect: 'manual' });
        assert.equal(redirect.status, 301);
        assert.match(redirect.headers.get('location') || '', /\/cs$/);
    });

    await t.test('legacy CS insert appears on sync orders (Open)', async () => {
        const orderId = `ORD-TEST-LEG-${Date.now()}`;
        const ins = await csAction({
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: orderId,
                customer: 'LEGACY TEST',
                item: '1X TEST ITEM',
                contact: '',
                location: '2',
                status: 'Open',
                logged_by: 'CS_DESK',
                closed_by: '',
            },
        });
        assert.ok(ins.ok, JSON.stringify(ins.body));

        const sync = await jfetchAuthed('/api/sync', token);
        assert.ok(sync.ok);
        const open = (sync.body.orders || []).find((o) => o.order_id === orderId);
        assert.ok(open, 'legacy order on sync.orders');
        assert.ok(tvOrderIds(sync.body).includes(orderId), 'legacy order on TV list');
    });

    await setBetacs(true, token);

    await t.test('config and read APIs when Betacs on', async () => {
        const cfg = await jfetch('/api/cs/config');
        assert.ok(cfg.ok);
        assert.equal(cfg.body.betacs, true);
        assert.equal(cfg.body.csFull, true);

        const routes = await jfetchAuthed('/api/betacs/routes', token);
        assert.ok(routes.ok);
        assert.ok(routes.body.routes.includes('Email orders'));
        assert.equal(routes.body.routes.includes('Quotes'), false);

        const names = await jfetchAuthed('/api/betacs/taken-by', token);
        assert.ok(names.ok);
        assert.ok(Array.isArray(names.body.names));
    });

    let orderId;
    await t.test('betacs insert → New (not on TV)', async () => {
        orderId = `ORD-TEST-BT-${Date.now()}`;
        const ins = await csAction({
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: orderId,
                customer: 'BETACS TEST',
                contact: '403-555-9999',
                needed_by: '2026-12-01',
                taken_by: 'CS DESK',
                route: 'Pop',
                item: '2X TEST WIDGET',
                location: '3',
                status: 'New',
                source: 'betacs',
                closed_by: '',
            },
        });
        assert.ok(ins.ok, JSON.stringify(ins.body));

        const board = await jfetchAuthed('/api/betacs/orders', token);
        assert.ok(board.ok);
        const row = board.body.orders.find((o) => o.order_id === orderId);
        assert.ok(row);
        assert.equal(row.status, 'New');

        const sync = await jfetchAuthed('/api/sync', token);
        assert.ok(!tvOrderIds(sync.body).includes(orderId), 'New betacs order not on TV');
    });

    await t.test('reject betacs insert when suite disabled', async () => {
        await setBetacs(false, token);
        const bad = await csAction({
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: `ORD-TEST-OFF-${Date.now()}`,
                customer: 'X',
                contact: '403-555-0000',
                needed_by: '2026-12-01',
                taken_by: 'CS DESK',
                route: 'Pop',
                item: '1X X',
                location: '1',
                status: 'New',
                source: 'betacs',
                closed_by: '',
            },
        });
        assert.equal(bad.status, 403);
        await setBetacs(true, token);
    });

    await t.test('validation rejects bad betacs insert', async () => {
        const bad = await csAction({
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: `ORD-TEST-BAD-${Date.now()}`,
                customer: '',
                contact: '123',
                needed_by: 'bad',
                taken_by: '',
                route: 'Quotes',
                item: '',
                location: '',
                status: 'New',
                source: 'betacs',
                closed_by: '',
            },
        });
        assert.equal(bad.status, 400);
    });

    await t.test('status flow New → Ordered → Ready → Complete + TV + audit', async () => {
        assert.ok(orderId);

        const toOrdered = await csAction({
            table: 'special_orders',
            action: 'update',
            data: { status: 'Ordered' },
            id_col: 'order_id',
            id_val: orderId,
        });
        assert.ok(toOrdered.ok);

        let sync = await jfetchAuthed('/api/sync', floorToken);
        assert.ok(tvOrderIds(sync.body).includes(orderId), 'Ordered on TV');
        const tvRow = (sync.body.orders_tv || []).find((o) => o.order_id === orderId);
        assert.ok(tvRow);
        assert.equal(tvRow.location, '3');
        assert.match(tvRow.item, /TEST WIDGET/);
        assert.equal(tvRow.customer, undefined);

        const toReady = await csAction({
            table: 'special_orders',
            action: 'update',
            data: { status: 'Ready' },
            id_col: 'order_id',
            id_val: orderId,
        });
        assert.ok(toReady.ok);
        sync = await jfetchAuthed('/api/sync', floorToken);
        assert.ok(!tvOrderIds(sync.body).includes(orderId), 'Ready off TV');

        const toComplete = await csAction({
            table: 'special_orders',
            action: 'update',
            data: { status: 'Complete' },
            id_col: 'order_id',
            id_val: orderId,
        });
        assert.ok(toComplete.ok);

        const board = await jfetchAuthed('/api/betacs/orders', token);
        assert.ok(!board.body.orders.some((o) => o.order_id === orderId));

        const audit = await jfetch(`/api/manager/order-audit?order_id=${encodeURIComponent(orderId)}`, {
            headers: { 'x-session-token': token },
        });
        assert.ok(audit.ok);
        assert.ok(audit.body.entries.length >= 4, 'insert + 3 status changes');
        const actions = audit.body.entries.map((e) => e.action);
        assert.ok(actions.includes('insert'));
        assert.ok(actions.includes('status_change') || actions.includes('complete'));
    });

    await t.test('invalid status transition rejected', async () => {
        const oid = `ORD-TEST-SKIP-${Date.now()}`;
        await csAction({
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: oid,
                customer: 'SKIP TEST',
                contact: '403-555-8888',
                needed_by: '2026-12-01',
                taken_by: 'CS DESK',
                route: 'Dairy',
                item: '1X SKIP',
                location: '1',
                status: 'New',
                source: 'betacs',
                closed_by: '',
            },
        });
        const skip = await csAction({
            table: 'special_orders',
            action: 'update',
            data: { status: 'Ready' },
            id_col: 'order_id',
            id_val: oid,
        });
        assert.equal(skip.status, 400);
    });

    await t.test('betacs New and Ordered appear on mobile for floor follow-up', async () => {
        const oid = `ORD-TEST-MOB-${Date.now()}`;
        await csAction({
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: oid,
                customer: 'MOBILE TEST',
                contact: '403-555-7777',
                needed_by: '2026-12-01',
                taken_by: 'CS DESK',
                route: 'Bakery',
                item: '1X MOB',
                location: '22',
                status: 'New',
                source: 'betacs',
                closed_by: '',
            },
        });
        let sync = await jfetchAuthed('/api/sync', floorToken);
        assert.ok((sync.body.orders || []).some((o) => o.order_id === oid), 'New appears on mobile');

        const toOrdered = await csAction({
            table: 'special_orders',
            action: 'update',
            data: { status: 'Ordered' },
            id_col: 'order_id',
            id_val: oid,
        });
        assert.ok(toOrdered.ok);
        sync = await jfetchAuthed('/api/sync', floorToken);
        assert.ok((sync.body.orders || []).some((o) => o.order_id === oid), 'Ordered on mobile for CLEAR');

        const clear = await jfetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': token },
            body: JSON.stringify({
                table: 'special_orders',
                action: 'update',
                data: { status: 'Closed' },
                id_col: 'order_id',
                id_val: oid,
                token,
            }),
        });
        assert.ok(clear.ok, `floor clear failed: ${JSON.stringify(clear.body)}`);
        sync = await jfetchAuthed('/api/sync', floorToken);
        assert.ok(!(sync.body.orders || []).some((o) => o.order_id === oid));
        assert.ok(!tvOrderIds(sync.body).includes(oid));
    });

    await t.test('CS CRM off → 403; on → search + link customer_id', async () => {
        await jfetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': token },
            body: JSON.stringify({
                table: 'settings', action: 'update',
                data: { setting_value: '0' },
                id_col: 'setting_name', id_val: 'Cs_Crm_Enabled',
                userContext: { ...managerCredentials(), token },
            }),
        });
        const offNoSession = await jfetch('/api/cs/customers?q=555');
        assert.equal(offNoSession.status, 403);
        const off = await jfetchAuthed('/api/cs/customers?q=555', token);
        assert.equal(off.status, 403);

        await setBetacs(true, token);
        await jfetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': token },
            body: JSON.stringify({
                table: 'settings', action: 'update',
                data: { setting_value: '1' },
                id_col: 'setting_name', id_val: 'Cs_Crm_Enabled',
                userContext: { ...managerCredentials(), token },
            }),
        });

        const cfg = await jfetch('/api/cs/config');
        assert.ok(cfg.ok);
        assert.equal(cfg.body.crm, true);

        const phone = `403555${String(Date.now()).slice(-4)}`;
        const orderId = `ORD-CRM-${Date.now()}`;
        const ins = await csAction({
            table: 'special_orders',
            action: 'insert',
            data: {
                order_id: orderId,
                customer: 'CRM TEST',
                contact: phone,
                needed_by: '2026-08-01',
                taken_by: 'CS DESK',
                route: 'Dairy',
                item: '1X MILK',
                location: '1',
                status: 'New',
                source: 'betacs',
                closed_by: '',
            },
        });
        assert.ok(ins.ok, JSON.stringify(ins.body));

        const byPhone = await jfetchAuthed(`/api/cs/customer-by-phone?phone=${encodeURIComponent(phone)}`, token);
        assert.ok(byPhone.ok);
        assert.ok(byPhone.body.customer);
        assert.equal(byPhone.body.customer.phone_digits, phone.replace(/\D/g, ''));

        const search = await jfetchAuthed(`/api/cs/customers?q=${encodeURIComponent(phone.slice(-4))}`, token);
        assert.ok(search.ok);
        assert.ok((search.body.customers || []).some((c) => c.phone_digits === phone.replace(/\D/g, '')));

        await jfetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-session-token': token },
            body: JSON.stringify({
                table: 'settings', action: 'update',
                data: { setting_value: '0' },
                id_col: 'setting_name', id_val: 'Cs_Crm_Enabled',
                userContext: { ...managerCredentials(), token },
            }),
        });
    });

    await setBetacs(false, token);
});
