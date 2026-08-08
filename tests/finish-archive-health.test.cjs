'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFinishArchiveHealth } = require('../src/lib/finish-archive-health.cjs');

function mockDb({ history = [], orderWeekdays = ['Tuesday'] } = {}) {
    return {
        get(sql, day) {
            if (sql.includes('rhythm_tasks') && sql.includes('TGP Order')) {
                return orderWeekdays.includes(day) ? { ok: 1 } : null;
            }
            return null;
        },
        all(sql, start, end) {
            if (sql.includes('shift_order_history')) {
                return history.filter((r) => r.store_date >= start && r.store_date <= end);
            }
            return [];
        },
    };
}

function completeRow(store_date) {
    return {
        store_date,
        order_start: `${store_date}T14:00:00.000Z`,
        order_end: `${store_date}T16:00:00.000Z`,
        total_pieces: 500,
        staff_count: 2,
        actual_order_minutes: 120,
        actual_pieces_per_hour: 250,
    };
}

test('buildFinishArchiveHealth reports zero complete days when archive empty', () => {
    const health = buildFinishArchiveHealth(mockDb(), { asOfDate: '2026-05-19', windowDays: 14 });
    assert.equal(health.complete_order_days, 0);
    assert.equal(health.phase0_ready, false);
    assert.equal(health.scorecard_trust, 'building');
    assert.match(health.message, /No archived order days/i);
});

test('buildFinishArchiveHealth marks usable trust with enough complete days', () => {
    const history = [];
    for (let i = 1; i <= 10; i++) {
        history.push(completeRow(`2026-05-${String(i).padStart(2, '0')}`));
    }
    const health = buildFinishArchiveHealth(mockDb({ history, orderWeekdays: [] }), {
        asOfDate: '2026-05-10',
        windowDays: 56,
    });
    assert.equal(health.complete_order_days, 10);
    assert.equal(health.phase0_ready, true);
    assert.equal(health.scorecard_trust, 'usable');
});

test('buildFinishArchiveHealth lists incomplete archive rows', () => {
    const health = buildFinishArchiveHealth(mockDb({
        history: [{
            store_date: '2026-05-13',
            order_start: '2026-05-13T14:00:00.000Z',
            order_end: '',
            total_pieces: 100,
            staff_count: 2,
            actual_order_minutes: 0,
        }],
    }), { asOfDate: '2026-05-13', windowDays: 14 });
    assert.equal(health.incomplete_rows.length, 1);
    assert.equal(health.incomplete_rows[0].store_date, '2026-05-13');
});
