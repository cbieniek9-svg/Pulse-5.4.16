'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActionHandlers } = require('../src/actions/handlers.cjs');
const { wantsReceivingTask, isTgpVendor, orderRequestedWorkTask, ALL_STAFF_ASSIGNEE } = require('../src/lib/receiving-flow.cjs');

test('isTgpVendor matches TGP-prefixed vendors only', () => {
    assert.equal(isTgpVendor('TGP'), true);
    assert.equal(isTgpVendor('TGP Grocery'), true);
    assert.equal(isTgpVendor('Sysco'), false);
});

test('wantsReceivingTask defaults true unless explicitly disabled', () => {
    assert.equal(wantsReceivingTask({}), true);
    assert.equal(wantsReceivingTask({ create_task: '1' }), true);
    assert.equal(wantsReceivingTask({ create_task: '0' }), false);
    assert.equal(wantsReceivingTask({ create_task: false }), false);
});

test('orderRequestedWorkTask applies to TGP and non-TGP from request body', () => {
    assert.equal(orderRequestedWorkTask({ vendor: 'Sysco', create_task: 0 }, { create_task: '1' }), true);
    assert.equal(orderRequestedWorkTask({ vendor: 'Sysco', create_task: 0 }, { create_task: '0' }), false);
    assert.equal(orderRequestedWorkTask({ vendor: 'TGP Grocery', create_task: 0 }, { create_task: '1' }), true);
    assert.equal(orderRequestedWorkTask({ vendor: 'TGP Grocery', create_task: 0 }, { create_task: '0' }), false);
});

