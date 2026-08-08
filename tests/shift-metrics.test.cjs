const test = require('node:test');
const assert = require('node:assert/strict');
const { computeShiftMetrics } = require('../src/lib/shift-metrics.cjs');

test('live shift PPH uses grocery and frozen; hardware only when arrived', () => {
    const start = new Date('2026-05-19T14:00:00.000Z');
    const now = new Date('2026-05-19T15:00:00.000Z');
    const off = computeShiftMetrics(
        { Order_Start: start.toISOString(), Order_End: '', Cases_Per_Hour: '55', Hardware_Arrived: '0' },
        { grocery: 100, frozen: 50, hardware: 25, staff: 3 },
        now,
    );
    assert.equal(off.shift_active, true);
    assert.equal(off.shift_total_pieces, 150);
    assert.equal(off.shift_pph, 150);
    assert.equal(off.order_staff, 3);

    const on = computeShiftMetrics(
        { Order_Start: start.toISOString(), Order_End: '', Cases_Per_Hour: '55', Hardware_Arrived: '1' },
        { grocery: 100, frozen: 50, hardware: 25, staff: 3 },
        now,
    );
    assert.equal(on.shift_total_pieces, 175);
    assert.equal(on.shift_pph, 175);
});

test('completed order uses clock span for final PPH', () => {
    const m = computeShiftMetrics(
        {
            Order_Start: '2026-05-19T14:00:00.000Z',
            Order_End: '2026-05-19T15:30:00.000Z',
            Cases_Per_Hour: '55',
        },
        { grocery: 110, frozen: 40, hardware: 0, staff: 2 },
        new Date('2026-05-19T16:00:00.000Z'),
    );
    assert.equal(m.shift_done, true);
    assert.equal(m.shift_elapsed_mins, 90);
    assert.equal(m.shift_pph, 100);
});

test('computeLiveShiftPph matches server formula between syncs', () => {
    const { computeLiveShiftPph } = require('../src/lib/shift-metrics.cjs');
    const start = '2026-05-19T14:00:00.000Z';
    const now = new Date('2026-05-19T15:00:00.000Z');
    assert.equal(computeLiveShiftPph(start, 120, now), 120);
    assert.equal(computeLiveShiftPph(start, 120, new Date('2026-05-19T14:30:00.000Z')), 240);
});

test('order PPH metrics split team rate and per-person rate', () => {
    const { computeOrderPphMetrics } = require('../src/lib/shift-metrics.cjs');
    const m = computeOrderPphMetrics(125, 120, 2);
    assert.equal(m.team_pph, 62.5);
    assert.equal(m.per_person_pph, 31.3);
});

test('break deduction tiers follow elapsed clock hours', () => {
    const { computeBreakDeductionPerPerson } = require('../src/lib/shift-metrics.cjs');
    assert.equal(computeBreakDeductionPerPerson(1.5), 0);
    assert.equal(computeBreakDeductionPerPerson(2), 0.25);
    assert.equal(computeBreakDeductionPerPerson(3.9), 0.25);
    assert.equal(computeBreakDeductionPerPerson(4), 0.75);
    assert.equal(computeBreakDeductionPerPerson(5.5), 0.75);
    assert.equal(computeBreakDeductionPerPerson(6), 1);
    assert.equal(computeBreakDeductionPerPerson(8), 1);
});

test('archived order metrics apply break-adjusted per-person PPH', () => {
    const { computeArchivedOrderMetrics } = require('../src/lib/shift-metrics.cjs');
    const m = computeArchivedOrderMetrics(125, 120, 2);
    assert.equal(m.team_pph, 62.5);
    assert.equal(m.per_person_pph, 31.3);
    assert.equal(m.break_deduction_hours_per_person, 0.25);
    assert.equal(m.adjusted_labor_hours, 3.5);
    assert.equal(m.adjusted_per_person_pph, 35.7);
});

test('resolveOrderPieceCounts excludes hardware until marked arrived', () => {
    const { resolveOrderPieceCounts, computeStandardOrderHours } = require('../src/lib/shift-metrics.cjs');
    const off = resolveOrderPieceCounts({ grocery: 100, frozen: 20, hardware: 5, hardwareArrived: false });
    assert.equal(off.total_pieces, 120);
    assert.equal(off.hardware_pieces, 0);
    const on = resolveOrderPieceCounts({ grocery: 100, frozen: 20, hardware: 5, hardwareArrived: '1' });
    assert.equal(on.total_pieces, 125);
    assert.equal(on.hardware_pieces, 5);
    assert.equal(
        Number(computeStandardOrderHours(100, 20, 5, 55, 50, false).toFixed(2)),
        Number((120 / 55).toFixed(2)),
    );
});

test('archived order metrics example: 4.5h shift with five staff', () => {
    const { computeArchivedOrderMetrics } = require('../src/lib/shift-metrics.cjs');
    const m = computeArchivedOrderMetrics(900, 270, 5);
    assert.equal(m.break_deduction_hours_per_person, 0.75);
    assert.equal(m.adjusted_labor_hours, 18.75);
    assert.equal(m.adjusted_per_person_pph, 48);
});
