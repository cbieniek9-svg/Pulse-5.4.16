'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    registerReceivingReportPeriodRoutes,
} = require('../src/routes/manager/receiving-report-period.cjs');
const {
    registerReceivingReportSheetRoutes,
} = require('../src/routes/manager/receiving-report-sheets.cjs');

function harness(session) {
    const routes = new Map();
    const server = {
        get(path, handler) { routes.set(`GET ${path}`, handler); },
        post(path, handler) { routes.set(`POST ${path}`, handler); },
        put(path, handler) { routes.set(`PUT ${path}`, handler); },
        delete(path, handler) { routes.set(`DELETE ${path}`, handler); },
    };
    const db = {
        get(sql) {
            if (String(sql).includes('FROM settings')) return { setting_value: '0' };
            return null;
        },
        findStaffByName() {
            return { permissions: session.permissions || '' };
        },
    };
    const ctx = {
        db,
        wrap: (handler) => handler,
        fail(res, status, message) {
            res.status(status).json({ success: false, error: message });
        },
        requireSession() { return session; },
        getStoreDateStamp: () => '2026-06-01',
    };
    return { server, routes, ctx };
}

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

test('legacy period lock HTTP endpoint is retired without touching period state', async () => {
    const h = harness({ name: 'Manager A', role: 'Manager', staff_id: 101 });
    registerReceivingReportPeriodRoutes(h.server, h.ctx);
    const res = response();
    await h.routes.get('POST /api/receiving/report/period/lock')(
        { body: { period_start: '2026-06-01' } },
        res,
    );
    assert.equal(res.statusCode, 410);
    assert.equal(res.body.code, 'PERIOD_LOCK_ENDPOINT_RETIRED');
});

test('receiving-only staff cannot edit financial sales fields', async () => {
    const h = harness({
        name: 'Receiver One',
        role: 'Premium Clerk',
        permissions: 'receiving',
        staff_id: 303,
    });
    registerReceivingReportSheetRoutes(h.server, h.ctx);
    const res = response();
    await h.routes.get('PUT /api/receiving/report/sales')(
        { body: { store_date: '2026-06-01', amount: 1 } },
        res,
    );
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /manager role required/i);
});

