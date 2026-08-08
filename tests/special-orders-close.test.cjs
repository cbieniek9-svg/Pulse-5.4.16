'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    resolveCustomerOrderCloseStatus,
    canForceBetacsComplete,
    getMobileCustomerOrders,
} = require('../src/lib/special-orders.cjs');
const { createActionHandlers } = require('../src/actions/handlers.cjs');

test('resolveCustomerOrderCloseStatus maps legacy Closed', () => {
    assert.equal(resolveCustomerOrderCloseStatus({ source: null, status: 'Open' }, 'Closed'), 'Closed');
});

test('resolveCustomerOrderCloseStatus maps betacs Closed to Complete', () => {
    assert.equal(resolveCustomerOrderCloseStatus({ source: 'betacs', status: 'Ordered' }, 'Closed'), 'Complete');
    assert.equal(resolveCustomerOrderCloseStatus({ source: 'betacs', status: 'Ready' }, 'Closed'), 'Complete');
});

test('canForceBetacsComplete allows floor clear from Ordered', () => {
    assert.equal(canForceBetacsComplete('Ordered'), true);
    assert.equal(canForceBetacsComplete('Complete'), false);
});

test('special_orders_update accepts Closed on betacs Ordered row', () => {
    const rows = [{ order_id: 'O1', source: 'betacs', status: 'Ordered' }];
    const settings = { Betacs_Enabled: '1' };
    const db = {
        get(sql, id) {
            if (sql.includes('special_orders')) return rows.find((r) => r.order_id === id);
            if (sql.includes('settings')) return { setting_value: settings.Betacs_Enabled };
            return undefined;
        },
        getSettings: () => settings,
        run(sql, ...params) {
            if (sql.includes('UPDATE special_orders')) {
                const row = rows[0];
                row.status = params[0];
            }
        },
    };
    let broadcast = null;
    const handlers = createActionHandlers({ db, broadcastUpdate: (p) => { broadcast = p; } });
    handlers.special_orders_update({
        table: 'special_orders',
        workingData: { status: 'Closed' },
        id_col: 'order_id',
        id_val: 'O1',
        actorName: 'Luke',
        serverTime: '2026-06-08T12:00:00.000Z',
    });
    assert.equal(rows[0].status, 'Complete');
    assert.equal(broadcast?.data?.status, 'Complete');
});

test('getMobileCustomerOrders includes betacs Ordered when enabled', () => {
    const db = {
        all(sql, ...params) {
            if (sql.includes('status = ?') && params[0] === 'Open') {
                return [{ order_id: 'L1', status: 'Open', source: null }];
            }
            if (sql.includes("source = 'betacs'")) {
                return [
                    { order_id: 'B1', status: 'Ordered', source: 'betacs' },
                    { order_id: 'B2', status: 'Ready', source: 'betacs' },
                ];
            }
            return [];
        },
        getSettings: () => ({ Betacs_Enabled: '1' }),
    };
    const orders = getMobileCustomerOrders(db);
    assert.equal(orders.length, 3);
    assert.equal(orders[0].order_id, 'B2', 'Ready pickups sort first for floor clear');
    assert.ok(orders.some((o) => o.order_id === 'B1'));
});
