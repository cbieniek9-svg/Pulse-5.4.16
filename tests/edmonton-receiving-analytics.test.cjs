'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildSalesGrid,
    saveSalesAmount,
    buildReceivingTotalsPayload,
    saveMarginMeta,
    buildMarginPayload,
    buildCostingComparisonPayload,
    buildTotalReportPayload,
    aggregateDailyPurchases,
    COSTING_MODE,
    roundMoney,
} = require('../src/lib/edmonton-receiving-analytics.cjs');

function makeDb() {
    const settings = new Map([
        ['Receiving_Report_Period_Start', '2026-06-21'],
        ['Receiving_Report_Period_Number', '5'],
    ]);
    const sales = new Map();
    const margin = new Map();
    const lines = [];
    const shrink = [];
    const allocProfiles = new Map([['2026-06-21', {
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
    }]]);
    // Superseded period_rate table — comparison only under 5.4.16.
    const rates = new Map([['2026-06-21|', {
        period_start: '2026-06-21',
        department: '',
        rate_percent: 0,
    }]]);

    return {
        get(sql, ...params) {
            if (sql.includes('FROM settings')) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            if (sql.includes('FROM receiving_period_freight_rates')) {
                return rates.get(`${params[0]}|${params[1] ?? ''}`) || null;
            }
            if (sql.includes('receiving_period_freight_alloc_profiles')) {
                return allocProfiles.get(params[0]) || null;
            }
            if (sql.includes('FROM receiving_report_period_status')) {
                return null;
            }
            if (sql.includes('FROM receiving_report_period_snapshots')) {
                return null;
            }
            if (sql.includes('FROM receiving_report_margin') && sql.includes('period_start >')) {
                return null;
            }
            if (sql.includes('FROM receiving_report_margin')) {
                return margin.get(params[0]) || null;
            }
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
                ];
            }
            if (sql.includes('FROM receiving_report_sales')) {
                return [...sales.values()].filter((row) => row.period_start === params[0]);
            }
            if (sql.includes('GROUP BY store_date')) {
                const counts = {};
                lines
                    .filter((row) => row.store_date >= params[0] && row.store_date <= params[1])
                    .forEach((row) => {
                        counts[row.store_date] = (counts[row.store_date] || 0) + 1;
                    });
                return Object.entries(counts).map(([store_date, line_count]) => ({ store_date, line_count }));
            }
            if (sql.includes('FROM receiving_report_lines')) {
                if (sql.includes('WHERE store_date=?')) {
                    return lines.filter((row) => row.store_date === params[0]);
                }
                let filtered = lines.filter((row) => row.store_date >= params[0] && row.store_date <= params[1]);
                if (sql.includes("COALESCE(NULLIF(TRIM(line_kind), ''), 'invoice') = 'invoice'")
                    || sql.includes("line_kind = 'invoice'")) {
                    filtered = filtered.filter((row) => (row.line_kind || 'invoice') === 'invoice');
                }
                return filtered;
            }
            if (sql.includes('FROM receiving_shrink_lines')) {
                return shrink.filter((row) => row.store_date >= params[0] && row.store_date <= params[1]);
            }
            if (sql.includes('receiving_period_freight_alloc_snapshots')) return [];
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO receiving_report_sales')) {
                const key = `${params[0]}:${params[1]}:${params[2]}`;
                sales.set(key, {
                    period_start: params[0],
                    week_num: params[1],
                    category_key: params[2],
                    amount: params[3],
                });
            } else if (sql.includes('INSERT INTO receiving_report_margin')) {
                margin.set(params[0], {
                    period_start: params[0],
                    period_number: params[1],
                    opening_inventory: params[2],
                    closing_inventory: params[3],
                    last_inventory: params[4],
                    target_margin_pct: params[5],
                    sms_margin_pct: params[6],
                    sales_before_count: params[7],
                    sales_after_count: params[8],
                    sales_during_count: params[9],
                    count_time_hours: params[10],
                    variance_explanation: params[11],
                    is_count_period: params[12],
                    updated_at: params[13],
                    updated_by: params[14],
                });
            } else if (sql.includes('UPDATE receiving_report_margin')) {
                const existing = margin.get(params[14]) || { period_start: params[14] };
                margin.set(params[14], {
                    ...existing,
                    period_number: params[0],
                    opening_inventory: params[1],
                    closing_inventory: params[2],
                    last_inventory: params[3],
                    target_margin_pct: params[4],
                    sms_margin_pct: params[5],
                    sales_before_count: params[6],
                    sales_after_count: params[7],
                    sales_during_count: params[8],
                    count_time_hours: params[9],
                    variance_explanation: params[10],
                    is_count_period: params[11],
                    updated_at: params[12],
                    updated_by: params[13],
                });
            } else if (sql.includes('settings')) {
                settings.set(params[0], params[1]);
            }
        },
        exec() {},
        _lines: lines,
        _shrink: shrink,
        _rates: rates,
    };
}

