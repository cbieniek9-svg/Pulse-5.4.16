'use strict';

const crypto = require('crypto');

const CS_CRM_SETTING = 'Cs_Crm_Enabled';

function envCrmOn() {
    const v = String(process.env.TGP_CS_CRM_ENABLED || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function isCsCrmEnabled(settings) {
    if (envCrmOn()) return true;
    return settings?.[CS_CRM_SETTING] === '1';
}

/** CRM features require CS_Full as well (desk order workflow). */
function isCsCrmActive(settings) {
    const { isCsFullEnabled } = require('./special-orders.cjs');
    return isCsCrmEnabled(settings) && isCsFullEnabled(settings);
}

function normalizePhoneDigits(raw) {
    return String(raw || '').replace(/\D/g, '');
}

function newCustomerId() {
    if (typeof crypto.randomUUID === 'function') {
        return `CUS-${crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`;
    }
    return `CUS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`.toUpperCase();
}

function findByPhoneDigits(db, digits) {
    const d = normalizePhoneDigits(digits);
    if (d.length < 7) return null;
    return db.get('SELECT * FROM cs_customers WHERE phone_digits = ?', d) || null;
}

function findById(db, customerId) {
    if (!customerId) return null;
    return db.get('SELECT * FROM cs_customers WHERE customer_id = ?', customerId) || null;
}

/**
 * Search by name substring or phone digits (min 3 digits or 2 name chars).
 */
function searchCustomers(db, q, limit = 25) {
    const raw = String(q || '').trim();
    if (!raw) return [];
    const digits = normalizePhoneDigits(raw);
    const lim = Math.min(Math.max(Number(limit) || 25, 1), 50);

    if (digits.length >= 3) {
        return db.all(
            `SELECT * FROM cs_customers
             WHERE phone_digits LIKE ?
             ORDER BY COALESCE(last_order_at, updated_at) DESC
             LIMIT ?`,
            `%${digits}%`,
            lim,
        ) || [];
    }

    const nameQ = raw.toUpperCase();
    if (nameQ.length < 2) return [];
    return db.all(
        `SELECT * FROM cs_customers
         WHERE UPPER(display_name) LIKE ?
            OR UPPER(COALESCE(tags,'')) LIKE ?
            OR UPPER(COALESCE(email,'')) LIKE ?
         ORDER BY
            CASE WHEN vip = 1 THEN 0 ELSE 1 END,
            CASE WHEN alert_flag = 1 THEN 0 ELSE 1 END,
            COALESCE(last_order_at, updated_at) DESC
         LIMIT ?`,
        `%${nameQ}%`,
        `%${nameQ}%`,
        `%${nameQ}%`,
        lim,
    ) || [];
}

/**
 * Find or create by phone. Updates display name when a newer spelling is provided.
 */
function findOrCreateCustomer(db, { name, phone, phoneDisplay, now } = {}) {
    const digits = normalizePhoneDigits(phone);
    if (digits.length < 7) {
        const err = new Error('A valid phone number is required (at least 7 digits).');
        err.status = 400;
        throw err;
    }
    const displayName = String(name || '').trim() || 'CUSTOMER';
    const displayPhone = String(phoneDisplay != null ? phoneDisplay : phone || '').trim() || digits;
    const ts = now || new Date().toISOString();

    const existing = findByPhoneDigits(db, digits);
    if (existing) {
        if (displayName && displayName !== existing.display_name) {
            db.run(
                `UPDATE cs_customers SET display_name = ?, phone_display = ?, updated_at = ? WHERE customer_id = ?`,
                displayName,
                displayPhone,
                ts,
                existing.customer_id,
            );
            return findById(db, existing.customer_id);
        }
        if (displayPhone && displayPhone !== existing.phone_display) {
            db.run(
                `UPDATE cs_customers SET phone_display = ?, updated_at = ? WHERE customer_id = ?`,
                displayPhone,
                ts,
                existing.customer_id,
            );
            return findById(db, existing.customer_id);
        }
        return existing;
    }

    const customerId = newCustomerId();
    db.run(
        `INSERT INTO cs_customers
         (customer_id, display_name, phone_digits, phone_display, notes, prefs, created_at, updated_at, last_order_at)
         VALUES (?, ?, ?, ?, '', '', ?, ?, NULL)`,
        customerId,
        displayName,
        digits,
        displayPhone,
        ts,
        ts,
    );
    return findById(db, customerId);
}

function updateCustomer(db, customerId, patch = {}, now) {
    const row = findById(db, customerId);
    if (!row) {
        const err = new Error('Customer not found.');
        err.status = 404;
        throw err;
    }
    const ts = now || new Date().toISOString();
    const displayName = patch.display_name != null ? String(patch.display_name).trim() : row.display_name;
    const notes = patch.notes != null ? String(patch.notes) : (row.notes || '');
    const prefs = patch.prefs != null ? String(patch.prefs) : (row.prefs || '');
    const email = patch.email != null ? String(patch.email).trim().slice(0, 200) : (row.email || '');
    const addressLine = patch.address_line != null ? String(patch.address_line).trim().slice(0, 400) : (row.address_line || '');
    const tags = patch.tags != null ? String(patch.tags).trim().slice(0, 400) : (row.tags || '');
    const preferredContact = patch.preferred_contact != null
        ? String(patch.preferred_contact).trim().slice(0, 80)
        : (row.preferred_contact || '');
    const vip = patch.vip != null ? (patch.vip ? 1 : 0) : Number(row.vip || 0);
    const alertFlag = patch.alert_flag != null ? (patch.alert_flag ? 1 : 0) : Number(row.alert_flag || 0);
    let phoneDigits = row.phone_digits;
    let phoneDisplay = row.phone_display;
    if (patch.phone != null || patch.phone_display != null) {
        const raw = patch.phone != null ? patch.phone : patch.phone_display;
        const digits = normalizePhoneDigits(raw);
        if (digits.length >= 7) {
            const clash = findByPhoneDigits(db, digits);
            if (clash && clash.customer_id !== customerId) {
                const err = new Error('Another customer already uses that phone number.');
                err.status = 409;
                throw err;
            }
            phoneDigits = digits;
            phoneDisplay = String(patch.phone_display != null ? patch.phone_display : raw).trim() || digits;
        }
    }
    if (!displayName) {
        const err = new Error('Customer name is required.');
        err.status = 400;
        throw err;
    }
    db.run(
        `UPDATE cs_customers SET display_name = ?, phone_digits = ?, phone_display = ?,
         notes = ?, prefs = ?, email = ?, address_line = ?, tags = ?, vip = ?, alert_flag = ?,
         preferred_contact = ?, updated_at = ? WHERE customer_id = ?`,
        displayName,
        phoneDigits,
        phoneDisplay,
        notes,
        prefs,
        email,
        addressLine,
        tags,
        vip,
        alertFlag,
        preferredContact,
        ts,
        customerId,
    );
    return findById(db, customerId);
}

function touchLastOrder(db, customerId, at) {
    if (!customerId) return;
    const ts = at || new Date().toISOString();
    db.run(
        `UPDATE cs_customers SET last_order_at = ?, updated_at = ? WHERE customer_id = ?`,
        ts,
        ts,
        customerId,
    );
}

/**
 * On CS_Full insert: resolve/create customer and return customer_id (or null if CRM inactive / no phone).
 */
function linkOrderToCustomer(db, settings, orderData, serverTime) {
    if (!isCsCrmActive(settings)) return null;
    if (String(orderData.source || '').toLowerCase() !== 'betacs') return null;
    const digits = normalizePhoneDigits(orderData.contact);
    if (digits.length < 7) return null;
    const customer = findOrCreateCustomer(db, {
        name: orderData.customer,
        phone: orderData.contact,
        phoneDisplay: orderData.contact,
        now: serverTime,
    });
    touchLastOrder(db, customer.customer_id, serverTime);
    return customer.customer_id;
}

function listOrdersForCustomer(db, customerId, { openLimit = 50, pastLimit = 25 } = {}) {
    const open = db.all(
        `SELECT order_id, customer, item, contact, location, route, needed_by, taken_by,
                logged_by, status, time_logged, ordered_at, ready_at, closed_by, time_closed,
                customer_id, source, notes, notes_updated_at, notes_updated_by
         FROM special_orders
         WHERE customer_id = ? AND status NOT IN ('Complete', 'Closed', 'Archived')
         ORDER BY time_logged DESC
         LIMIT ?`,
        customerId,
        openLimit,
    ) || [];
    const past = db.all(
        `SELECT order_id, customer, item, contact, location, route, needed_by, taken_by,
                logged_by, status, time_logged, ordered_at, ready_at, closed_by, time_closed,
                customer_id, source, notes, notes_updated_at, notes_updated_by
         FROM special_orders
         WHERE customer_id = ? AND status IN ('Complete', 'Closed', 'Archived')
         ORDER BY COALESCE(time_closed, time_logged) DESC
         LIMIT ?`,
        customerId,
        pastLimit,
    ) || [];
    return { open, past };
}

const EVENT_TYPES = new Set(['note', 'call', 'complaint', 'short', 'reorder', 'pickup', 'other']);

function listCustomerEvents(db, customerId, limit = 40) {
    return db.all(
        `SELECT * FROM cs_customer_events
         WHERE customer_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        customerId,
        Math.min(Math.max(Number(limit) || 40, 1), 100),
    ) || [];
}

function addCustomerEvent(db, customerId, { event_type, body, related_order_id, created_by, now } = {}) {
    const customer = findById(db, customerId);
    if (!customer) {
        const err = new Error('Customer not found.');
        err.status = 404;
        throw err;
    }
    const type = String(event_type || 'note').toLowerCase();
    if (!EVENT_TYPES.has(type)) {
        const err = new Error('Invalid event type.');
        err.status = 400;
        throw err;
    }
    const text = String(body || '').trim().slice(0, 2000);
    if (!text) {
        const err = new Error('Event body required.');
        err.status = 400;
        throw err;
    }
    const ts = now || new Date().toISOString();
    const eventId = `CE-${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 16) : Date.now().toString(36)}`.toUpperCase();
    db.run(
        `INSERT INTO cs_customer_events
         (event_id, customer_id, event_type, body, related_order_id, created_at, created_by)
         VALUES (?,?,?,?,?,?,?)`,
        eventId,
        customerId,
        type,
        text,
        String(related_order_id || '').trim(),
        ts,
        String(created_by || '').trim(),
    );
    db.run(`UPDATE cs_customers SET updated_at = ? WHERE customer_id = ?`, ts, customerId);
    return db.get('SELECT * FROM cs_customer_events WHERE event_id = ?', eventId);
}

function getCustomerProfile(db, customerId) {
    const customer = findById(db, customerId);
    if (!customer) return null;
    const orders = listOrdersForCustomer(db, customerId);
    const events = listCustomerEvents(db, customerId);
    const counts = countOrdersForCustomer(db, customerId);
    const shortOrders = [...orders.open, ...orders.past].filter((o) => {
        const n = String(o.notes || '').toLowerCase();
        return n.includes('short') || n.includes('reorder') || n.includes('re-order');
    }).length;
    const shortEvents = events.filter((e) => e.event_type === 'short' || e.event_type === 'reorder').length;
    return {
        customer,
        ...orders,
        events,
        counts: {
            ...counts,
            shorts: shortOrders + shortEvents,
            vip: Number(customer.vip || 0) === 1,
            alert: Number(customer.alert_flag || 0) === 1,
        },
    };
}

function countOrdersForCustomer(db, customerId) {
    const row = db.get(
        `SELECT
            SUM(CASE WHEN status NOT IN ('Complete','Closed','Archived') THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN status IN ('Complete','Closed','Archived') THEN 1 ELSE 0 END) AS past_count,
            COUNT(*) AS total
         FROM special_orders WHERE customer_id = ?`,
        customerId,
    );
    return {
        open: Number(row?.open_count || 0),
        past: Number(row?.past_count || 0),
        total: Number(row?.total || 0),
    };
}

module.exports = {
    CS_CRM_SETTING,
    EVENT_TYPES,
    isCsCrmEnabled,
    isCsCrmActive,
    normalizePhoneDigits,
    findByPhoneDigits,
    findById,
    searchCustomers,
    findOrCreateCustomer,
    updateCustomer,
    touchLastOrder,
    linkOrderToCustomer,
    listOrdersForCustomer,
    listCustomerEvents,
    addCustomerEvent,
    getCustomerProfile,
    countOrdersForCustomer,
};
