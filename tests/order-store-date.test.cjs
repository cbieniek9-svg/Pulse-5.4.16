'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOrderStoreDate, computeOrderClockMetrics } = require('../src/lib/order-history-archive.cjs');

const settings = {
    Store_Open_Hour: '7',
    Store_Close_Weekday: '20',
    Store_Close_Sunday: '18',
    Store_Timezone: 'America/Edmonton',
};

test('order store date anchors to start day when finish is next calendar day', () => {
    const getStoreDateStamp = (date) => date.toISOString().slice(0, 10);
    const start = '2026-05-19T14:00:00.000Z';
    const end = '2026-05-20T16:00:00.000Z';
    assert.equal(resolveOrderStoreDate(start, end, getStoreDateStamp), '2026-05-19');
});

test('computeOrderClockMetrics uses store hours not raw span for cross-day orders', () => {
    const start = '2026-06-02T23:00:00.000Z';
    const end = '2026-06-03T15:00:00.000Z';
    const { rawClockMinutes, actualOrderMinutes, spansCalendarDay } = computeOrderClockMetrics(start, end, settings);
    assert.equal(spansCalendarDay, 1);
    assert.ok(rawClockMinutes > actualOrderMinutes);
    assert.ok(actualOrderMinutes > 0);
    assert.ok(actualOrderMinutes < 24 * 60);
});
