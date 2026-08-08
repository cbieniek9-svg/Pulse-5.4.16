const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assembleReportsPayload } = require('../src/dal/reports-payload.cjs');
const { createActionHandlers } = require('../src/actions/handlers.cjs');

function makeReportsDb({ settings = {}, counts = {}, history = [] } = {}) {
    return {
        getSettings: () => settings,
        get(sql, ...params) {
            if (sql.includes('FROM counts')) return { id: 1, grocery: 0, frozen: 0, hardware: 0, staff: 1, ...counts };
            if (sql.includes('FROM shift_order_history') && sql.includes('WHERE store_date')) {
                return history.find((row) => row.store_date === params[0]);
            }
            if (sql.includes('COUNT(*) as c')) return { c: 0 };
            if (sql.includes('SUM(')) return { t: 0 };
            if (sql.includes("date(?, '-1 day')")) return { d: '2026-05-16' };
            return {};
        },
        all(sql) {
            if (sql.includes('FROM shift_order_history')) return history;
            return [];
        },
    };
}

test('reports use archived order metrics for the report date instead of live counts', () => {
    const archivedSundayOrder = {
        store_date: '2026-05-17',
        order_start: '2026-05-17T14:00:00.000Z',
        order_end: '2026-05-17T16:00:00.000Z',
        recorded_at: '2026-05-17T16:00:00.000Z',
        grocery_pieces: 100,
        frozen_pieces: 20,
        hardware_pieces: 5,
        total_pieces: 125,
        staff_count: 2,
        standard_hours: 2.28,
        actual_order_minutes: 120,
        actual_pieces_per_hour: 62.5,
    };

    const payload = assembleReportsPayload({
        targetDb: makeReportsDb({
            settings: {
                Order_Start: '2026-05-19T13:00:00.000Z',
                Order_End: '',
                Cases_Per_Hour: '55',
                Hardware_CPH: '50',
            },
            counts: { grocery: 900, frozen: 100, hardware: 0, staff: 3 },
            history: [archivedSundayOrder],
        }),
        APP_VERSION: '3.1.4',
        liveStoreDate: '2026-05-19',
        queryDate: '2026-05-17',
    });

    assert.equal(payload.order_today.start, archivedSundayOrder.order_start);
    assert.equal(payload.order_today.end, archivedSundayOrder.order_end);
    assert.equal(payload.order_metrics.total_pieces, 125);
    assert.equal(payload.order_metrics.staff_count, 2);
    assert.equal(payload.order_metrics.actual_order_minutes, 120);
    assert.equal(payload.order_metrics.standard_pieces_per_hour, 55);
    assert.equal(payload.order_metrics.team_pph, 62.5);
    assert.equal(payload.order_metrics.per_person_pph, 31.3);
    assert.equal(payload.order_metrics.adjusted_per_person_pph, 35.7);
    assert.equal(payload.order_metrics.break_deduction_hours_per_person, 0.25);
    assert.equal(payload.order_shift_history[0].team_pph, 62.5);
    assert.equal(payload.order_shift_history[0].per_person_pph, 31.3);
    assert.equal(payload.order_shift_history[0].adjusted_per_person_pph, 35.7);
    assert.equal(payload.order_shift_history[0].standard_pieces_per_hour, 55);
});

test('reports include weekly order scorecard from clock days only', () => {
    const payload = assembleReportsPayload({
        targetDb: makeReportsDb({
            settings: { Cases_Per_Hour: '55', Hardware_CPH: '50' },
            history: [
                {
                    store_date: '2026-05-13',
                    order_start: '2026-05-13T14:00:00.000Z',
                    order_end: '2026-05-13T16:00:00.000Z',
                    total_pieces: 600,
                    staff_count: 2,
                    actual_order_minutes: 120,
                    actual_pieces_per_hour: 300,
                    adjusted_per_person_pph: 160,
                },
                {
                    store_date: '2026-05-14',
                    order_start: '2026-05-14T14:00:00.000Z',
                    order_end: '',
                    total_pieces: 400,
                    staff_count: 2,
                    actual_order_minutes: 0,
                },
            ],
        }),
        APP_VERSION: '4.2.2',
        liveStoreDate: '2026-05-19',
        queryDate: '2026-05-19',
    });

    assert.equal(payload.order_weekly_scorecard.order_days, 1);
    assert.equal(payload.order_weekly_scorecard.overall.avg_pieces, 600);
    assert.ok(payload.order_weekly_scorecard.by_weekday.some((row) => row.order_days === 1));
});

