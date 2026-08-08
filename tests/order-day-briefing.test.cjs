'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildOrderDayBriefing } = require('../src/lib/order-day-briefing.cjs');

test('summarizes same weekday history', () => {
    const history = [
        { store_date: '2026-05-05', order_start: 'a', order_end: 'b', total_pieces: 500, staff_count: 4, actual_order_minutes: 120 },
        { store_date: '2026-04-28', order_start: 'a', order_end: 'b', total_pieces: 600, staff_count: 5, actual_order_minutes: 130 },
    ];
    const db = {
        all(sql) {
            if (sql.includes('shift_order_history')) return history;
            return [];
        },
        get(sql, ...params) {
            if (sql.includes('rhythm_tasks') && params[0] === 'Tuesday') return { ok: 1 };
            if (sql.includes('expected_orders') && params[0] === '2026-05-12') {
                return { vendor: 'TGP Grocery' };
            }
            return null;
        },
    };
    const b = buildOrderDayBriefing(db, { storeDate: '2026-05-12', storeWeekday: 'Tuesday' });
    assert.equal(b.weekday, 'Tuesday');
    assert.equal(b.is_order_day, true);
    assert.equal(b.scheduled_order_day, true);
    assert.deepEqual(b.order_day_sources, ['tgp_weekday_schedule', 'received_tgp']);
    assert.equal(b.sample_count, 2);
    assert.equal(b.expected_pieces.avg, 550);
    assert.equal(b.recent_same_weekday.length, 2);
});

test('Sunday Tuesday Thursday are TGP order days even before clock or receiving activity', () => {
    const db = {
        all(sql) {
            if (sql.includes('shift_order_history')) return [];
            return [];
        },
        get() {
            return null;
        },
    };

    const b = buildOrderDayBriefing(db, { storeDate: '2026-05-19', storeWeekday: 'Tuesday' });
    assert.equal(b.scheduled_order_day, true);
    assert.equal(b.is_order_day, true);
    assert.deepEqual(b.order_day_sources, ['tgp_weekday_schedule']);
});

test('old rhythm cadence rows do not make non-TGP weekdays order days', () => {
    const db = {
        all(sql) {
            if (sql.includes('shift_order_history')) return [];
            return [];
        },
        get(sql, ...params) {
            if (sql.includes('rhythm_tasks') && params[0] === 'Monday') return { ok: 1 };
            return null;
        },
    };

    const b = buildOrderDayBriefing(db, { storeDate: '2026-05-18', storeWeekday: 'Monday' });
    assert.equal(b.scheduled_order_day, false);
    assert.equal(b.is_order_day, false);
    assert.deepEqual(b.order_day_sources, []);
});

test('pending scheduled TGP delivery does not make briefing an actual TGP order day', () => {
    const db = {
        all(sql) {
            if (sql.includes('shift_order_history')) return [];
            return [];
        },
        get(sql, ...params) {
            if (sql.includes('expected_orders')) {
                return null;
            }
            return null;
        },
    };

    const b = buildOrderDayBriefing(db, { storeDate: '2026-05-20', storeWeekday: 'Wednesday' });
    assert.equal(b.is_order_day, false);
    assert.deepEqual(b.order_day_sources, []);
});
