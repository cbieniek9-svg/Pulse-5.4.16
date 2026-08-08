'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isPendingExpectedForStoreDate,
    filterPendingExpectedForStoreDate,
    normalizeExpectedDay,
} = require('../src/lib/expected-orders-day.cjs');

const getStoreDateStamp = (d = new Date()) => {
    const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Edmonton',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const parts = fmt.formatToParts(d).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
};

test('date-stamped expected_day matches store date only', () => {
    assert.equal(isPendingExpectedForStoreDate(
        { expected_day: '2026-07-11', exp_id: 'E-1' },
        '2026-07-11',
        'Saturday',
        getStoreDateStamp,
    ), true);
    assert.equal(isPendingExpectedForStoreDate(
        { expected_day: '2026-07-10', exp_id: 'E-1' },
        '2026-07-11',
        'Saturday',
        getStoreDateStamp,
    ), false);
});

test('legacy weekday rows only show when rhythm id is from today', () => {
    const today = getStoreDateStamp();
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Edmonton', weekday: 'long' }).format(new Date());
    const fresh = { expected_day: weekday, exp_id: `E-${Date.now()}-0` };
    const stale = { expected_day: weekday, exp_id: 'E-1700000000000-0' };

    assert.equal(isPendingExpectedForStoreDate(fresh, today, weekday, getStoreDateStamp), true);
    assert.equal(isPendingExpectedForStoreDate(stale, today, weekday, getStoreDateStamp), false);
});

test('normalizeExpectedDay keeps date stamps and coerces weekday names', () => {
    const stamp = () => '2026-07-11';
    assert.equal(normalizeExpectedDay('2026-07-10', stamp), '2026-07-10');
    assert.equal(normalizeExpectedDay('Monday', stamp), '2026-07-11');
    assert.equal(normalizeExpectedDay('', stamp), '2026-07-11');
});

test('filter drops no-show vendors from prior store dates', () => {
    const rows = [
        { vendor: 'Sysco', expected_day: '2026-07-09', exp_id: 'E-old' },
        { vendor: 'Coke', expected_day: '2026-07-11', exp_id: 'E-new' },
    ];
    const out = filterPendingExpectedForStoreDate(rows, '2026-07-11', 'Saturday', getStoreDateStamp);
    assert.equal(out.length, 1);
    assert.equal(out[0].vendor, 'Coke');
});
