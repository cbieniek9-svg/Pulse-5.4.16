'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildDeptMarginPayload,
    buildRebatesPayload,
    buildRecountsPayload,
    buildMarginYtdPayload,
} = require('../src/lib/edmonton-receiving-extended.cjs');

function makeDb() {
    const settings = new Map([
        ['Receiving_Report_Period_Start', '2026-06-21'],
        ['Receiving_Report_Period_Number', '5'],
    ]);
    const sales = new Map();
    const deptMargin = new Map();
    const rebates = [];
    const recounts = [];
    const snapshots = [];
    const lines = [{
        store_date: '2026-06-21',
        grocery: 1000,
        tobacco: 200,
        meat: 300,
        dairy: 150,
        produce: 80,
        produce_shrink: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        pharmacy: 0,
    }];
    const shrink = [{
        store_date: '2026-06-21',
        department: 'grocery',
        extended_cost: 12,
    }];

    return {
        get(sql, ...params) {
            if (sql.includes('FROM settings')) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            if (sql.includes('FROM receiving_report_dept_margin')) {
                return deptMargin.get(`${params[0]}:${params[1]}`) || null;
            }
            if (sql.includes('FROM receiving_report_period_snapshots')) {
                return snapshots.find((s) => s.period_start === params[0]) || null;
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('FROM receiving_report_sales')) {
                return [...sales.values()].filter((row) => row.period_start === params[0]);
            }
            if (sql.includes('FROM receiving_report_lines')) {
                if (sql.includes('WHERE store_date=?')) {
                    return lines.filter((row) => row.store_date === params[0]);
                }
                return lines.filter((row) => row.store_date >= params[0] && row.store_date <= params[1]);
            }
            if (sql.includes('FROM receiving_shrink_lines')) {
                return shrink.filter((row) => row.store_date >= params[0] && row.store_date <= params[1]);
            }
            if (sql.includes('FROM receiving_report_rebate_lines')) {
                return rebates.filter((row) => row.period_start === params[0]);
            }
            if (sql.includes('FROM receiving_report_recounts')) {
                return recounts.filter((row) => row.period_start === params[0]);
            }
            if (sql.includes('FROM receiving_report_period_snapshots')) {
                return snapshots;
            }
            if (sql.includes('FROM receiving_report_sales_history')) {
                return [];
            }
            return [];
        },
        run() {},
        _sales: sales,
        _rebates: rebates,
        _recounts: recounts,
        _snapshots: snapshots,
    };
}

test('buildDeptMarginPayload computes tobacco and centre store margins', () => {
    const db = makeDb();
    db._sales.set('2026-06-21:1:tobacco', {
        period_start: '2026-06-21', week_num: 1, category_key: 'tobacco', amount: 5000,
    });
    db._sales.set('2026-06-21:1:grocery', {
        period_start: '2026-06-21', week_num: 1, category_key: 'grocery', amount: 10000,
    });
    db._sales.set('2026-06-21:1:dairy', {
        period_start: '2026-06-21', week_num: 1, category_key: 'dairy', amount: 2000,
    });

    const tobacco = buildDeptMarginPayload(db, '2026-06-21', 'tobacco');
    assert.equal(tobacco.department, 'tobacco');
    assert.equal(tobacco.has_shrink, false);

    const centre = buildDeptMarginPayload(db, '2026-06-21', 'centre_store');
    assert.equal(centre.department, 'centre_store');
    assert.ok(centre.has_shrink);
});

test('buildRebatesPayload and buildRecountsPayload return empty structures', () => {
    const db = makeDb();
    const rebates = buildRebatesPayload(db, '2026-06-21');
    assert.equal(rebates.line_count, 0);

    const recounts = buildRecountsPayload(db, '2026-06-21');
    assert.equal(recounts.row_count, 0);
});

test('buildMarginYtdPayload includes current period row', () => {
    const db = makeDb();
    const ytd = buildMarginYtdPayload(db, '2026-06-21');
    assert.ok(ytd.rows.length >= 1);
    assert.ok(ytd.rows.some((row) => row.period_start === '2026-06-21'));
});
