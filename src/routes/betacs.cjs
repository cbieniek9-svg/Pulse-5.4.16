'use strict';

const {
    ORDER_ROUTES,
    isCsFullEnabled,
    isCsHubEnabled,
    listOpenCsFullOrders,
    bucketDueOrders,
} = require('../lib/special-orders.cjs');
const {
    isCsCrmEnabled,
    searchCustomers,
    findOrCreateCustomer,
    getCustomerProfile,
    updateCustomer,
    addCustomerEvent,
    countOrdersForCustomer,
    findByPhoneDigits,
    normalizePhoneDigits,
} = require('../lib/cs-customers.cjs');
const { buildCsOrderPrintHtml } = require('../lib/cs-order-print.cjs');
const { getStoreMeta } = require('../constants/store-meta.cjs');

/**
 * CS portal APIs (CS_Full suite when enabled; hub shell when Cs_Hub_Enabled; CRM when Cs_Crm_Enabled).
 * Beta / CS_Full / CRM routes require a session. Legacy desk orders still use /api/action + CS_DESK.
 * @param {import('express').Application} server
 * @param {object} ctx
 */
function registerBetacsRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, getStoreDateStamp } = ctx;

    function assertCrm(res) {
        const settings = db.getSettings();
        if (!isCsFullEnabled(settings)) {
            fail(res, 403, 'CS_Full is not enabled.');
            return null;
        }
        if (!isCsCrmEnabled(settings)) {
            fail(res, 403, 'CS customer CRM is not enabled.');
            return null;
        }
        return settings;
    }

    function requireBetaSession(req, res) {
        return requireSession(req, res, false);
    }

    server.get('/api/cs/config', wrap(async (_req, res) => {
        const settings = db.getSettings();
        const csFull = isCsFullEnabled(settings);
        const hub = isCsHubEnabled(settings);
        const crm = isCsCrmEnabled(settings) && csFull;
        res.set('Cache-Control', 'no-store');
        res.json({
            hub,
            csFull,
            crm,
            /** @deprecated alias for older clients/tests */
            betacs: csFull,
            portalUrl: '/cs',
        });
    }));

    server.get('/api/cs/login-staff', wrap(async (_req, res) => {
        const settings = db.getSettings();
        if (!isCsHubEnabled(settings) && !isCsFullEnabled(settings)) {
            return fail(res, 403, 'CS module hub is not enabled.');
        }
        const rows = db.all(
            "SELECT name, role FROM staff WHERE active = 1 AND app_access = 1 ORDER BY name",
        );
        res.json({ names: rows.map((r) => ({ name: r.name, role: r.role || '' })) });
    }));

    server.get('/api/cs/due-orders', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!isCsFullEnabled(db.getSettings())) {
            return fail(res, 403, 'CS_Full is not enabled.');
        }
        const storeDate = typeof getStoreDateStamp === 'function'
            ? getStoreDateStamp()
            : new Date().toISOString().slice(0, 10);
        const orders = listOpenCsFullOrders(db);
        const buckets = bucketDueOrders(orders, storeDate);
        res.json({
            store_date: storeDate,
            ...buckets,
        });
    }));

    server.get('/api/cs/customers', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!assertCrm(res)) return;
        const q = String(req.query?.q || '').trim();
        const rows = searchCustomers(db, q);
        res.json({
            customers: rows.map((c) => ({
                ...c,
                counts: countOrdersForCustomer(db, c.customer_id),
            })),
        });
    }));

    server.get('/api/cs/customers/:id', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!assertCrm(res)) return;
        const profile = getCustomerProfile(db, req.params.id);
        if (!profile) return fail(res, 404, 'Customer not found.');
        res.json(profile);
    }));

    server.post('/api/cs/customers', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!assertCrm(res)) return;
        const body = req.body || {};
        const customer = findOrCreateCustomer(db, {
            name: body.name || body.display_name,
            phone: body.phone || body.contact,
            phoneDisplay: body.phone_display || body.phone || body.contact,
        });
        res.json({
            customer,
            counts: countOrdersForCustomer(db, customer.customer_id),
            created: true,
        });
    }));

    server.post('/api/cs/customers/:id', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!assertCrm(res)) return;
        const customer = updateCustomer(db, req.params.id, req.body || {});
        res.json({
            customer,
            counts: countOrdersForCustomer(db, customer.customer_id),
        });
    }));

    server.post('/api/cs/customers/:id/events', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!assertCrm(res)) return;
        const body = req.body || {};
        const event = addCustomerEvent(db, req.params.id, {
            event_type: body.event_type,
            body: body.body,
            related_order_id: body.related_order_id,
            created_by: body.created_by || req.session?.display_name || req.session?.username || '',
        });
        res.json({ event, profile: getCustomerProfile(db, req.params.id) });
    }));

    /** Lookup hint while typing phone on CS_Full form */
    server.get('/api/cs/customer-by-phone', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!assertCrm(res)) return;
        const digits = normalizePhoneDigits(req.query?.phone || req.query?.q || '');
        if (digits.length < 7) {
            return res.json({ customer: null });
        }
        const customer = findByPhoneDigits(db, digits);
        if (!customer) return res.json({ customer: null });
        res.json({
            customer,
            counts: countOrdersForCustomer(db, customer.customer_id),
        });
    }));

    server.get('/api/betacs/routes', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!isCsFullEnabled(db.getSettings())) return fail(res, 403, 'CS_Full is not enabled.');
        res.json({ routes: ORDER_ROUTES });
    }));

    server.get('/api/betacs/taken-by', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!isCsFullEnabled(db.getSettings())) return fail(res, 403, 'CS_Full is not enabled.');
        const rows = db.all(
            "SELECT name FROM staff WHERE active = 1 AND app_access = 1 ORDER BY name",
        );
        res.json({ names: rows.map((r) => r.name) });
    }));

    server.get('/api/betacs/orders', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!isCsFullEnabled(db.getSettings())) return fail(res, 403, 'CS_Full is not enabled.');
        const orders = listOpenCsFullOrders(db);
        res.json({ orders });
    }));

    /** Printable order slip (CS_Full / CRM desk). */
    server.get('/api/cs/orders/:id/print', wrap(async (req, res) => {
        if (!requireBetaSession(req, res)) return;
        if (!isCsFullEnabled(db.getSettings())) {
            return fail(res, 403, 'CS_Full is not enabled.');
        }
        const order = db.get('SELECT * FROM special_orders WHERE order_id = ?', req.params.id);
        if (!order) return fail(res, 404, 'Order not found.');
        const settings = db.getSettings();
        const store = typeof getStoreMeta === 'function' ? getStoreMeta(settings) : {};
        const html = buildCsOrderPrintHtml(order, {
            storeName: store.displayName || settings.Store_Display_Name || 'TGP Center Store',
        });
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.set('Cache-Control', 'no-store');
        res.send(html);
    }));
}

module.exports = { registerBetacsRoutes };
