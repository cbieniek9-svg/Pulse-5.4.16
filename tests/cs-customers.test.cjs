'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isCsCrmEnabled,
    isCsCrmActive,
    normalizePhoneDigits,
    findOrCreateCustomer,
    searchCustomers,
    updateCustomer,
    linkOrderToCustomer,
    getCustomerProfile,
} = require('../src/lib/cs-customers.cjs');

function makeDb() {
    const customers = new Map();
    const orders = [];
    return {
        _customers: customers,
        _orders: orders,
        get(sql, ...params) {
            if (sql.includes('FROM cs_customers WHERE phone_digits')) {
                return customers.get(params[0]) || null;
            }
            if (sql.includes('FROM cs_customers WHERE customer_id')) {
                return [...customers.values()].find((c) => c.customer_id === params[0]) || null;
            }
            if (sql.includes('SUM(CASE WHEN status')) {
                const list = orders.filter((o) => o.customer_id === params[0]);
                const open = list.filter((o) => !['Complete', 'Closed', 'Archived'].includes(o.status)).length;
                const past = list.length - open;
                return { open_count: open, past_count: past, total: list.length };
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('phone_digits LIKE')) {
                const dig = String(params[0]).replace(/%/g, '');
                return [...customers.values()].filter((c) => c.phone_digits.includes(dig));
            }
            if (sql.includes('UPPER(display_name) LIKE')) {
                const q = String(params[0]).replace(/%/g, '').toUpperCase();
                return [...customers.values()].filter((c) => c.display_name.toUpperCase().includes(q));
            }
            if (sql.includes('status NOT IN')) {
                return orders.filter((o) => o.customer_id === params[0]
                    && !['Complete', 'Closed', 'Archived'].includes(o.status));
            }
            if (sql.includes("status IN ('Complete'")) {
                return orders.filter((o) => o.customer_id === params[0]
                    && ['Complete', 'Closed', 'Archived'].includes(o.status));
            }
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO cs_customers')) {
                const row = {
                    customer_id: params[0],
                    display_name: params[1],
                    phone_digits: params[2],
                    phone_display: params[3],
                    notes: '',
                    prefs: '',
                    created_at: params[4],
                    updated_at: params[5],
                    last_order_at: null,
                };
                customers.set(row.phone_digits, row);
                return;
            }
            if (sql.includes('UPDATE cs_customers SET display_name') && sql.includes('phone_display') && sql.includes('notes')) {
                // display_name, phone_digits, phone_display, notes, prefs, email,
                // address_line, tags, vip, alert_flag, preferred_contact, updated_at, customer_id
                const id = params[params.length - 1];
                const row = [...customers.values()].find((c) => c.customer_id === id);
                if (!row) return;
                customers.delete(row.phone_digits);
                row.display_name = params[0];
                row.phone_digits = params[1];
                row.phone_display = params[2];
                row.notes = params[3];
                row.prefs = params[4];
                row.email = params[5] || '';
                row.address_line = params[6] || '';
                row.tags = params[7] || '';
                row.vip = params[8] || 0;
                row.alert_flag = params[9] || 0;
                row.preferred_contact = params[10] || '';
                row.updated_at = params[11];
                customers.set(row.phone_digits, row);
                return;
            }
            if (sql.includes('UPDATE cs_customers SET display_name')) {
                const id = params[params.length - 1];
                const row = [...customers.values()].find((c) => c.customer_id === id);
                if (!row) return;
                row.display_name = params[0];
                if (params.length >= 4) row.phone_display = params[1];
                row.updated_at = params[params.length - 2];
                return;
            }
            if (sql.includes('UPDATE cs_customers SET last_order_at')) {
                const id = params[2];
                const row = [...customers.values()].find((c) => c.customer_id === id);
                if (row) {
                    row.last_order_at = params[0];
                    row.updated_at = params[1];
                }
            }
        },
        getSettings() {
            return this._settings || {};
        },
    };
}

test('normalizePhoneDigits strips non-digits', () => {
    assert.equal(normalizePhoneDigits('(403) 555-1234'), '4035551234');
});

test('isCsCrmEnabled defaults off; isCsCrmActive needs CS_Full', () => {
    assert.equal(isCsCrmEnabled({}), false);
    assert.equal(isCsCrmEnabled({ Cs_Crm_Enabled: '1' }), true);
    assert.equal(isCsCrmActive({ Cs_Crm_Enabled: '1' }), false);
    assert.equal(isCsCrmActive({ Cs_Crm_Enabled: '1', Cs_Full_Enabled: '1' }), true);
});

test('findOrCreateCustomer creates then finds by phone', () => {
    const db = makeDb();
    const a = findOrCreateCustomer(db, { name: 'SMITH', phone: '403-555-9999', now: '2026-07-18T12:00:00Z' });
    assert.ok(a.customer_id);
    assert.equal(a.phone_digits, '4035559999');
    const b = findOrCreateCustomer(db, { name: 'J SMITH', phone: '4035559999', now: '2026-07-18T13:00:00Z' });
    assert.equal(b.customer_id, a.customer_id);
    assert.equal(b.display_name, 'J SMITH');
});

test('searchCustomers by name and phone', () => {
    const db = makeDb();
    findOrCreateCustomer(db, { name: 'ADA LOVELACE', phone: '7805551111' });
    findOrCreateCustomer(db, { name: 'BOB', phone: '7805552222' });
    assert.equal(searchCustomers(db, 'ADA').length, 1);
    assert.equal(searchCustomers(db, '5551').length, 1);
    assert.equal(searchCustomers(db, 'x').length, 0);
});

test('updateCustomer saves notes and prefs', () => {
    const db = makeDb();
    const c = findOrCreateCustomer(db, { name: 'PAT', phone: '4035550001' });
    const updated = updateCustomer(db, c.customer_id, { notes: 'VIP', prefs: 'always dairy' });
    assert.equal(updated.notes, 'VIP');
    assert.equal(updated.prefs, 'always dairy');
});

test('linkOrderToCustomer only when CRM + CS_Full and betacs', () => {
    const db = makeDb();
    assert.equal(linkOrderToCustomer(db, {}, { source: 'betacs', contact: '4035557777', customer: 'X' }, 't'), null);
    const id = linkOrderToCustomer(
        db,
        { Cs_Crm_Enabled: '1', Cs_Full_Enabled: '1' },
        { source: 'betacs', contact: '403-555-7777', customer: 'X' },
        '2026-07-18T14:00:00Z',
    );
    assert.ok(id);
    const profile = getCustomerProfile(db, id);
    assert.equal(profile.customer.display_name, 'X');
});
