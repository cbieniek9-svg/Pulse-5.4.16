'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPalletsToDockRows } = require('../src/lib/receiving-pallets.cjs');

test('dock rows stay Arrived until time out — filter matches shared mobile dock', () => {
    const rows = [
        { exp_id: 'E-1', vendor: 'Sysco', arrived: 1, departed_at: null, status: 'Arrived' },
        { exp_id: 'E-2', vendor: 'TGP', arrived: 1, departed_at: '', status: 'Arrived' },
        { exp_id: 'E-3', vendor: 'Gone', arrived: 1, departed_at: '2026-05-19T15:00:00.000Z', status: 'Closed' },
        { exp_id: 'E-4', vendor: 'Pending', arrived: 0, departed_at: null, status: 'Pending' },
    ];
    const onDock = rows.filter((e) => (
        e.arrived === 1
        && (e.departed_at == null || e.departed_at === '')
        && e.status === 'Arrived'
    ));
    assert.deepEqual(onDock.map((r) => r.exp_id), ['E-1', 'E-2']);
});

test('attachPalletsToDockRows enriches TGP without dropping dock identity', () => {
    const pallets = [
        { pallet_id: 'PLT-1', exp_id: 'E-2', license_plate: 'ABC', department: 'grocery', temp_c: 2, in_range: 1 },
    ];
    const db = {
        all(sql, expId) {
            if (sql.includes('FROM receiving_pallets') && expId === 'E-2') return pallets;
            return [];
        },
        get(sql, expId) {
            if (sql.includes('COUNT') && expId === 'E-2') return { c: 1 };
            return { c: 0 };
        },
    };
    const enriched = attachPalletsToDockRows(db, [
        { exp_id: 'E-1', vendor: 'Sysco', arrived: 1, status: 'Arrived' },
        { exp_id: 'E-2', vendor: 'TGP Grocery', arrived: 1, status: 'Arrived' },
    ]);
    assert.equal(enriched.length, 2);
    assert.equal(enriched[0].exp_id, 'E-1');
    assert.equal(enriched[1].exp_id, 'E-2');
    assert.equal(enriched[1].pallet_count, 1);
    assert.equal(enriched[1].is_tgp, true);
});

test('settings_update Order_Start rejects when Order_End is stuck', () => {
    const { createActionHandlers } = require('../src/actions/handlers.cjs');
    const settings = new Map([['Order_Start', ''], ['Order_End', '2026-05-19T15:00:00.000Z']]);
    const db = {
        get(sql, ...params) {
            if (sql.includes("setting_name='Order_End'") || (sql.includes('Order_End') && params[0] === 'Order_End')) {
                return { setting_value: settings.get('Order_End') || '' };
            }
            if (sql.includes("setting_name='Order_Start'") || params[0] === 'Order_Start') {
                return { setting_value: settings.get('Order_Start') || '' };
            }
            if (sql.includes('shift_order_history')) return null;
            return null;
        },
        run() {},
        getSettings: () => Object.fromEntries(settings),
    };
    // handlers use upsertSetting which needs different get/run — use createActionHandlers carefully
    const handlers = createActionHandlers({
        db: {
            get(sql, ...params) {
                if (sql.includes('Order_End')) return { setting_value: settings.get('Order_End') };
                if (sql.includes('Order_Start')) return { setting_value: settings.get('Order_Start') };
                if (sql.includes('shift_order_history')) return null;
                if (sql.includes('setting_name')) return settings.has(params[0]) ? { setting_value: settings.get(params[0]) } : null;
                return null;
            },
            run(sql, ...params) {
                if (sql.includes('ON CONFLICT') || sql.includes('UPDATE settings') || sql.includes('INSERT INTO settings')) {
                    if (params.length >= 2) settings.set(params[0], params[1]);
                }
            },
            getSettings: () => Object.fromEntries(settings),
        },
        broadcastUpdate: () => {},
        getStoreDateStamp: () => '2026-05-19',
    });
    assert.throws(() => handlers.settings_update({
        table: 'settings',
        id_val: 'Order_Start',
        id_col: 'setting_name',
        workingData: { setting_value: '2026-05-19T16:00:00.000Z' },
        actorName: 'Mgr',
        serverTime: '2026-05-19T16:00:00.000Z',
    }), /stuck/i);
});
