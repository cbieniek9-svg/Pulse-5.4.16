'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    breakDeductionPerPerson,
    solveClockHours,
    deriveCadenceBaseline,
    simulateCadence,
    pickBestCadence,
    simulateOrderCadence,
} = require('../src/lib/order-cadence-sim.cjs');

const SCORECARD = {
    window_days: 90,
    order_days: 12,
    overall: { avg_pieces: 800, avg_staff: 5, avg_adj_pph: 22, avg_team_pph: 110 },
    by_weekday: [
        { weekday: 'Monday', order_days: 4 },
        { weekday: 'Wednesday', order_days: 4 },
        { weekday: 'Friday', order_days: 4 },
    ],
};

test('breakDeductionPerPerson mirrors the server tiers', () => {
    assert.equal(breakDeductionPerPerson(1.5), 0);
    assert.equal(breakDeductionPerPerson(3), 0.25);
    assert.equal(breakDeductionPerPerson(5), 0.75);
    assert.equal(breakDeductionPerPerson(8), 1.0);
    assert.equal(breakDeductionPerPerson(0), 0);
});

test('solveClockHours adds the break that the resulting day length earns', () => {
    // 7.27 productive hrs → 1.0h break (>6h) → ~8.27 clock hrs
    assert.ok(Math.abs(solveClockHours(7.27) - 8.27) < 0.01);
    // 1.8 productive hrs stays under 2h → no break
    assert.equal(solveClockHours(1.8), 1.8);
});

test('deriveCadenceBaseline reads rate, staff, cadence and weekly volume', () => {
    const b = deriveCadenceBaseline(SCORECARD);
    assert.equal(b.days_per_week, 3);
    assert.equal(b.weekly_pieces, 2400);
    assert.equal(b.rate_pp_hour, 22);
    assert.equal(b.avg_staff, 5);
});

test('deriveCadenceBaseline falls back to team_pph/staff when adj is missing', () => {
    const b = deriveCadenceBaseline({
        ...SCORECARD,
        overall: { avg_pieces: 800, avg_staff: 5, avg_team_pph: 110 },
    });
    assert.equal(b.rate_pp_hour, 22); // 110 / 5
});

test('simulateOrderCadence holds productive labor constant and flags current cadence', () => {
    const sim = simulateOrderCadence(SCORECARD, {});
    assert.equal(sim.ok, true);
    assert.ok(sim.scenarios.length >= 4);

    const current = sim.scenarios.find((s) => s.is_current);
    assert.ok(current);
    assert.equal(current.days_per_week, 3);
    assert.equal(current.delta_pph, 0);

    // productive person-hours == weekly_pieces / rate, regardless of cadence
    const expectedProductive = 2400 / 22;
    sim.scenarios.forEach((s) => {
        assert.ok(Math.abs(s.weekly_productive_person_hours - expectedProductive) < 0.5);
        assert.ok(s.effective_pph > 0);
    });
});

test('setup overhead per order day lowers effective PPH and raises weekly labor', () => {
    const plain = simulateCadence(deriveCadenceBaseline(SCORECARD), 5, {});
    const withOverhead = simulateCadence(deriveCadenceBaseline(SCORECARD), 5, { overhead_hours_per_order_day: 3 });
    assert.ok(withOverhead.weekly_clock_person_hours > plain.weekly_clock_person_hours);
    assert.ok(withOverhead.effective_pph < plain.effective_pph);
});

test('pickBestCadence picks highest effective PPH and breaks ties toward fewer days', () => {
    const best = pickBestCadence([
        { days_per_week: 3, effective_pph: 19.4 },
        { days_per_week: 6, effective_pph: 20.6 },
        { days_per_week: 5, effective_pph: 18.8 },
    ]);
    assert.equal(best.days_per_week, 6);

    const tie = pickBestCadence([
        { days_per_week: 4, effective_pph: 20.0 },
        { days_per_week: 2, effective_pph: 20.0 },
    ]);
    assert.equal(tie.days_per_week, 2); // tie → fewer order days
    assert.equal(pickBestCadence([]), null);
});

test('simulateOrderCadence attaches the best scenario from the sweep', () => {
    const sim = simulateOrderCadence(SCORECARD, {});
    assert.ok(sim.best);
    const maxPph = Math.max(...sim.scenarios.map((s) => s.effective_pph));
    assert.equal(sim.best.effective_pph, maxPph);
});

test('simulateOrderCadence reports insufficient data when no scorecard', () => {
    assert.equal(simulateOrderCadence({}).ok, false);
    assert.equal(simulateOrderCadence(null).ok, false);
});
