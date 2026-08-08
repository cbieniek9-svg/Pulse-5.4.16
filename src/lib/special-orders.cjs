'use strict';

const BETA_STATUSES = new Set(['New', 'Ordered', 'Ready', 'Complete']);
const LEGACY_OPEN = 'Open';
const LEGACY_CLOSED = 'Closed';
const BETACS_SETTING = 'Betacs_Enabled';
const CS_FULL_SETTING = 'Cs_Full_Enabled';
const CS_HUB_SETTING = 'Cs_Hub_Enabled';

const ORDER_ROUTES = [
    'Frozen/Groc',
    'Crossdock',
    'G&L',
    'Dairy',
    'Email orders',
    'Pop',
    'Nella West',
    'Complete Distributors',
    'Monin/Torani',
    'Canada Bread',
    'Bakery',
    'Meat',
    'Produce',
    'Other',
];

const STATUS_FLOW = {
    New: ['Ordered'],
    Ordered: ['Ready'],
    Ready: ['Complete'],
};

function envFlagOn(...keys) {
    for (const key of keys) {
        const v = String(process.env[key] || '').trim().toLowerCase();
        if (v === '1' || v === 'true' || v === 'yes') return true;
    }
    return false;
}

function isBetacsEnvOverride() {
    return envFlagOn('TGP_CS_FULL_ENABLED', 'TGP_CS_BETA_TV', 'TGP_BETACS_ENABLED');
}

function isCsHubEnvOverride() {
    return envFlagOn('TGP_CS_HUB_ENABLED');
}

/**
 * CS_Full workflow (former Betacs). Reads Cs_Full_Enabled, falls back to Betacs_Enabled.
 */
function isCsFullEnabled(settings) {
    if (isBetacsEnvOverride()) return true;
    const full = settings?.[CS_FULL_SETTING];
    if (full === '1') return true;
    if (full === '0') return false;
    return settings?.[BETACS_SETTING] === '1';
}

/** @deprecated alias — prefer isCsFullEnabled */
function isBetacsEnabled(settings) {
    return isCsFullEnabled(settings);
}

/** Manager hub shell (login + 3 buttons). Default off for demo-before-go-live. */
function isCsHubEnabled(settings) {
    if (isCsHubEnvOverride()) return true;
    return settings?.[CS_HUB_SETTING] === '1';
}

/** @deprecated use isCsFullEnabled */
function isCsBetaTvEnabled(settings) {
    return isCsFullEnabled(settings);
}

function isBetacsRow(row) {
    return row && String(row.source || '').toLowerCase() === 'betacs';
}

function getLegacyOpenOrders(db) {
    return db.all('SELECT * FROM special_orders WHERE status = ?', LEGACY_OPEN);
}

function getMobileCustomerOrders(db) {
    const legacy = getLegacyOpenOrders(db);
    const settings = db.getSettings ? db.getSettings() : {};
    if (!isCsFullEnabled(settings)) return legacy;
    const beta = db.all(
        `SELECT * FROM special_orders
         WHERE source = 'betacs' AND status IN ('New', 'Ordered', 'Ready')
         ORDER BY COALESCE(ordered_at, time_logged) ASC`,
    );
    const seen = new Set(legacy.map((o) => o.order_id));
    const merged = [...legacy, ...beta.filter((o) => !seen.has(o.order_id))];
    // Ready (awaiting pickup) first so floor can check & clear pickups quickly
    const rank = (o) => {
        if (o.source === 'betacs' && o.status === 'Ready') return 0;
        if (o.source === 'betacs' && o.status === 'Ordered') return 1;
        if (o.source === 'betacs') return 2;
        return 3;
    };
    return merged.sort((a, b) => rank(a) - rank(b));
}

function resolveCustomerOrderCloseStatus(row, requestedStatus) {
    const req = String(requestedStatus || '').trim();
    if (!isBetacsRow(row)) {
        if (req === 'Complete') return LEGACY_CLOSED;
        return req === LEGACY_CLOSED ? LEGACY_CLOSED : req;
    }
    if (req === LEGACY_CLOSED || req === 'Complete') {
        const cur = String(row.status || '').trim();
        if (cur === 'Ready') return 'Complete';
        if (cur === 'Ordered' || cur === 'New') return 'Complete';
        if (cur === 'Complete') return 'Complete';
    }
    return req;
}

function canForceBetacsComplete(fromStatus) {
    return ['New', 'Ordered', 'Ready'].includes(String(fromStatus || '').trim());
}

function getTvCustomerOrders(db) {
    const settings = db.getSettings ? db.getSettings() : {};
    const legacy = db.all(
        'SELECT order_id, location, item, status, source FROM special_orders WHERE status = ? ORDER BY time_logged ASC',
        LEGACY_OPEN,
    );
    if (!isCsFullEnabled(settings)) return legacy;

    const beta = db.all(
        "SELECT order_id, location, item, status, source FROM special_orders WHERE source = 'betacs' AND status = 'Ordered' ORDER BY COALESCE(ordered_at, time_logged) ASC",
    );
    return [...legacy, ...beta];
}