test('buildSalesGrid rolls up grocery totals from entered categories', () => {
    const db = makeDb();
    saveSalesAmount(db, '2026-06-21', 1, 'grocery', 61587.12);
    saveSalesAmount(db, '2026-06-21', 1, 'fs_paper', 11330.6);
    saveSalesAmount(db, '2026-06-21', 1, 'meat', 21594.15);

    const sales = buildSalesGrid(db, '2026-06-21');
    assert.equal(sales.period_start, '2026-06-21');
    assert.equal(sales.week_ends.length, 5);
    assert.equal(roundMoney(sales.summary.meat[1]), 21594.15);
    assert.equal(roundMoney(sales.summary.grocery[1]), roundMoney(61587.12 + 11330.6));
});

test('froz meat rolls into meat not centre store; fees count in centre store', () => {
    const db = makeDb();
    saveSalesAmount(db, '2026-06-21', 1, 'grocery', 1000);
    saveSalesAmount(db, '2026-06-21', 1, 'frozen', 200);
    saveSalesAmount(db, '2026-06-21', 1, 'froz_meat', 500);
    saveSalesAmount(db, '2026-06-21', 1, 'dairy', 300);
    saveSalesAmount(db, '2026-06-21', 1, 'deposit', 40);
    saveSalesAmount(db, '2026-06-21', 1, 'enviro_fee', 10);
    saveSalesAmount(db, '2026-06-21', 1, 'handling_fee', 5);

    const sales = buildSalesGrid(db, '2026-06-21');
    assert.equal(roundMoney(sales.summary.meat[1]), 500);
    assert.equal(roundMoney(sales.summary.grocery[1]), roundMoney(1000 + 200 + 300 + 40 + 10 + 5));
    assert.equal(roundMoney(sales.summary.centre_store[1]), roundMoney(1000 + 200 + 40 + 10 + 5));
    const frozenRollup = sales.rollups.find((r) => r.key === 'frozen');
    assert.equal(roundMoney(frozenRollup.weeks[1]), 200);
});

test('buildReceivingTotalsPayload aggregates purchases and weekly shrink', () => {
    const db = makeDb();
    db._lines.push({
        store_date: '2026-06-21',
        grocery: 100,
        tobacco: 0,
        meat: 50,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        dairy: 25,
        pharmacy: 0,
    });
    db._shrink.push({
        store_date: '2026-06-21',
        department: 'grocery',
        extended_cost: 10,
    });
    db._shrink.push({
        store_date: '2026-06-27',
        department: 'bakery',
        extended_cost: 20,
    });

    const totals = buildReceivingTotalsPayload(db, '2026-06-21');
    assert.equal(totals.days.length, 35);
    assert.equal(roundMoney(totals.purchase_totals.grocery), 100);
    assert.equal(roundMoney(totals.weekly_shrink[0].shrink.grocery), 10);
    assert.equal(roundMoney(totals.weekly_shrink[0].shrink.bakery), 20);
});