test('finishing the live order clock archives the current piece counts immediately', () => {
    const settings = {
        Order_Start: '2026-05-17T14:00:00.000Z',
        Order_End: '',
        Cases_Per_Hour: '55',
        Hardware_CPH: '50',
        Hardware_Arrived: '1',
    };
    const counts = { grocery: 100, frozen: 20, hardware: 5, staff: 2 };
    const writes = [];
    const broadcasts = [];
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ ...counts }),
        run(sql, ...params) {
            writes.push({ sql, params });
            if (sql.includes('INSERT INTO settings') && sql.includes('ON CONFLICT')) {
                settings[params[0]] = params[1];
                return;
            }
            if (sql.includes("setting_name IN ('Order_Start','Order_End')")) {
                settings.Order_Start = '';
                settings.Order_End = '';
                return;
            }
            if (sql.includes('UPDATE settings')) settings.Order_End = params[0];
        },
    };

    const handlers = createActionHandlers({
        db,
        broadcastUpdate: (delta) => broadcasts.push(delta),
        getStoreDateStamp: () => '2026-05-17',
    });

    handlers.settings_update({
        table: 'settings',
        id_col: 'setting_name',
        id_val: 'Order_End',
        workingData: { setting_value: '2026-05-17T16:00:00.000Z' },
        serverTime: '2026-05-17T16:00:00.000Z',
    });

    const historyWrite = writes.find((write) => write.sql.includes('shift_order_history'));
    assert.ok(historyWrite, 'expected an order history snapshot write');
    // Dry finish: grocery+hardware; frozen_pieces deferred until frozen clock finish.
    assert.deepEqual(historyWrite.params.slice(0, 15), [
        '2026-05-17',
        '2026-05-17T14:00:00.000Z',
        '2026-05-17T16:00:00.000Z',
        '2026-05-17T16:00:00.000Z',
        100,
        0,
        5,
        105,
        2,
        1.92,
        120,
        52.5,
        0.25,
        3.5,
        30,
    ]);
    const clockClears = writes.filter((write) =>
        write.sql.includes('INSERT INTO settings')
        && write.sql.includes('ON CONFLICT')
        && write.params[0] === 'Order_Start'
        && write.params[1] === ''
    );
    assert.equal(clockClears.length, 1);
    assert.equal(settings.Order_Start, '');
    assert.equal(settings.Order_End, '');
    assert.equal(broadcasts.length, 1);
});

test('finishing the live order clock excludes hardware when not marked arrived', () => {
    const settings = {
        Order_Start: '2026-05-17T14:00:00.000Z',
        Order_End: '',
        Cases_Per_Hour: '55',
        Hardware_CPH: '50',
        Hardware_Arrived: '0',
    };
    const counts = { grocery: 100, frozen: 20, hardware: 5, staff: 2 };
    const writes = [];
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ ...counts }),
        run(sql, ...params) {
            writes.push({ sql, params });
            if (sql.includes('INSERT INTO settings') && sql.includes('ON CONFLICT')) {
                settings[params[0]] = params[1];
                return;
            }
            if (sql.includes("setting_name IN ('Order_Start','Order_End')")) {
                settings.Order_Start = '';
                settings.Order_End = '';
            }
            if (sql.includes('UPDATE settings')) settings.Order_End = params[0];
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
    const historyWrite = writes.find((write) => write.sql.includes('shift_order_history'));
    assert.ok(historyWrite);
    assert.equal(historyWrite.params[6], 0, 'hardware column is zero when not marked arrived');
    assert.equal(historyWrite.params[7], 100, 'dry total is grocery only until frozen finish');
    assert.equal(historyWrite.params[11], 50, 'dry team PPH uses grocery only');
});

