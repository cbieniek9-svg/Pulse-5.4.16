const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOrderWeeklyScorecard, isCompleteOrderDay } = require('../src/lib/order-weekly-scorecard.cjs');

test('isCompleteOrderDay requires closed clock and positive duration', () => {
    assert.equal(isCompleteOrderDay({ store_date: '2026-05-13', order_start: 'a', order_end: 'b', actual_order_minutes: 90 }), true);
    assert.equal(isCompleteOrderDay({ store_date: '2026-05-13', order_start: 'a', order_end: '', actual_order_minutes: 90 }), false);
    assert.equal(isCompleteOrderDay({ store_date: '2026-05-13', order_start: 'a', order_end: 'b', actual_order_minutes: 0 }), false);
});

test('buildOrderWeeklyScorecard averages clock days and groups by weekday', () => {
    const scorecard = buildOrderWeeklyScorecard([
        {
            store_date: '2026-05-12',
            order_start: '2026-05-12T14:00:00.000Z',
            order_end: '2026-05-12T16:00:00.000Z',
            total_pieces: 600,
            staff_count: 2,
            actual_order_minutes: 120,
            team_pph: 300,
            adjusted_per_person_pph: 160,
        },
        {
            store_date: '2026-05-19',
            order_start: '2026-05-19T14:00:00.000Z',
            order_end: '2026-05-19T16:30:00.000Z',
            total_pieces: 800,
            staff_count: 3,
            actual_order_minutes: 150,
            team_pph: 320,
            adjusted_per_person_pph: 110,
        },
        {
            store_date: '2026-05-14',
            order_start: '2026-05-14T14:00:00.000Z',
            order_end: '',
            total_pieces: 500,
            staff_count: 2,
            actual_order_minutes: 0,
        },
    ]);

    assert.equal(scorecard.order_days, 2);
    assert.equal(scorecard.overall.avg_pieces, 700);
    assert.equal(scorecard.overall.avg_minutes, 135);
    assert.equal(scorecard.overall.avg_staff, 2.5);
    assert.equal(scorecard.overall.avg_team_pph, 310);
    assert.equal(scorecard.overall.avg_adj_pph, 135);

    const tuesday = scorecard.by_weekday.find((row) => row.weekday === 'Tuesday');
    assert.ok(tuesday);
    assert.equal(tuesday.order_days, 2);
    assert.equal(tuesday.avg_pieces, 700);
});
