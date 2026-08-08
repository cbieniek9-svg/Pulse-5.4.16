const test = require('node:test');
const assert = require('node:assert/strict');
const { executeOrderFinish } = require('../src/lib/order-finish.cjs');
const { resolveOrderStaffCount } = require('../src/lib/shift-metrics.cjs');
const { createActionHandlers } = require('../src/actions/handlers.cjs');

/** Apply INSERT…ON CONFLICT settings writes from upsertSetting into an in-memory map. */
function applySettingsUpsert(settings, sql, params) {
    if (!sql.includes('INSERT INTO settings') || !sql.includes('ON CONFLICT')) return false;
    settings[params[0]] = params[1];
    return true;
}

test('resolveOrderStaffCount prefers counts.staff then active roster', () => {
    assert.equal(resolveOrderStaffCount({ staff: 5 }), 5);
    assert.equal(resolveOrderStaffCount({ staff: 0 }, {
        get: () => ({ c: 8 }),
    }), 8);
    assert.equal(resolveOrderStaffCount({ staff: 0 }, null), 1);
});

test('executeOrderFinish archives with explicit staff and hardware flag', () => {
    const settings = {
        Order_Start: '2026-05-20T13:00:00.000Z',
        Order_End: '',
        Cases_Per_Hour: '55',
        Hardware_CPH: '50',
        Hardware_Arrived: '0',
    };
    const counts = { grocery: 700, frozen: 60, hardware: 20, staff: 0 };
    const writes = [];
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ ...counts }),
        transaction: (fn) => fn,
        run(sql, ...params) {
            writes.push({ sql, params });
            if (applySettingsUpsert(settings, sql, params)) return;
            if (sql.includes('UPDATE counts SET staff')) counts.staff = params[0];
        },
    };

    const result = executeOrderFinish(db, {
        staffCount: 6,
        hardwareArrived: true,
        orderEnd: '2026-05-20T21:00:00.000Z',
        serverTime: '2026-05-20T21:00:00.000Z',
        getStoreDateStamp: () => '2026-05-20',
    });

    assert.equal(result.staffCount, 6);
    assert.equal(result.hardwareArrived, true);
    assert.equal(counts.staff, 6);
    assert.equal(settings.Hardware_Arrived, '1');
    assert.equal(settings.Order_Start, '');
    // Dry finish archives grocery+hardware only; frozen stays for frozen clock finish.
    assert.equal(result.teamPph, 720 / 8);
    assert.ok(result.adjustedPerPersonPph < result.teamPph);

    const historyWrite = writes.find((w) => w.sql.includes('shift_order_history'));
    assert.ok(historyWrite);
    assert.equal(historyWrite.params[8], 6, 'staff_count stored on archive row');
    assert.equal(historyWrite.params[7], 720, 'dry total is grocery+hardware (frozen deferred)');
    assert.equal(historyWrite.params[5], 0, 'frozen_pieces left for frozen finish');
});

test('executeOrderFinish persists exceptionReason on the archive row and result', () => {
    const settings = {
        Order_Start: '2026-05-20T13:00:00.000Z',
        Order_End: '',
        Cases_Per_Hour: '55',
        Hardware_CPH: '50',
        Hardware_Arrived: '0',
    };
    const counts = { grocery: 300, frozen: 0, hardware: 0, staff: 2 };
    const writes = [];
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ ...counts }),
        transaction: (fn) => fn,
        run(sql, ...params) {
            writes.push({ sql, params });
            applySettingsUpsert(settings, sql, params);
        },
    };

    const result = executeOrderFinish(db, {
        staffCount: 2,
        hardwareArrived: false,
        orderEnd: '2026-05-20T18:00:00.000Z',
        serverTime: '2026-05-20T18:00:00.000Z',
        getStoreDateStamp: () => '2026-05-20',
        exceptionReason: '  Truck late / early — vendor 2h behind  ',
    });

    assert.equal(result.exceptionReason, 'Truck late / early — vendor 2h behind', 'reason trimmed on result');
    const historyWrite = writes.find((w) => w.sql.includes('shift_order_history'));
    assert.ok(historyWrite);
    assert.equal(
        historyWrite.params[18],
        'Truck late / early — vendor 2h behind',
        'exception_reason stored as last archive param (trimmed)',
    );
});