test('EOD skips order history when the shift was already archived on finish', () => {
    const {
        resolveOrderStoreDate,
        isOrderAlreadyArchived,
    } = require('../src/lib/order-history-archive.cjs');

    const history = [{ store_date: '2026-05-17', order_end: '2026-05-17T16:00:00.000Z' }];
    const db = {
        get(sql, storeDate) {
            if (sql.includes('FROM shift_order_history')) {
                return history.find((row) => row.store_date === storeDate) || null;
            }
            return null;
        },
    };
    const getStoreDateStamp = (date) => date.toISOString().slice(0, 10);
    const os = '2026-05-17T14:00:00.000Z';
    const oe = '2026-05-17T16:00:00.000Z';
    const storeDate = resolveOrderStoreDate(os, oe, getStoreDateStamp);

    assert.equal(storeDate, '2026-05-17');
    assert.equal(isOrderAlreadyArchived(db, storeDate), true);
});

test('manager report labels order history columns for compact PPH view', () => {
    const root = path.join(__dirname, '..', 'public', 'js', 'reports', 'sections');
    const orderHistoryPath = path.join(root, 'order-history.js');
    const rosterPath = path.join(root, 'roster-suggestions.js');
    if (!fs.existsSync(orderHistoryPath) || !fs.existsSync(rosterPath)) {
        // Legacy reports JS was removed; React reports own this UI now.
        return;
    }
    const orderHistory = fs.readFileSync(orderHistoryPath, 'utf8');
    const rosterSuggestions = fs.readFileSync(rosterPath, 'utf8');

    assert.match(orderHistory, /ORDER CREW/);
    assert.match(orderHistory, /hist-staff-roster/);
    assert.match(orderHistory, /team · \$\{adjPerson\.toFixed\(1\)\} adj\/person/);
    assert.match(rosterSuggestions, /ORDER CREW PERFORMANCE — BY ROSTER/);
    assert.match(rosterSuggestions, /SUGGESTED ORDER CREWS — BY ORDER DAY/);
});

test('application version stays synchronized with package metadata', () => {
    const { APP_VERSION } = require('../src/app-version.cjs');
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

    assert.match(APP_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(pkg.version, APP_VERSION);
});

test('historical reports null out live-only counts and flag missing archive', () => {
    const oosQueries = [];
    const payload = assembleReportsPayload({
        targetDb: {
            getSettings: () => ({ Cases_Per_Hour: '55', Hardware_CPH: '50' }),
            get(sql, ...params) {
                if (sql.includes('FROM counts')) return { id: 1, grocery: 900, frozen: 100, hardware: 0, staff: 3 };
                if (sql.includes('COUNT(*) as c')) return { c: 0 };
                if (sql.includes('SUM(')) return { t: 0 };
                if (sql.includes("date(?, '-1 day')")) return { d: '2026-05-16' };
                if (sql.includes('rhythm_tasks') && sql.includes('TGP Order')) return null;
                return {};
            },
            all(sql, ...params) {
                if (sql.includes('oos') && sql.includes('-30 days')) {
                    oosQueries.push(params);
                }
                if (sql.includes('FROM shift_order_history')) return [];
                return [];
            },
        },
        APP_VERSION: '4.2.4',
        liveStoreDate: '2026-05-19',
        queryDate: '2026-05-17',
        getStoreClockPayload: () => ({ storeWeekday: 'Monday', storeTime: '12:00' }),
    });

    assert.equal(payload.meta.isLiveToday, false);
    assert.equal(payload.shift.tasks_open, null);
    assert.equal(payload.shift.orders_open, null);
    assert.equal(payload.shift.vendors_pending, null);
    assert.equal(payload.order_metrics.archive_missing, true);
    assert.equal(payload.order_today.archive_missing, true);
    assert.ok(payload.finish_archive_health);
    assert.ok(Array.isArray(payload.report_actions));
    assert.ok(oosQueries.length >= 1);
    assert.ok(oosQueries.every((p) => p.includes('2026-05-17')));
});
