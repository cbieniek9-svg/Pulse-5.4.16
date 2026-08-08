'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeWithinStoreHoursMinutes, orderSpansCalendarDay } = require('../src/lib/store-hours.cjs');

const settings = {
    Store_Open_Hour: '7',
    Store_Close_Weekday: '20',
    Store_Close_Sunday: '18',
    Store_Timezone: 'America/Edmonton',
};

test('clips order clock to store open hours', () => {
    // Same day 10:00–12:00 Edmonton ≈ 120 minutes within 7–20 window
    const mins = computeWithinStoreHoursMinutes(
        '2026-06-02T16:00:00.000Z',
        '2026-06-02T18:00:00.000Z',
        settings,
    );
    assert.ok(mins >= 100 && mins <= 130, `expected ~120 mins, got ${mins}`);
});

test('cross-midnight order counts store-hours on each day', () => {
    const spans = orderSpansCalendarDay(
        '2026-06-02T23:00:00.000Z',
        '2026-06-03T15:00:00.000Z',
        settings,
    );
    assert.equal(spans, true);
    const mins = computeWithinStoreHoursMinutes(
        '2026-06-02T23:00:00.000Z',
        '2026-06-03T15:00:00.000Z',
        settings,
    );
    assert.ok(mins > 0);
    assert.ok(mins < 24 * 60);
});