function makeReceivingDb() {
    const orders = new Map([
        ['E-1', { exp_id: 'E-1', vendor: 'Sysco', arrived: 0, arrived_at: null, departed_at: null, status: 'Pending', create_task: 0 }],
        ['E-2', { exp_id: 'E-2', vendor: 'On Dock', arrived: 1, arrived_at: '2026-05-19T14:00:00.000Z', arrived_by: 'Sam', departed_at: null, status: 'Arrived', create_task: 0 }],
        ['E-3', { exp_id: 'E-3', vendor: 'TGP', arrived: 1, arrived_at: '2026-05-19T12:00:00.000Z', arrived_by: 'Sam', departed_at: null, status: 'Arrived', create_task: 0 }],
    ]);
    const tasks = new Map();
    const stats = [];
    const pallets = new Map();
    const settings = new Map([['Order_Start', '']]);
    const db = {
        get(sql, id) {
            if (sql.includes('FROM expected_orders')) return orders.get(id) ? { ...orders.get(id) } : null;
            if (sql.includes('FROM tasks')) return tasks.get(id) ? { ...tasks.get(id) } : null;
            if (sql.includes('FROM receiving_pallets') && sql.includes('COUNT')) {
                const count = [...pallets.values()].filter((p) => p.exp_id === id).length;
                return { c: count };
            }
            if (sql.includes("setting_name='Order_Start'")) return { setting_value: settings.get('Order_Start') || '' };
            if (sql.includes("setting_name='Order_End'")) return { setting_value: settings.get('Order_End') || '' };
            if (sql.includes('FROM shift_order_history')) return settings.get('_finishedToday') || null;
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE expected_orders') && sql.includes('arrived_at')) {
                const id = params[params.length - 1];
                const row = orders.get(id);
                if (row) {
                    const hasVendor = /SET\s+vendor=\?/i.test(sql);
                    let i = 0;
                    if (hasVendor) row.vendor = params[i++];
                    row.arrived = 1;
                    row.arrived_at = params[i++];
                    row.arrived_by = params[i++];
                    row.status = 'Arrived';
                }
            }
            if (sql.includes('UPDATE expected_orders') && sql.includes('departed_at')) {
                const id = params[params.length - 1];
                const row = orders.get(id);
                if (row) {
                    const hasVendor = /SET\s+vendor=\?/i.test(sql);
                    let i = 0;
                    if (hasVendor) row.vendor = params[i++];
                    row.departed_at = params[i++];
                    row.departed_by = params[i++];
                    row.status = 'Closed';
                }
            }
            if (sql.includes('INSERT INTO expected_orders')) {
                const expId = params[0];
                const vendor = params[1];
                orders.set(expId, {
                    exp_id: expId, vendor, arrived: 1, arrived_at: params[params.length - 2], arrived_by: params[params.length - 1],
                    departed_at: null, status: 'Arrived', create_task: 0,
                });
            }
            if (sql.includes('INSERT INTO tasks') || sql.includes('INSERT OR IGNORE INTO tasks')) {
                const taskId = params[0];
                tasks.set(taskId, {
                    task_id: taskId,
                    task_detail: params[1],
                    status: params[2],
                    priority: params[3],
                    zone: params[4],
                    assigned_to: params[5],
                    time_submitted: params[6],
                    related_id: params[7],
                });
            }
            if (sql.includes('INSERT INTO settings') && sql.includes('ON CONFLICT')) {
                settings.set(params[0], params[1]);
            }
            if (sql.includes('UPDATE settings SET setting_value')) {
                if (sql.includes("setting_name='Order_End'") || (params[1] === undefined && sql.includes('Order_End'))) {
                    // no-op path
                }
                // Legacy UPDATE path (kept for older call sites in the mock)
                if (sql.includes("setting_name='Order_Start'")) settings.set('Order_Start', params[0]);
            }
            if (sql.includes('UPDATE tasks SET status')) {
                const taskId = params[2];
                tasks.set(taskId, {
                    ...(tasks.get(taskId) || {}),
                    status: 'Closed',
                    time_closed: params[0],
                    closed_by: params[1],
                });
            }
            if (sql.includes('UPDATE tasks') && sql.includes("status='Open'")) {
                const taskId = params[params.length - 1];
                tasks.set(taskId, {
                    ...(tasks.get(taskId) || {}),
                    task_id: taskId,
                    task_detail: params[0],
                    status: 'Open',
                    priority: 'Urgent',
                    zone: 'Receiving',
                    assigned_to: params[1],
                    time_submitted: params[2],
                    related_id: params[3],
                });
            }
            if (sql.includes('INSERT OR REPLACE INTO receiving_stats')) {
                stats.push({ vendor: params[1], arrival: params[2], completion: params[3], duration: params[4] });
            }
            if (sql.includes('INSERT INTO receiving_pallets')) {
                pallets.set(params[0], { pallet_id: params[0], exp_id: params[1] });
            }
        },
        transaction(fn) {
            return () => fn();
        },
    };
    return { db, orders, tasks, stats, settings, pallets };
}

test('time in does not create receiving task', () => {
    const { db, tasks } = makeReceivingDb();
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_arrived({
        id_val: 'E-1',
        workingData: { create_task: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T15:00:00.000Z',
    });
    assert.equal(tasks.size, 0);
});

test('time out writes receiving duration stat', () => {
    const { db, stats } = makeReceivingDb();
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-2',
        workingData: { storage_confirmed: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T14:30:00.000Z',
    });
    assert.equal(stats.length, 1);
    assert.equal(stats[0].vendor, 'On Dock');
    assert.equal(stats[0].duration, 30);
});

test('non-TGP time out creates Unassigned work task without starting clock', () => {
    const { db, tasks, orders, settings } = makeReceivingDb();
    orders.set('E-4', {
        exp_id: 'E-4',
        vendor: 'Sysco',
        arrived: 1,
        arrived_at: '2026-05-19T14:00:00.000Z',
        arrived_by: 'Sam',
        departed_at: null,
        status: 'Arrived',
        create_task: 0,
    });
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-4',
        workingData: { create_task: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T14:30:00.000Z',
    });
    assert.equal(settings.get('Order_Start'), '');
    const work = tasks.get('T-WORK-E-4');
    assert.ok(work);
    assert.equal(work.task_detail, 'Work Sysco order');
    assert.equal(work.assigned_to, 'Unassigned');
    assert.equal(work.status, 'Open');
});

