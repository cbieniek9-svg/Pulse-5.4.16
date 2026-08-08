'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildManagerExceptions } = require('../src/lib/manager-exceptions.cjs');

test('flags missing FINISH on prior order day', () => {
    const db = {
        get(sql, day) {
            if (sql.includes('shift_order_history')) return null;
            if (sql.includes('rhythm_tasks') && day === 'Tuesday') return { ok: 1 };
            return null;
        },
        all() { return []; },
    };
    const items = buildManagerExceptions({
        db,
        storeDate: '2026-05-13',
        storeWeekday: 'Wednesday',
        storeTime: '07:00',
        kpis: {},
        tasks: [],
        kill_dates: [],
        settings: {},
        zoneHeatMap: {},
    });
    assert.ok(items.some((i) => i.kind === 'missing_finish'));
});

test('flags rhythm not loaded after 06:30', () => {
    const db = {
        get(sql) {
            if (sql.includes('Daily_Rhythm_Last_Loaded')) return null;
            return null;
        },
        all() { return []; },
    };
    const items = buildManagerExceptions({
        db,
        storeDate: '2026-05-21',
        storeWeekday: 'Wednesday',
        storeTime: '07:00',
        kpis: {},
        tasks: [],
        kill_dates: [],
        settings: {},
        zoneHeatMap: {},
    });
    assert.ok(items.some((i) => i.kind === 'rhythm_not_loaded'));
});
