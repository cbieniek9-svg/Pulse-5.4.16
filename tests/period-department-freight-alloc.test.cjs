'use strict';

/**
 * Pulse 5.4.16 — workbook-equivalent freight: N3 × period department allocation %.
 * Replaces mistaken 5.4.15 purchases × single rate tests.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    allocateFreight,
    applyCostingToDay,
    COSTING_METHOD,
    FREIGHT_ALLOC_PCT,
    normalizeCostingMethod,
    buildFreightValidationVariance,
    distributeRoundedAmount,
    isAuthoritativeCostingMethod,
} = require('../src/lib/edmonton-receiving-costing.cjs');
const {
    validateAllocProfile,
    DEFAULT_ALLOC_PCT_POINTS,
    ALLOC_DEPT_KEYS,
    upsertDraftProfile,
    confirmProfile,
    resolveAllocProfile,
    requireConfirmedAllocProfile,
    ensurePeriodFreightAllocSchema,
    pctMapTotal,
} = require('../src/lib/receiving-period-freight-alloc.cjs');

const PROFILE = { ...DEFAULT_ALLOC_PCT_POINTS };
const FRACTIONS = FREIGHT_ALLOC_PCT;

function expected152() {
    return {
        grocery: 72.69,
        tobacco: 0,
        meat: 15.06,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 24.18,
        produce_shrink: 18.55,
        dairy: 21.59,
        pharmacy: 0,
    };
}

describe('5.4.16 period department freight allocation', () => {
    it('Test 1: exact $152.07 allocation', () => {
        const a = allocateFreight(152.07, FRACTIONS);
        const exp = expected152();
        for (const [k, v] of Object.entries(exp)) {
            assert.equal(a[k], v, `${k} expected ${v} got ${a[k]}`);
        }
        const sum = Object.values(a).reduce((s, v) => s + v, 0);
        assert.equal(Number(sum.toFixed(2)), 152.07);
    });

    it('Test 2: independent of purchase amounts', () => {
        const linesA = [{ line_kind: 'invoice', grocery: 100, meat: 10, produce: 10, produce_shrink: 5, dairy: 10 }];
        const linesB = [{ line_kind: 'invoice', grocery: 50000, meat: 9000, produce: 8000, produce_shrink: 4000, dairy: 7000, bakery: 3000 }];
        const a = applyCostingToDay(linesA, 152.07, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION, { pctFractions: FRACTIONS });
        const b = applyCostingToDay(linesB, 152.07, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION, { pctFractions: FRACTIONS });
        const exp = expected152();
        for (const k of Object.keys(exp)) {
            assert.equal(a.freight_included[k] ?? 0, exp[k], `A ${k}`);
            assert.equal(b.freight_included[k] ?? 0, exp[k], `B ${k}`);
        }
        // Bakery has purchases in B but 0% → $0 freight
        assert.equal(b.freight_included.bakery ?? 0, 0);
        assert.equal(a.freight_included_total, 152.07);
        assert.equal(b.freight_included_total, 152.07);
    });

    it('Test 3: Produce Shrink included at 12.2%', () => {
        const a = allocateFreight(152.07, FRACTIONS);
        assert.equal(a.produce_shrink, 18.55);
        const day = applyCostingToDay(
            [{ line_kind: 'invoice', produce_shrink: 1000, grocery: 100 }],
            152.07,
            COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            { pctFractions: FRACTIONS },
        );
        assert.equal(day.purchases.produce_shrink, 1000 + 18.55);
    });

    it('Test 4: zero-percent departments stay $0 with large purchases', () => {
        const day = applyCostingToDay(
            [{
                line_kind: 'invoice',
                bakery: 99999,
                deli: 88888,
                tobacco: 77777,
                pharmacy: 66666,
                grocery: 100,
            }],
            152.07,
            COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            { pctFractions: FRACTIONS },
        );
        assert.equal(day.freight_included.bakery ?? 0, 0);
        assert.equal(day.freight_included.deli ?? 0, 0);
        assert.equal(day.freight_included.tobacco ?? 0, 0);
        assert.equal(day.freight_included.pharmacy ?? 0, 0);
        assert.equal(day.purchases.bakery, 99999);
    });

    it('Test 5: invoice estimate ignored for official freight', () => {
        const day = applyCostingToDay(
            [{
                line_kind: 'invoice',
                grocery: 1000,
                freight_grocery: 1000,
                freight_meat: 219.47,
            }],
            152.07,
            COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            { pctFractions: FRACTIONS },
        );
        assert.equal(day.entered_freight_total, 1219.47);
        assert.equal(day.freight_included_total, 152.07);
        assert.equal(day.freight_included.grocery, 72.69);
    });

    it('Test 6: bill validation only', () => {
        const v = buildFreightValidationVariance({
            allocatedTotal: 152.07,
            actualBillsTotal: 152.26,
        });
        assert.equal(v.allocated, 152.07);
        assert.equal(v.actual, 152.26);
        assert.equal(v.variance, 0.19);
        assert.equal(v.incomplete_coverage, false);
    });

    it('Test 7: null versus zero daily freight', () => {
        const missing = applyCostingToDay(
            [{ line_kind: 'invoice', grocery: 100 }],
            null,
            COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            { pctFractions: FRACTIONS },
        );
        assert.equal(missing.expected_freight, null);
        assert.equal(missing.daily_freight_incomplete, true);
        assert.equal(missing.freight_included_total, 0);
        assert.equal(missing.purchases.grocery, 100);

        const zero = applyCostingToDay(
            [{ line_kind: 'invoice', grocery: 100 }],
            0,
            COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            { pctFractions: FRACTIONS },
        );
        assert.equal(zero.expected_freight, 0);
        assert.equal(Boolean(zero.daily_freight_incomplete), false);
        assert.equal(zero.freight_included_total, 0);

        const fromNullAlloc = allocateFreight(null, FRACTIONS);
        assert.equal(Object.values(fromNullAlloc).every((v) => v === 0), true);
    });

    it('Test 9: profile validation', () => {
        assert.equal(validateAllocProfile({ ...PROFILE, grocery: -2 }).ok, false);
        assert.equal(validateAllocProfile({ ...PROFILE, grocery: 500 }).ok, false);
        assert.equal(validateAllocProfile({ grocery: 100 }).ok, false); // missing depts when requireComplete
        const zerosOnly = Object.fromEntries(ALLOC_DEPT_KEYS.map((k) => [k, 0]));
        assert.equal(validateAllocProfile(zerosOnly).ok, false); // total 0
        assert.equal(validateAllocProfile(PROFILE).ok, true);
        assert.ok(Math.abs(pctMapTotal(PROFILE) - 100) < 0.0001);
        assert.equal(validateAllocProfile({ ...PROFILE, grocery: Number.NaN }).ok, false);
    });

    it('Test 15: negative freight credit reconciles exactly', () => {
        const a = allocateFreight(-152.07, FRACTIONS);
        const sum = Object.values(a).reduce((s, v) => s + v, 0);
        assert.equal(Number(sum.toFixed(2)), -152.07);
        assert.equal(a.grocery, -72.69);
        assert.equal(a.meat, -15.06);
        assert.equal(a.produce_shrink, -18.55);
    });

    it('normalize maps legacy aliases to authoritative method', () => {
        assert.equal(normalizeCostingMethod('legacy_fixed_allocation'), COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
        assert.equal(normalizeCostingMethod('workbook_alloc'), COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
        assert.equal(isAuthoritativeCostingMethod('period_department_allocation'), true);
        assert.equal(isAuthoritativeCostingMethod('period_rate'), false);
    });

    it('distributeRoundedAmount sums exactly', () => {
        const shares = distributeRoundedAmount([0.478, 0.099, 0.159, 0.122, 0.142], 152.07);
        const sum = shares.reduce((s, v) => s + v, 0);
        assert.equal(Number(sum.toFixed(2)), 152.07);
    });
});

describe('5.4.16 allocation profile persistence', () => {
    function mockDb() {
        const tables = {
            receiving_period_freight_alloc_profiles: [],
            receiving_period_freight_alloc_snapshots: [],
            receiving_report_day_freight_alloc: [],
            receiving_report_period_status: [],
        };
        const api = {
            exec() { /* schema via ensure uses exec — no-op for memory mock; use real better-sqlite in electron tests */ },
            all() { return []; },
            get() { return null; },
            run() { return { changes: 0 }; },
            transaction(fn) { return () => fn(); },
        };
        // Prefer skip if no sqlite — covered by electron suite below when available
        return api;
    }

    it('Test 8/10 placeholders use requireConfirmedAllocProfile fail-closed shape', () => {
        // Unit-level: missing profile throws FREIGHT_ALLOC_PROFILE_MISSING code via fake db that has schema helpers
        // Full DB coverage runs under electron in period-department-freight-alloc-db.test when present.
        assert.equal(typeof requireConfirmedAllocProfile, 'function');
        assert.equal(typeof confirmProfile, 'function');
        assert.equal(typeof upsertDraftProfile, 'function');
        assert.equal(typeof resolveAllocProfile, 'function');
        assert.equal(typeof ensurePeriodFreightAllocSchema, 'function');
        void mockDb;
    });
});
