'use strict';

/**
 * Pulse 5.4.16 — authoritative workbook freight model integration tests.
 * Department Freight = Daily Freight Allocation Total (N3) × Period Department Allocation %
 * NOT purchases × single rate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { roundMoney } = require('../src/lib/parse-money.cjs');
const {
    COSTING_METHOD,
    applyCostingToDay,
    allocateFreight,
    buildFreightValidationVariance,
    setPeriodCostingMethod,
    FREIGHT_ALLOC_PCT,
    lineLandedPurchases,
} = require('../src/lib/edmonton-receiving-costing.cjs');
const {
    DEFAULT_ALLOC_PCT_POINTS,
    ALLOC_DEPT_KEYS,
    upsertDraftProfile,
    confirmProfile,
    requireConfirmedAllocProfile,
    validateAllocProfile,
    resolveAllocProfile,
    getSnapshotPctMap,
    getProfileRow,
    ensurePeriodFreightAllocSchema,
    pctMapTotal,
} = require('../src/lib/receiving-period-freight-alloc.cjs');
const { setActualFreightBillsTotal } = require('../src/lib/receiving-period-freight-rates.cjs');
const { runMigrations } = require('../src/migrations/runner.cjs');

const FRACTIONS = FREIGHT_ALLOC_PCT;
const PROFILE = { ...DEFAULT_ALLOC_PCT_POINTS };

function emptyLine(overrides = {}) {
    return {
        line_kind: 'invoice',
        grocery: 0,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        dairy: 0,
        pharmacy: 0,
        gst: 0,
        ...overrides,
    };
}

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

function withTestDb(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'period-dept-freight-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);
        ensurePeriodFreightAllocSchema(db);
        return fn(db);
    } finally {
        process.env.TGP_DATA_DIR = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
}

function confirmDefaultProfile(db, periodStart, actor = 'mgr') {
    upsertDraftProfile(db, periodStart, PROFILE, actor);
    confirmProfile(db, periodStart, actor, 'Test confirm allocation profile');
}

test('1) exact $152.07 department allocation', () => {
    const a = allocateFreight(152.07, FRACTIONS);
    const exp = expected152();
    for (const [k, v] of Object.entries(exp)) {
        assert.equal(a[k], v, `${k} expected ${v} got ${a[k]}`);
    }
    const sum = Object.values(a).reduce((s, v) => s + v, 0);
    assert.equal(Number(sum.toFixed(2)), 152.07);
});

test('2) independent of purchase amounts', () => {
    const linesA = [emptyLine({ grocery: 100, meat: 10, produce: 10, produce_shrink: 5, dairy: 10 })];
    const linesB = [emptyLine({
        grocery: 50000, meat: 9000, produce: 8000, produce_shrink: 4000, dairy: 7000, bakery: 3000,
    })];
    const a = applyCostingToDay(linesA, 152.07, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION, { pctFractions: FRACTIONS });
    const b = applyCostingToDay(linesB, 152.07, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION, { pctFractions: FRACTIONS });
    const exp = expected152();
    for (const k of Object.keys(exp)) {
        assert.equal(a.freight_included[k] ?? 0, exp[k], `A ${k}`);
        assert.equal(b.freight_included[k] ?? 0, exp[k], `B ${k}`);
    }
    assert.equal(b.freight_included.bakery ?? 0, 0);
    assert.equal(a.freight_included_total, 152.07);
    assert.equal(b.freight_included_total, 152.07);
});

test('3) Produce Shrink included at 12.2%', () => {
    const a = allocateFreight(152.07, FRACTIONS);
    assert.equal(a.produce_shrink, 18.55);
    const day = applyCostingToDay(
        [emptyLine({ produce_shrink: 1000, grocery: 100 })],
        152.07,
        COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        { pctFractions: FRACTIONS },
    );
    assert.equal(day.purchases.produce_shrink, 1000 + 18.55);
});

test('4) zero-percent departments stay $0 with large purchases', () => {
    const day = applyCostingToDay(
        [emptyLine({ bakery: 99999, deli: 88888, tobacco: 77777, pharmacy: 66666, grocery: 100 })],
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

test('5) invoice estimate ignored for official freight', () => {
    const day = applyCostingToDay(
        [emptyLine({ grocery: 1000, freight_grocery: 1000, freight_meat: 219.47 })],
        152.07,
        COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        { pctFractions: FRACTIONS },
    );
    assert.equal(day.entered_freight_total, 1219.47);
    assert.equal(day.freight_included_total, 152.07);
    assert.equal(day.freight_included.grocery, 72.69);
});

test('6) bill validation — alloc $152.07, bill $152.26, variance $0.19', () => {
    const v = buildFreightValidationVariance({
        allocatedTotal: 152.07,
        actualBillsTotal: 152.26,
    });
    assert.equal(v.allocated, 152.07);
    assert.equal(v.actual, 152.26);
    assert.equal(v.variance, 0.19);
    assert.equal(v.incomplete_coverage, false);

    withTestDb((db) => {
        confirmDefaultProfile(db, '2026-06-21');
        setActualFreightBillsTotal(db, '2026-06-21', 152.26, 'mgr');
        const status = db.get(
            'SELECT actual_freight_bills_total FROM receiving_report_period_status WHERE period_start=?',
            '2026-06-21',
        );
        assert.equal(status.actual_freight_bills_total, 152.26);
    });
});

test('7) null versus zero daily freight', () => {
    const missing = applyCostingToDay(
        [emptyLine({ grocery: 100 })],
        null,
        COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        { pctFractions: FRACTIONS },
    );
    assert.equal(missing.expected_freight, null);
    assert.equal(missing.daily_freight_incomplete, true);
    assert.equal(missing.freight_included_total, 0);
    assert.equal(missing.purchases.grocery, 100);

    const zero = applyCostingToDay(
        [emptyLine({ grocery: 100 })],
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

test('8) missing confirmed allocation profile blocks confirm costing', () => {
    withTestDb((db) => {
        assert.throws(
            () => setPeriodCostingMethod(db, '2026-06-21', {
                method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
                reason: 'Attempt without profile',
            }, 'mgr'),
            (err) => err.code === 'FREIGHT_ALLOC_PROFILE_MISSING' && err.status === 409,
        );

        upsertDraftProfile(db, '2026-06-21', PROFILE, 'mgr');
        assert.throws(
            () => requireConfirmedAllocProfile(db, '2026-06-21'),
            (err) => err.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
        );
        assert.throws(
            () => setPeriodCostingMethod(db, '2026-06-21', {
                method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
                reason: 'Draft only',
            }, 'mgr'),
            (err) => err.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
        );
    });
});

test('9) profile validation rejects invalid; accepts zeros totaling 100', () => {
    assert.equal(validateAllocProfile({ ...PROFILE, grocery: -2 }).ok, false);
    assert.equal(validateAllocProfile({ ...PROFILE, grocery: 500 }).ok, false);
    assert.equal(validateAllocProfile({ grocery: 100 }).ok, false);
    const zerosOnly = Object.fromEntries(ALLOC_DEPT_KEYS.map((k) => [k, 0]));
    assert.equal(validateAllocProfile(zerosOnly).ok, false);
    assert.equal(validateAllocProfile({ ...PROFILE, grocery: Number.NaN }).ok, false);

    assert.equal(validateAllocProfile(PROFILE).ok, true);
    assert.ok(Math.abs(pctMapTotal(PROFILE) - 100) < 0.0001);

    const sparseValid = Object.fromEntries(ALLOC_DEPT_KEYS.map((k) => [k, k === 'grocery' ? 100 : 0]));
    assert.equal(validateAllocProfile(sparseValid).ok, true);
});

test('10) historical protection — two periods, changing new does not alter prior', () => {
    withTestDb((db) => {
        const priorProfile = Object.fromEntries(ALLOC_DEPT_KEYS.map((k) => [k, 0]));
        priorProfile.grocery = 60;
        priorProfile.meat = 40;

        upsertDraftProfile(db, '2026-01-01', priorProfile, 'mgr');
        confirmProfile(db, '2026-01-01', 'mgr', 'Prior period profile');

        confirmDefaultProfile(db, '2026-06-21');

        assert.equal(resolveAllocProfile(db, '2026-01-01').pctMap.grocery, 60);
        assert.equal(resolveAllocProfile(db, '2026-06-21').pctMap.grocery, 47.8);

        const newPeriodProfile = Object.fromEntries(ALLOC_DEPT_KEYS.map((k) => [k, 0]));
        newPeriodProfile.dairy = 100;
        upsertDraftProfile(db, '2026-07-19', newPeriodProfile, 'mgr');
        confirmProfile(db, '2026-07-19', 'mgr', 'New period different profile');

        const priorSnap = getSnapshotPctMap(db, '2026-01-01');
        assert.equal(priorSnap.grocery, 60);
        assert.equal(priorSnap.meat, 40);
        assert.equal(getSnapshotPctMap(db, '2026-07-19').dairy, 100);
        assert.equal(resolveAllocProfile(db, '2026-01-01').pctMap.grocery, 60);
    });
});

test('11) negative freight credit reconciles exactly', () => {
    const a = allocateFreight(-152.07, FRACTIONS);
    const sum = Object.values(a).reduce((s, v) => s + v, 0);
    assert.equal(Number(sum.toFixed(2)), -152.07);
    assert.equal(a.grocery, -72.69);
    assert.equal(a.meat, -15.06);
    assert.equal(a.produce_shrink, -18.55);
});

test('12) no double counting — invoice freight not added to landed', () => {
    const applied = applyCostingToDay(
        [emptyLine({ grocery: 100, freight_grocery: 50 })],
        152.07,
        COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        { pctFractions: FRACTIONS },
    );
    assert.equal(applied.entered_freight_total, 50);
    assert.equal(applied.freight_included.grocery, 72.69);
    assert.equal(applied.purchases.grocery, roundMoney(100 + 72.69));
    assert.notEqual(applied.purchases.grocery, 150);
    assert.notEqual(applied.purchases.grocery, roundMoney(100 + 50 + 72.69));

    assert.equal(lineLandedPurchases({ grocery: 100, freight_grocery: 50 }), 100);
    assert.equal(lineLandedPurchases({
        grocery: 100,
        freight_grocery: 50,
        allocated_freight: 72.69,
    }), roundMoney(172.69));
});

test('confirmed profile enables setPeriodCostingMethod', () => {
    withTestDb((db) => {
        confirmDefaultProfile(db, '2026-06-21');
        const resolved = setPeriodCostingMethod(db, '2026-06-21', {
            method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            reason: 'Manager confirmed workbook allocation',
        }, 'mgr');
        assert.equal(resolved.method, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
        assert.equal(resolved.confirmed, true);
        const row = getProfileRow(db, '2026-06-21');
        assert.equal(row.status, 'confirmed');
    });
});
