'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeDate,
    rowsToShiftRecords,
} = require('../src/lib/staff-schedule-import.cjs');

test('normalizeDate parses explicit YMD without UTC rollover', () => {
    assert.equal(normalizeDate('2026-06-27'), '2026-06-27');
    assert.equal(normalizeDate('6/27/2026'), '2026-06-27');
});

test('normalizeDate uses fallback year for month-day text', () => {
    assert.equal(normalizeDate('Jun 27', '2026'), '2026-06-27');
});

test('normalizeDate parses Excel serial numbers via excelSerialToDate', () => {
    assert.equal(normalizeDate(44927), '2023-01-01');
});

test('normalizeDate formats UTC-midnight Date cells without local off-by-one', () => {
    assert.equal(normalizeDate(new Date('2023-01-01T00:00:00.000Z')), '2023-01-01');
});

test('rowsToShiftRecords parses Center Store weekly grid', () => {
    const rows = [
        ['', '6/22', '6/23', '6/24', '6/25', '6/26', '6/27', '6/28'],
        ['Center Store', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        ['Izzy', 'OFF', '9:00-5:00', '9:00-5:00', '9:00-5:00', '9:00-5:00', 'OFF', '9:00-5:00'],
        ['Premium', 'OFF', 'PREMIUM', 'STOCK/FLOAT', 'REC', 'PREMIUM', 'OFF', 'PREMIUM'],
    ];
    const { shifts, errors } = rowsToShiftRecords(rows, 'WE Jun 22.csv', '2026-06-22T00:00:00.000Z', 'Test');
    assert.equal(errors.length, 0);
    assert.ok(shifts.some((r) => r.staff_name === 'Izzy' && r.shift_date === '2026-06-25' && r.department === 'REC'));
    assert.ok(shifts.some((r) => r.staff_name === 'Izzy' && r.shift_date === '2026-06-24' && r.department === 'STOCK/FLOAT'));
});