test('aggregateDailyPurchases counts invoice lines only (not write_off or spacer)', () => {
    const db = makeDb();
    db._lines.push(
        {
            store_date: '2026-06-21',
            line_kind: 'invoice',
            grocery: 100,
            tobacco: 0, meat: 0, bakery: 0, bakery_in_store: 0, deli: 0,
            produce: 0, produce_shrink: 0, dairy: 0, pharmacy: 0,
        },
        {
            store_date: '2026-06-21',
            line_kind: 'write_off',
            grocery: -40,
            tobacco: 0, meat: 0, bakery: 0, bakery_in_store: 0, deli: 0,
            produce: 0, produce_shrink: -120, dairy: 0, pharmacy: 0,
        },
        {
            store_date: '2026-06-21',
            line_kind: 'spacer',
            grocery: 999,
            tobacco: 0, meat: 0, bakery: 0, bakery_in_store: 0, deli: 0,
            produce: 0, produce_shrink: 0, dairy: 0, pharmacy: 0,
        },
    );

    const byDate = aggregateDailyPurchases(db, '2026-06-21', '2026-06-21');
    assert.equal(roundMoney(byDate['2026-06-21'].purchases.grocery), 100);
    assert.equal(roundMoney(byDate['2026-06-21'].purchases.produce_shrink), 0);
});

test('legacy_fixed_allocation folds daily N3 freight into purchase columns', () => {
    const db = makeDb();
    db._lines.push({
        store_date: '2026-06-21',
        grocery: 100,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        dairy: 20,
        pharmacy: 0,
    });
    db._days = [{ store_date: '2026-06-21', freight_total: 1000 }];
    const baseAll = db.all.bind(db);
    db.all = (sql, ...params) => {
        if (String(sql).includes('FROM receiving_report_day')) {
            return db._days.filter((d) => d.store_date >= params[0] && d.store_date <= params[1]);
        }
        return baseAll(sql, ...params);
    };

    const totals = buildReceivingTotalsPayload(db, '2026-06-21', {
        costingMode: COSTING_MODE.WORKBOOK_ALLOC,
    });
    // 1000 × 0.478 grocery + 1000 × 0.142 dairy
    assert.equal(roundMoney(totals.purchase_totals.grocery), 578);
    assert.equal(roundMoney(totals.purchase_totals.dairy), 162);
    assert.equal(roundMoney(totals.purchase_totals.meat), 99);
    const margin = buildMarginPayload(db, '2026-06-21', {
        costingMode: COSTING_MODE.WORKBOOK_ALLOC,
    });
    // Margin grocery+dairy purchases = 578 + 162
    assert.equal(roundMoney(margin.totals.purchases), 740);
});

test('base_cost_only costing keeps freight as memo and does not inflate purchases', () => {
    const db = makeDb();
    db._lines.push({
        store_date: '2026-06-21',
        grocery: 100,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        dairy: 20,
        pharmacy: 0,
    });
    db._days = [{ store_date: '2026-06-21', freight_total: 1000 }];
    const baseAll = db.all.bind(db);
    db.all = (sql, ...params) => {
        if (String(sql).includes('FROM receiving_report_day')) {
            return db._days.filter((d) => d.store_date >= params[0] && d.store_date <= params[1]);
        }
        return baseAll(sql, ...params);
    };

    const smsTotals = buildReceivingTotalsPayload(db, '2026-06-21', {
        costingMode: COSTING_MODE.SMS_LANDED,
    });
    assert.equal(smsTotals.costing_mode, 'base_cost_only');
    assert.equal(smsTotals.freight_allocated, false);
    assert.equal(roundMoney(smsTotals.freight_memo_total), 1000);
    assert.equal(roundMoney(smsTotals.purchase_totals.grocery), 100);
    assert.equal(roundMoney(smsTotals.purchase_totals.dairy), 20);

    const smsMargin = buildMarginPayload(db, '2026-06-21', {
        costingMode: COSTING_MODE.SMS_LANDED,
    });
    assert.equal(roundMoney(smsMargin.totals.purchases), 120);

    const compare = buildCostingComparisonPayload(db, '2026-06-21');
    assert.equal(roundMoney(compare.modes.workbook_alloc.grocery_dairy_purchases), 740);
    assert.equal(roundMoney(compare.modes.sms_landed.grocery_dairy_purchases), 120);
    assert.equal(roundMoney(compare.modes.legacy_fixed_allocation.grocery_dairy_purchases), 740);
    assert.equal(roundMoney(compare.modes.base_cost_only.grocery_dairy_purchases), 120);
});

