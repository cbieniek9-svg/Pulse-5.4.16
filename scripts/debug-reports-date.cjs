'use strict';

const { assembleReportsPayload } = require('../src/dal/reports-payload.cjs');

function makeReportsDb({ settings = {}, counts = {}, history = [] } = {}) {
    return {
        getSettings: () => settings,
        get(sql, ...params) {
            if (sql.includes('FROM counts')) return { id: 1, grocery: 0, frozen: 0, hardware: 0, staff: 1, ...counts };
            if (sql.includes('FROM shift_order_history') && sql.includes('WHERE store_date')) {
                return history.find((row) => row.store_date === params[0]) || {};
            }
            if (sql.includes('COUNT(*) as c')) return { c: 0 };
            if (sql.includes('SUM(')) return { t: 0 };
            if (sql.includes("date(?, '-1 day')")) return { d: '2026-05-16' };
            if (sql.includes('rhythm_tasks') && sql.includes('TGP Order')) return null;
            return {};
        },
        all(sql) {
            if (sql.includes('FROM shift_order_history')) return history;
            if (sql.includes('FROM rhythm_tasks')) return [];
            if (sql.includes('FROM tasks')) return [];
            if (sql.includes('FROM kill_dates')) return [];
            if (sql.includes('homebase_audits')) return [];
            if (sql.includes('FROM oos')) return [];
            if (sql.includes('FROM settings')) return [];
            return [];
        },
    };
}

function tryCase(label, opts) {
    try {
        const p = assembleReportsPayload(opts);
        console.log('OK', label, p.meta?.reportDate, 'actions', p.report_actions?.length);
    } catch (e) {
        console.error('FAIL', label, e.message);
        console.error(e.stack);
    }
}

tryCase('range', {
    targetDb: makeReportsDb({
        settings: { Cases_Per_Hour: '55', Hardware_Crived: '50' },
        history: [{ store_date: '2026-05-17', order_start: 'a', order_end: 'b', total_pieces: 100, staff_count: 2, actual_order_minutes: 90 }],
    }),
    APP_VERSION: '4.2.2',
    liveStoreDate: '2026-05-19',
    queryStart: '2026-05-15',
    queryEnd: '2026-05-17',
    getStoreClockPayload: () => ({ storeWeekday: 'Monday', storeTime: '10:00' }),
    getHeatMap: () => ({}),
});

tryCase('single date', {
    targetDb: makeReportsDb({ settings: { Cases_Per_Hour: '55' } }),
    APP_VERSION: '4.2.2',
    liveStoreDate: '2026-05-19',
    queryDate: '2026-05-10',
    getStoreClockPayload: () => ({ storeWeekday: 'Monday', storeTime: '10:00' }),
    getHeatMap: () => ({}),
});