function validateBetacsInsert(data) {
    const err = (msg) => {
        const e = new Error(msg);
        e.status = 400;
        throw e;
    };
    const customer = String(data.customer || '').trim();
    const contact = String(data.contact || '').trim();
    const neededBy = String(data.needed_by || '').trim();
    const takenBy = String(data.taken_by || '').trim();
    const item = String(data.item || '').trim();
    const location = String(data.location || '').trim();
    const route = String(data.route || '').trim();

    if (!customer) err('Customer name is required.');
    if (!contact || contact.replace(/\D/g, '').length < 7) err('A valid phone number is required.');
    if (!neededBy || !/^\d{4}-\d{2}-\d{2}$/.test(neededBy)) err('Date needed by is required (YYYY-MM-DD).');
    if (!takenBy) err('Who took the order is required.');
    if (!item) err('Items and quantities are required.');
    if (!location) err('Location is required.');
    if (!route || !ORDER_ROUTES.includes(route)) err('A valid route is required.');
}

function validateBetacsStatusChange(fromStatus, toStatus) {
    const allowed = STATUS_FLOW[fromStatus];
    if (!allowed || !allowed.includes(toStatus)) {
        const err = new Error(`Cannot move order from ${fromStatus} to ${toStatus}.`);
        err.status = 400;
        throw err;
    }
}

function assertBetacsEnabled(settings) {
    if (!isCsFullEnabled(settings)) {
        const err = new Error('CS_Full customer order suite is not enabled.');
        err.status = 403;
        throw err;
    }
}

function orderSnapshot(row) {
    if (!row) return null;
    return {
        order_id: row.order_id,
        customer: row.customer,
        item: row.item,
        contact: row.contact,
        location: row.location,
        route: row.route,
        needed_by: row.needed_by,
        taken_by: row.taken_by,
        status: row.status,
        source: row.source,
        logged_by: row.logged_by,
    };
}

function logOrderAudit(db, { orderId, actor, action, fromStatus, toStatus, snapshot, ip }) {
    const crypto = require('crypto');
    db.run(
        `INSERT INTO order_audit (id, order_id, actor, action, from_status, to_status, snapshot, ip, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        orderId,
        actor,
        action,
        fromStatus || '',
        toStatus || '',
        JSON.stringify(snapshot || {}),
        ip || '',
        new Date().toISOString(),
    );
}

function bucketDueOrders(orders, storeDate) {
    const day = String(storeDate || '').slice(0, 10);
    const overdue = [];
    const dueToday = [];
    const upcoming = [];
    for (const o of orders || []) {
        const nb = String(o.needed_by || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(nb) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
            upcoming.push(o);
            continue;
        }
        if (nb < day) overdue.push(o);
        else if (nb === day) dueToday.push(o);
        else upcoming.push(o);
    }
    const byNeeded = (a, b) => String(a.needed_by || '').localeCompare(String(b.needed_by || ''));
    overdue.sort(byNeeded);
    dueToday.sort(byNeeded);
    upcoming.sort(byNeeded);
    return { overdue, dueToday, upcoming, overdueCount: overdue.length };
}

function listOpenCsFullOrders(db) {
    return db.all(`
        SELECT order_id, customer, item, contact, location, route, needed_by, taken_by,
               logged_by, status, time_logged, ordered_at, ready_at, closed_by, time_closed
        FROM special_orders
        WHERE source = 'betacs' AND status NOT IN ('Complete')
        ORDER BY
            CASE status WHEN 'New' THEN 1 WHEN 'Ordered' THEN 2 WHEN 'Ready' THEN 3 ELSE 4 END,
            time_logged ASC
    `);
}

module.exports = {
    BETACS_SETTING,
    CS_FULL_SETTING,
    CS_HUB_SETTING,
    BETA_STATUSES,
    LEGACY_OPEN,
    LEGACY_CLOSED,
    ORDER_ROUTES,
    STATUS_FLOW,
    isBetacsEnvOverride,
    isCsHubEnvOverride,
    isCsFullEnabled,
    isCsHubEnabled,
    isBetacsEnabled,
    isCsBetaTvEnabled,
    isBetacsRow,
    getLegacyOpenOrders,
    getMobileCustomerOrders,
    resolveCustomerOrderCloseStatus,
    canForceBetacsComplete,
    getTvCustomerOrders,
    validateBetacsInsert,
    validateBetacsStatusChange,
    assertBetacsEnabled,
    orderSnapshot,
    logOrderAudit,
    bucketDueOrders,
    listOpenCsFullOrders,
};