test('executeOrderFinish leaves exception_reason null when not provided (idempotent re-archive safe)', () => {
    const settings = {
        Order_Start: '2026-05-20T13:00:00.000Z',
        Order_End: '',
        Cases_Per_Hour: '55',
        Hardware_CPH: '50',
        Hardware_Arrived: '0',
    };
    const counts = { grocery: 300, frozen: 0, hardware: 0, staff: 2 };
    const writes = [];
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ ...counts }),
        transaction: (fn) => fn,
        run(sql, ...params) {
            writes.push({ sql, params });
            applySettingsUpsert(settings, sql, params);
        },
    };

    const result = executeOrderFinish(db, {
        staffCount: 2,
        hardwareArrived: false,
        orderEnd: '2026-05-20T18:00:00.000Z',
        serverTime: '2026-05-20T18:00:00.000Z',
        getStoreDateStamp: () => '2026-05-20',
    });

    assert.equal(result.exceptionReason, '', 'result reason defaults to empty string');
    const historyWrite = writes.find((w) => w.sql.includes('shift_order_history'));
    assert.equal(historyWrite.params[18], null, 'null reason preserves existing via COALESCE on re-archive');
});

test('executeOrderFinish still STOPS the clock when end is before start (un-stoppable-clock guard)', () => {
    // Regression for the live v4 report: a future/skewed Order_Start must never make
    // the order clock impossible to finish. Finishing must always clear the clock.
    const settings = {
        Order_Start: '2026-05-20T23:00:00.000Z', // start AFTER the end below (clock skew)
        Order_End: '',
        Cases_Per_Hour: '55',
        Hardware_CPH: '50',
        Hardware_Arrived: '0',
    };
    const counts = { grocery: 100, frozen: 0, hardware: 0, staff: 3 };
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ ...counts }),
        transaction: (fn) => fn,
        run(sql, ...params) {
            applySettingsUpsert(settings, sql, params);
        },
    };
    assert.doesNotThrow(() => executeOrderFinish(db, {
        staffCount: 3,
        hardwareArrived: false,
        orderEnd: '2026-05-20T21:00:00.000Z', // before start
        serverTime: '2026-05-20T21:00:00.000Z',
        getStoreDateStamp: () => '2026-05-20',
    }));
    assert.equal(settings.Order_Start, '', 'clock cleared even when end < start');
    assert.equal(settings.Order_End, '', 'order end cleared even when end < start');
});

test('executeOrderFinish rejects when clock is not running', () => {
    const db = {
        getSettings: () => ({ Order_Start: '' }),
        getCounts: () => ({}),
        transaction: (fn) => fn,
        run() {},
    };
    assert.throws(
        () => executeOrderFinish(db, {
            staffCount: 2,
            hardwareArrived: false,
            orderEnd: '2026-05-20T21:00:00.000Z',
            serverTime: '2026-05-20T21:00:00.000Z',
            getStoreDateStamp: () => '2026-05-20',
        }),
        /not running/i,
    );
});

test('settings_update Order_End still archives via executeOrderFinish fallback', () => {
    const settings = {
        Order_Start: '2026-05-17T14:00:00.000Z',
        Order_End: '',
        Cases_Per_Hour: '55',
        Hardware_CPH: '50',
        Hardware_Arrived: '1',
    };
    const counts = { grocery: 100, frozen: 20, hardware: 5, staff: 2 };
    const writes = [];
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ ...counts }),
        transaction: (fn) => fn,
        run(sql, ...params) {
            writes.push({ sql, params });
            applySettingsUpsert(settings, sql, params);
        },
    };
    const handlers = createActionHandlers({
        db,
        broadcastUpdate: () => {},
        getStoreDateStamp: () => '2026-05-17',
    });
    handlers.settings_update({
        table: 'settings',
        id_col: 'setting_name',
        id_val: 'Order_End',
        workingData: { setting_value: '2026-05-17T16:00:00.000Z' },
        serverTime: '2026-05-17T16:00:00.000Z',
    });
    assert.ok(writes.some((w) => w.sql.includes('shift_order_history')));
    // Regression guard (was the pre-v3.1.10 bug): finishing MUST stop the clock,
    // otherwise the order clock "would not stop" and keeps ticking on TV/mobile.
    assert.ok(
        writes.some((w) => w.sql.includes('INSERT INTO settings') && w.params[0] === 'Order_Start' && w.params[1] === ''),
        'legacy Order_End finish must clear the live clock',
    );
    assert.equal(settings.Order_Start, '', 'Order_Start cleared after legacy finish');
    assert.equal(settings.Order_End, '', 'Order_End cleared after legacy finish');
});