test('buildReceivingTotalsPayload nets rebate lines into purchase totals', () => {
    const db = makeDb();
    db._lines.push({
        store_date: '2026-06-21',
        grocery: 1000,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        dairy: 200,
        pharmacy: 0,
    });
    const baseAll = db.all.bind(db);
    db.all = (sql, ...params) => {
        if (String(sql).includes('receiving_report_rebate_lines')) {
            return [{
                grocery: -100,
                dairy: -25,
                tobacco: 0,
                meat: 0,
                bakery: 0,
                bakery_in_store: 0,
                deli: 0,
                produce: 0,
                produce_shrink: 0,
                pharmacy: 0,
                gst: 0,
            }];
        }
        return baseAll(sql, ...params);
    };

    const totals = buildReceivingTotalsPayload(db, '2026-06-21');
    assert.equal(roundMoney(totals.purchase_totals.grocery), 900);
    assert.equal(roundMoney(totals.purchase_totals.dairy), 175);
});

test('buildMarginPayload computes gross margin from sales purchases and inventory', () => {
    const db = makeDb();
    saveSalesAmount(db, '2026-06-21', 1, 'grocery', 100000);
    saveSalesAmount(db, '2026-06-21', 2, 'grocery', 100000);
    saveSalesAmount(db, '2026-06-21', 3, 'grocery', 100000);
    saveSalesAmount(db, '2026-06-21', 4, 'grocery', 100000);
    db._lines.push({
        store_date: '2026-06-21',
        grocery: 50000,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        dairy: 0,
        pharmacy: 0,
    });
    saveMarginMeta(db, '2026-06-21', {
        opening_inventory: 1000000,
        closing_inventory: 960000,
        sms_margin_pct: 0.15,
    });

    const margin = buildMarginPayload(db, '2026-06-21');
    assert.equal(roundMoney(margin.totals.sales), 400000);
    assert.equal(roundMoney(margin.totals.purchases), 50000);
    assert.equal(roundMoney(margin.totals.cogs), 90000);
    assert.equal(roundMoney(margin.totals.gross_profit), 310000);
    assert.ok(margin.totals.gross_margin_pct > 0.77);
});

test('buildTotalReportPayload lists invoice numbers by day column', () => {
    const db = makeDb();
    db._lines.push(
        {
            store_date: '2026-06-21',
            invoice_number: 'INV-100',
            line_kind: 'invoice',
            supplier_name: 'Vendor A',
        },
        {
            store_date: '2026-06-21',
            invoice_number: 'INV-101',
            line_kind: 'invoice',
            supplier_name: 'Vendor B',
        },
        {
            store_date: '2026-06-22',
            invoice_number: 'INV-200',
            line_kind: 'invoice',
            supplier_name: 'Vendor C',
        },
        {
            store_date: '2026-06-21',
            invoice_number: '',
            line_kind: 'spacer',
            supplier_name: '',
        },
    );

    const report = buildTotalReportPayload(db, '2026-06-21');
    assert.equal(report.period_start, '2026-06-21');
    assert.equal(report.columns.length, 35);
    assert.equal(report.invoice_count, 3);
    assert.deepEqual(report.columns[0].invoices.map((i) => i.invoice_number), ['INV-100', 'INV-101']);
    assert.equal(report.columns[1].invoices[0].invoice_number, 'INV-200');
});