test('non-TGP time out skips work task when unchecked', () => {
    const { db, tasks, orders } = makeReceivingDb();
    orders.set('E-5', {
        exp_id: 'E-5',
        vendor: 'Sysco',
        arrived: 1,
        arrived_at: '2026-05-19T14:00:00.000Z',
        arrived_by: 'Sam',
        departed_at: null,
        status: 'Arrived',
        create_task: 0,
    });
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-5',
        workingData: { create_task: '0' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T14:30:00.000Z',
    });
    assert.equal(tasks.get('T-WORK-E-5'), undefined);
});

test('TGP time out requires pallet intake', () => {
    const { db } = makeReceivingDb();
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    assert.throws(() => handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-3',
        workingData: { create_task: '1', storage_confirmed: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T13:00:00.000Z',
    }), /at least one TGP pallet/);
});

test('TGP time out posts All Staff work task and starts clock when requested', () => {
    const { db, tasks, settings, pallets } = makeReceivingDb();
    pallets.set('PLT-1', { pallet_id: 'PLT-1', exp_id: 'E-3' });
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-3',
        workingData: { create_task: '1', start_order_clock: '1', storage_confirmed: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T13:00:00.000Z',
    });
    assert.equal(settings.get('Order_Start'), '2026-05-19T13:00:00.000Z');
    const work = tasks.get('T-TGP-E-3');
    assert.ok(work);
    assert.equal(work.task_detail, 'Work the TGP order');
    assert.equal(work.assigned_to, ALL_STAFF_ASSIGNEE);
    assert.equal(work.status, 'Open');
});

test('TGP time out can post work without starting clock', () => {
    const { db, tasks, settings, pallets } = makeReceivingDb();
    pallets.set('PLT-1', { pallet_id: 'PLT-1', exp_id: 'E-3' });
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-3',
        workingData: { create_task: '1', start_order_clock: '0', storage_confirmed: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T13:00:00.000Z',
    });
    assert.equal(settings.get('Order_Start'), '');
    assert.ok(tasks.get('T-TGP-E-3'));
});

test('TGP time out does not restart clock after order finished today', () => {
    const { db, settings, pallets } = makeReceivingDb();
    pallets.set('PLT-1', { pallet_id: 'PLT-1', exp_id: 'E-3' });
    settings.set('_finishedToday', { store_date: '2026-05-19', order_end: '2026-05-19T11:00:00.000Z' });
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-3',
        workingData: { create_task: '1', start_order_clock: '1', storage_confirmed: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T13:00:00.000Z',
    });
    assert.equal(settings.get('Order_Start'), '');
});

test('TGP create_task alone does not start the order clock', () => {
    const { db, tasks, settings, pallets } = makeReceivingDb();
    pallets.set('PLT-1', { pallet_id: 'PLT-1', exp_id: 'E-3' });
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-3',
        workingData: { create_task: '1', storage_confirmed: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T13:00:00.000Z',
    });
    assert.equal(settings.get('Order_Start'), '');
    assert.ok(tasks.get('T-TGP-E-3'));
});

test('TGP time out without work task does not start clock', () => {
    const { db, tasks, settings, pallets } = makeReceivingDb();
    pallets.set('PLT-1', { pallet_id: 'PLT-1', exp_id: 'E-3' });
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_mark_departed({
        id_val: 'E-3',
        workingData: { create_task: '0', storage_confirmed: '1' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T13:00:00.000Z',
    });
    assert.equal(settings.get('Order_Start'), '');
    assert.equal(tasks.get('T-TGP-E-3'), undefined);
});

test('adhoc arrival inserts checked-in vendor row', () => {
    const { db, orders } = makeReceivingDb();
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.expected_orders_receiving_log_arrival({
        workingData: { vendor: 'Surprise Vendor', expected_day: 'Monday' },
        actorName: 'Receiver',
        serverTime: '2026-05-19T16:00:00.000Z',
    });
    const rows = [...orders.values()].filter((r) => r.vendor === 'Surprise Vendor');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'Arrived');
});
