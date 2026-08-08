'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    COSTING_METHOD,
    FREIGHT_ALLOC_PCT,
    assertLegacyFreightPctValid,
    allocateFreight,
    computeItemLandedCost,
    applyCostingToDay,
    reconcileDayFreight,
    normalizeCostingMethod,
    resolvePeriodCostingMethod,
    setPeriodCostingMethod,
} = require('../src/lib/edmonton-receiving-costing.cjs');
const {
    buildReceivingTotalsPayload,
    buildMarginPayload,
    buildCostingComparisonPayload,
    roundMoney,
} = require('../src/lib/edmonton-receiving-analytics.cjs');
const { DEFAULT_ALLOC_PCT_POINTS } = require('../src/lib/receiving-period-freight-alloc.cjs');

test('legacy FREIGHT_ALLOC_PCT totals 100%', () => {
    assert.doesNotThrow(() => assertLegacyFreightPctValid());
    const sum = Object.values(FREIGHT_ALLOC_PCT).reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('Item X: base 32.03 + period rate 1% → alloc 0.32 landed 32.35; inv est 0.46 reference only', () => {
    const item = computeItemLandedCost({ baseCost: 32.03, estimatedFreight: 0.46, ratePercent: 1 });
    assert.equal(item.base_cost, 32.03);
    assert.equal(item.estimated_freight, 0.46);
    assert.equal(item.allocated_freight, 0.32);
    assert.equal(item.landed_cost, 32.35);
    assert.equal(item.invoice_payable, 32.03);
});

test('invoice_freight treats invoice freight as reference-only (not in landed)', () => {
    const applied = applyCostingToDay(
        [{
            line_kind: 'invoice',
            grocery: 32.03,
            tobacco: 0,
            meat: 0,
            bakery: 0,
            bakery_in_store: 0,
            deli: 0,
            produce: 100,
            produce_shrink: 50,
            dairy: 0,
            pharmacy: 0,
            gst: 0,
            freight_grocery: 0.46,
            freight_produce: 1.50,
        }],
        1.96,
        COSTING_METHOD.INVOICE_FREIGHT,
    );
    assert.equal(applied.purchases.grocery, 32.03);
    assert.equal(applied.purchases.produce, 100);
    assert.equal(applied.purchases.produce_shrink, 50);
    assert.equal(applied.base_payable, 182.03);
    assert.equal(applied.entered_freight_total, 1.96);
    assert.equal(applied.freight_included_total, 0);
    assert.equal(applied.landed_purchases_total, roundMoney(32.03 + 100 + 50));
});

test('legacy allocation still splits N3 including produce_shrink bucket', () => {
    const parts = allocateFreight(1000);
    assert.equal(parts.grocery, 478);
    assert.equal(parts.meat, 99);
    assert.equal(parts.produce, 159);
    assert.equal(parts.produce_shrink, 122);
    assert.equal(parts.dairy, 142);
    const applied = applyCostingToDay(
        [{
            line_kind: 'invoice',
            grocery: 100,
            dairy: 20,
            tobacco: 0,
            meat: 0,
            bakery: 0,
            bakery_in_store: 0,
            deli: 0,
            produce: 0,
            produce_shrink: 0,
            pharmacy: 0,
            gst: 0,
        }],
        1000,
        COSTING_METHOD.LEGACY_FIXED_ALLOCATION,
    );
    assert.equal(applied.purchases.grocery, 578);
    assert.equal(applied.purchases.dairy, 162);
    assert.equal(applied.purchases.produce_shrink, 122);
});

test('base_cost_only excludes freight from purchases', () => {
    const applied = applyCostingToDay(
        [{
            line_kind: 'invoice',
            grocery: 32.03,
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
            freight_grocery: 0.46,
        }],
        0.46,
        COSTING_METHOD.BASE_COST_ONLY,
    );
    assert.equal(applied.purchases.grocery, 32.03);
    assert.equal(applied.freight_included_total, 0);
    assert.equal(applied.entered_freight_total, 0.46);
});

test('freight reconciliation tolerance and override', () => {
    assert.equal(reconcileDayFreight({ expected: 10, entered: 10.04, tolerance: 0.05 }).status, 'PASS');
    assert.equal(reconcileDayFreight({ expected: 10, entered: 10.10, tolerance: 0.05 }).status, 'WARNING');
    assert.equal(reconcileDayFreight({ expected: 10, entered: 20, tolerance: 0.05 }).status, 'FAIL');
    assert.equal(
        reconcileDayFreight({ expected: 10, entered: 20, tolerance: 0.05, override: true }).status,
        'OVERRIDE',
    );
});

test('normalizeCostingMethod maps legacy aliases and period_rate', () => {
    assert.equal(normalizeCostingMethod('workbook_alloc'), COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
    assert.equal(normalizeCostingMethod('legacy_fixed_allocation'), COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
    assert.equal(normalizeCostingMethod('sms_landed'), COSTING_METHOD.BASE_COST_ONLY);
    assert.equal(normalizeCostingMethod('invoice_freight'), COSTING_METHOD.INVOICE_FREIGHT);
    assert.equal(normalizeCostingMethod('period_rate'), COSTING_METHOD.PERIOD_RATE);
    assert.equal(normalizeCostingMethod('period_department_allocation'), COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
});

test('historical periods without method resolve to period_department_allocation', () => {
    const db = {
        get(sql) {
            if (String(sql).includes('receiving_report_period_status')) {
                return { status: 'locked', costing_method: '' };
            }
            if (String(sql).includes('receiving_report_period_snapshots')) {
                return { period_start: '2026-01-01' };
            }
            return null;
        },
    };
    const resolved = resolvePeriodCostingMethod(db, '2026-01-01');
    assert.equal(resolved.method, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
    assert.equal(resolved.source, 'historical_default');
});

test('open periods without method default to period_department_allocation', () => {
    const db = {
        get() { return null; },
    };
    const resolved = resolvePeriodCostingMethod(db, '2026-06-21');
    assert.equal(resolved.method, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
    assert.equal(resolved.source, 'new_period_default');
});

function makeDb() {
    const settings = new Map([
        ['Receiving_Report_Period_Start', '2026-06-21'],
        ['Receiving_Report_Period_Number', '5'],
        ['Receiving_Freight_Tolerance', '0.05'],
    ]);
    const sales = new Map();
    const margin = new Map();
    const status = new Map();
    const rates = new Map();
    const lines = [];
    const days = [];

    return {
        _lines: lines,
        _days: days,
        _status: status,
        _rates: rates,
        get(sql, ...params) {
            if (sql.includes('FROM settings')) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            if (sql.includes('FROM receiving_period_freight_rates')) {
                return rates.get(`${params[0]}|${params[1] ?? ''}`) || null;
            }
            if (sql.includes('FROM receiving_report_period_status')) {
                return status.get(params[0]) || null;
            }
            if (sql.includes('receiving_period_freight_alloc_profiles')) {
                return {
                    period_start: params[0],
                    status: 'confirmed',
                    grocery_pct: 47.8,
                    tobacco_pct: 0,
                    meat_pct: 9.9,
                    bakery_pct: 0,
                    bakery_in_store_pct: 0,
                    deli_pct: 0,
                    produce_pct: 15.9,
                    produce_shrink_pct: 12.2,
                    dairy_pct: 14.2,
                    pharmacy_pct: 0,
                };
            }
            if (sql.includes('FROM receiving_report_period_snapshots')) return null;
            if (sql.includes('FROM receiving_report_margin') && sql.includes('period_start >')) return null;
            if (sql.includes('FROM receiving_report_margin')) return margin.get(params[0]) || null;
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('PRAGMA table_info')) {
                return [
                    { name: 'id' },
                    { name: 'period_start' },
                    { name: 'department' },
                    { name: 'rate_percent' },
                    { name: 'freight_rate_percent' },
                    { name: 'freight_calc_source' },
                    { name: 'actual_freight_bills_total' },
                    { name: 'applied_freight_rate' },
                    { name: 'allocated_freight' },
                    { name: 'eligible_merchandise' },
                    { name: 'landed_purchase_cost' },
                ];
            }
            if (sql.includes('FROM receiving_report_sales')) {
                return [...sales.values()].filter((row) => row.period_start === params[0]);
            }
            if (sql.includes('FROM receiving_report_lines')) {
                return lines.filter((row) => row.store_date >= params[0] && row.store_date <= params[1]
                    && (row.line_kind || 'invoice') === 'invoice');
            }
            if (sql.includes('FROM receiving_report_day')) {
                return days.filter((d) => d.store_date >= params[0] && d.store_date <= params[1]);
            }
            if (sql.includes('FROM receiving_shrink_lines')) return [];
            if (sql.includes('receiving_report_rebate_lines')) return [];
            if (sql.includes('receiving_period_freight_alloc_snapshots')) return [];
            return [];
        },
        run(sql, ...params) {
            if (String(sql).includes('INSERT INTO receiving_period_freight_rates')
                || String(sql).includes('UPDATE receiving_period_freight_rates')) {
                const start = params[0];
                const dept = params[1];
                const rate = params[2];
                rates.set(`${start}|${dept}`, {
                    period_start: start,
                    department: dept,
                    rate_percent: rate,
                });
            }
            if (String(sql).includes('UPDATE receiving_report_period_status')
                || String(sql).includes('INSERT INTO receiving_report_period_status')) {
                // no-op for makeDb unit stubs; tests that confirm use real db
            }
        },
        exec() {},
    };
}

test('period_department_allocation period totals allocate N3 by dept %', () => {
    const db = makeDb();
    db._status.set('2026-06-21', {
        status: 'open',
        costing_method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        freight_calc_source: 'period_department_allocation',
        costing_method_reason: 'confirmed',
        costing_method_selected_at: '2026-06-21T00:00:00.000Z',
        costing_method_selected_by: 'mgr',
    });
    db._lines.push({
        store_date: '2026-06-21',
        line_kind: 'invoice',
        grocery: 100,
        dairy: 20,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        pharmacy: 0,
        gst: 0,
        freight_grocery: 10,
    });
    db._days.push({ store_date: '2026-06-21', freight_total: 1000 });

    const totals = buildReceivingTotalsPayload(db, '2026-06-21');
    assert.equal(totals.costing_method, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
    assert.equal(roundMoney(totals.purchase_totals.grocery), 578);
    assert.equal(roundMoney(totals.purchase_totals.dairy), 162);
    assert.equal(roundMoney(totals.base_purchases_total), 120);
    assert.equal(roundMoney(totals.freight_included_total), 1000);
    assert.equal(roundMoney(totals.entered_freight_total), 10);

    const margin = buildMarginPayload(db, '2026-06-21');
    assert.equal(roundMoney(margin.totals.purchases), 740);
});

test('superseded period_rate period totals allocate by rate percent (comparison only)', () => {
    const db = makeDb();
    db._status.set('2026-06-21', {
        status: 'open',
        costing_method: COSTING_METHOD.PERIOD_RATE,
        freight_rate_percent: 1,
        freight_calc_source: 'period_rate',
    });
    db._rates.set('2026-06-21|', {
        period_start: '2026-06-21',
        department: '',
        rate_percent: 1,
    });
    db._lines.push({
        store_date: '2026-06-21',
        line_kind: 'invoice',
        grocery: 32.03,
        dairy: 0,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        pharmacy: 0,
        gst: 0,
        freight_grocery: 0.46,
    });
    db._days.push({ store_date: '2026-06-21', freight_total: 0.46 });

    const totals = buildReceivingTotalsPayload(db, '2026-06-21');
    assert.equal(totals.costing_method, COSTING_METHOD.PERIOD_RATE);
    assert.equal(roundMoney(totals.purchase_totals.grocery), 32.35);
    assert.equal(roundMoney(totals.base_purchases_total), 32.03);
    assert.equal(roundMoney(totals.freight_included_total), 0.32);
    assert.equal(roundMoney(totals.entered_freight_total), 0.46);

    const margin = buildMarginPayload(db, '2026-06-21');
    assert.equal(roundMoney(margin.totals.purchases), 32.35);
});

test('invoice_freight period totals exclude invoice freight from purchases (reference only)', () => {
    const db = makeDb();
    db._status.set('2026-06-21', {
        status: 'open',
        costing_method: COSTING_METHOD.INVOICE_FREIGHT,
    });
    db._lines.push({
        store_date: '2026-06-21',
        line_kind: 'invoice',
        grocery: 32.03,
        dairy: 0,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        pharmacy: 0,
        gst: 0,
        freight_grocery: 0.46,
    });
    db._days.push({ store_date: '2026-06-21', freight_total: 0.46 });

    const totals = buildReceivingTotalsPayload(db, '2026-06-21');
    assert.equal(totals.costing_method, COSTING_METHOD.INVOICE_FREIGHT);
    assert.equal(roundMoney(totals.purchase_totals.grocery), 32.03);
    assert.equal(roundMoney(totals.freight_included_total), 0);
    assert.equal(roundMoney(totals.entered_freight_total), 0.46);
});

test('costing comparison exposes period_department_allocation primary and superseded period_rate', () => {
    const db = makeDb();
    db._status.set('2026-06-21', {
        status: 'open',
        costing_method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        freight_calc_source: 'period_department_allocation',
        costing_method_reason: 'confirmed',
        costing_method_selected_at: '2026-06-21T00:00:00.000Z',
        costing_method_selected_by: 'mgr',
    });
    db._rates.set('2026-06-21|', {
        period_start: '2026-06-21',
        department: '',
        rate_percent: 1,
    });
    db._lines.push({
        store_date: '2026-06-21',
        line_kind: 'invoice',
        grocery: 100,
        dairy: 20,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        pharmacy: 0,
        gst: 0,
        freight_grocery: 10,
    });
    db._days.push({ store_date: '2026-06-21', freight_total: 1000 });

    const compare = buildCostingComparisonPayload(db, '2026-06-21');
    assert.equal(compare.primary_method, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
    assert.equal(compare.modes.period_department_allocation.label, 'Period department allocation (N3 × dept %)');
    assert.equal(compare.modes.period_rate.label, 'Superseded (purchases × rate)');
    assert.match(compare.modes.invoice_freight.label, /Reference Only/i);
    assert.equal(compare.modes.base_cost_only.label, 'Base cost only');
    assert.equal(roundMoney(compare.modes.period_department_allocation.grocery_dairy_purchases), 740);
    assert.equal(roundMoney(compare.modes.period_rate.grocery_dairy_purchases), 121.2);
    assert.equal(roundMoney(compare.modes.invoice_freight.grocery_dairy_purchases), 120);
    assert.equal(roundMoney(compare.modes.base_cost_only.grocery_dairy_purchases), 120);
    assert.ok(Array.isArray(compare.departments));
    assert.ok(!/sms landed/i.test(compare.modes.base_cost_only.blurb));
});

test('confirm method accepts only period_department_allocation and requires confirmed profile', () => {
    const profiles = new Map();
    const status = new Map();
    const db = {
        get(sql, ...params) {
            if (String(sql).includes('receiving_period_freight_alloc_profiles')) {
                return profiles.get(params[0]) || null;
            }
            if (String(sql).includes('receiving_period_freight_alloc_snapshots')) {
                return null;
            }
            if (String(sql).includes('receiving_report_period_status')) {
                return status.get(params[0]) || null;
            }
            if (String(sql).includes('receiving_report_period_snapshots')) return null;
            if (String(sql).includes('FROM receiving_report_lines')) return [];
            if (String(sql).includes('FROM receiving_report_day')) return [];
            return null;
        },
        all(sql) {
            if (String(sql).includes('PRAGMA table_info')) {
                return [
                    { name: 'freight_rate_percent' },
                    { name: 'freight_calc_source' },
                    { name: 'freight_alloc_profile_status' },
                    { name: 'actual_freight_bills_total' },
                ];
            }
            if (String(sql).includes('receiving_period_freight_alloc_snapshots')) return [];
            return [];
        },
        run(sql, ...params) {
            if (String(sql).includes('INSERT INTO receiving_report_period_status')) {
                status.set(params[0], {
                    period_start: params[0],
                    status: 'open',
                    costing_method: params[1],
                    costing_method_reason: params[2],
                    costing_method_selected_at: params[3],
                    costing_method_selected_by: params[4],
                    freight_rate_percent: null,
                    freight_calc_source: params[6],
                    freight_alloc_profile_status: params[7],
                });
            }
            if (String(sql).includes('UPDATE receiving_report_period_status')) {
                status.set(params[9], {
                    period_start: params[9],
                    status: 'open',
                    costing_method: params[0],
                    costing_method_reason: params[1],
                    costing_method_selected_at: params[2],
                    costing_method_selected_by: params[3],
                    freight_rate_percent: null,
                    freight_calc_source: params[5],
                    freight_alloc_profile_status: params[6],
                });
            }
        },
        exec() {},
    };

    assert.throws(
        () => setPeriodCostingMethod(db, '2026-06-21', {
            method: COSTING_METHOD.INVOICE_FREIGHT,
            reason: 'legacy',
        }, 'mgr'),
        (err) => err.code === 'NON_AUTHORITATIVE_COSTING_METHOD',
    );

    assert.throws(
        () => setPeriodCostingMethod(db, '2026-06-21', {
            method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            reason: 'no profile',
        }, 'mgr'),
        (err) => err.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
    );

    profiles.set('2026-06-21', {
        period_start: '2026-06-21',
        status: 'confirmed',
        grocery_pct: 47.8,
        tobacco_pct: 0,
        meat_pct: 9.9,
        bakery_pct: 0,
        bakery_in_store_pct: 0,
        deli_pct: 0,
        produce_pct: 15.9,
        produce_shrink_pct: 12.2,
        dairy_pct: 14.2,
        pharmacy_pct: 0,
    });
    const confirmed = setPeriodCostingMethod(db, '2026-06-21', {
        method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        reason: 'Manager confirmed period department allocation',
    }, 'mgr');
    assert.equal(confirmed.method, COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);
    assert.equal(confirmed.confirmed, true);
    assert.equal(status.get('2026-06-21').freight_calc_source, 'period_department_allocation');
    assert.equal(status.get('2026-06-21').freight_alloc_profile_status, 'confirmed');
});
