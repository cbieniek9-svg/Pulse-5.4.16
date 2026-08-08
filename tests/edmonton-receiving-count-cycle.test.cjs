'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const {
    buildCountCyclePayload,
    saveCountCycle,
} = require('../src/lib/edmonton-receiving-count-cycle.cjs');
const { readCountCycleBlock, parseWorkbookFile } = require('../src/lib/edmonton-receiving-workbook-import.cjs');

function makeDb() {
    const settings = new Map([
        ['Receiving_Report_Period_Start', '2026-06-14'],
        ['Receiving_Report_Period_Number', '9'],
    ]);
    const margin = new Map();
    const deptMargin = new Map();
    const cycles = new Map();
    const sales = new Map();
    const linesByDate = new Map();

    const seedPeriod = (periodStart, periodNumber, opts = {}) => {
        margin.set(periodStart, {
            period_start: periodStart,
            period_number: periodNumber,
            opening_inventory: opts.opening ?? 100000,
            closing_inventory: opts.closing ?? 110000,
            is_count_period: opts.is_count_period || 0,
            updated_at: null,
            updated_by: '',
            variance_explanation: '',
        });
        ['centre_store', 'dairy', 'meat', 'produce', 'tobacco'].forEach((dept) => {
            deptMargin.set(`${periodStart}:${dept}`, {
                period_start: periodStart,
                department: dept,
                opening_inventory: (opts.opening ?? 100000) * 0.2,
                closing_inventory: (opts.closing ?? 110000) * 0.2,
            });
        });
        for (let i = 0; i < 35; i += 1) {
            const d = new Date(`${periodStart}T12:00:00Z`);
            d.setUTCDate(d.getUTCDate() + i);
            const storeDate = d.toISOString().slice(0, 10);
            linesByDate.set(storeDate, [{
                store_date: storeDate,
                grocery: 1000,
                dairy: 200,
                meat: 150,
                produce: 80,
                tobacco: 50,
                produce_shrink: 0,
                bakery: 0,
                bakery_in_store: 0,
                deli: 0,
                pharmacy: 0,
            }]);
        }
        for (let week = 1; week <= 5; week += 1) {
            [
                ['grocery', 20000],
                ['dairy', 4000],
                ['meat', 3000],
                ['produce', 2000],
                ['cigarettes', 1000],
            ].forEach(([category_key, amount]) => {
                sales.set(`${periodStart}:${category_key}:${week}`, {
                    period_start: periodStart,
                    week_num: week,
                    category_key,
                    amount,
                });
            });
        }
    };

    return {
        seedPeriod,
        get(sql, ...params) {
            if (sql.includes('FROM settings')) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            if (sql.includes('FROM receiving_report_margin') && sql.includes('period_number=?')) {
                for (const row of margin.values()) {
                    if (Number(row.period_number) === Number(params[0])) {
                        return { period_start: row.period_start };
                    }
                }
                return null;
            }
            if (sql.includes('FROM receiving_report_margin') && sql.includes('period_start >')) {
                const after = params[0];
                const next = [...margin.values()]
                    .filter((row) => row.period_start > after)
                    .sort((a, b) => a.period_start.localeCompare(b.period_start))[0];
                return next ? { period_start: next.period_start } : null;
            }
            if (sql.includes('FROM receiving_report_margin') && sql.includes('is_count_period=1')) {
                const before = params[0];
                const flagged = [...margin.values()]
                    .filter((row) => Number(row.is_count_period) === 1 && row.period_start <= before)
                    .sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
                return flagged || null;
            }
            if (sql.includes('FROM receiving_report_margin')) {
                return margin.get(params[0]) || null;
            }
            if (sql.includes('FROM receiving_report_dept_margin')) {
                return deptMargin.get(`${params[0]}:${params[1]}`) || null;
            }
            if (sql.includes('FROM receiving_report_count_cycles') && sql.includes('period_number_end=?')) {
                for (const row of cycles.values()) {
                    if (Number(row.period_number_end) === Number(params[0])) return row;
                }
                return null;
            }
            if (sql.includes('FROM receiving_report_count_cycles')) {
                return cycles.get(params[0]) || null;
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('FROM receiving_report_sales')) {
                return [...sales.values()].filter((row) => row.period_start === params[0]);
            }
            if (sql.includes('FROM receiving_report_lines')) {
                if (sql.includes('WHERE store_date=?')) {
                    return linesByDate.get(params[0]) || [];
                }
                const out = [];
                for (const [date, rows] of linesByDate.entries()) {
                    if (date >= params[0] && date <= params[1]) out.push(...rows);
                }
                return out;
            }
            if (sql.includes('FROM receiving_shrink_lines')) return [];
            if (sql.includes('FROM receiving_report_rebate_lines')) return [];
            if (sql.includes('FROM receiving_report_count_cycles')) {
                return [...cycles.values()];
            }
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('settings') && params.length >= 2) {
                const key = String(params[0]).includes('Receiving') ? params[0] : params[1];
                const val = String(params[0]).includes('Receiving') ? params[1] : params[0];
                if (String(key).includes('Receiving') || String(val).includes('Receiving')) {
                    settings.set(
                        String(params[0]).startsWith('Receiving') ? params[0] : params[1],
                        String(params[0]).startsWith('Receiving') ? params[1] : params[0],
                    );
                } else {
                    settings.set(params[0], params[1]);
                }
                return;
            }
            if (sql.includes('INSERT INTO receiving_report_margin')) {
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
                return;
            }
            if (sql.includes('UPDATE receiving_report_margin')) {
                const start = params[14];
                const existing = margin.get(start) || { period_start: start };
                margin.set(start, {
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
                return;
            }
            if (sql.includes('receiving_report_dept_margin')) {
                // Best-effort: saveCountCycle may patch closings
                return;
            }
            if (sql.includes('INSERT INTO receiving_report_count_cycles')) {
                cycles.set(params[0], {
                    cycle_end_period_start: params[0],
                    period_number_start: params[1],
                    period_number_end: params[2],
                    period_starts_json: params[3],
                    counted_closing_total_grocery: params[4],
                    counted_closing_centre_store: params[5],
                    counted_closing_dairy: params[6],
                    counted_closing_meat: params[7],
                    counted_closing_produce: params[8],
                    counted_closing_tobacco: params[9],
                    cycle_opening_total_grocery: params[10],
                    cycle_opening_centre_store: params[11],
                    cycle_opening_dairy: params[12],
                    cycle_opening_meat: params[13],
                    cycle_opening_produce: params[14],
                    cycle_opening_tobacco: params[15],
                    notes: params[16],
                    updated_at: params[17],
                    updated_by: params[18],
                });
                return;
            }
            if (sql.includes('UPDATE receiving_report_count_cycles')) {
                const start = params[params.length - 1];
                cycles.set(start, {
                    ...(cycles.get(start) || { cycle_end_period_start: start }),
                    period_number_start: params[0],
                    period_number_end: params[1],
                    period_starts_json: params[2],
                    counted_closing_total_grocery: params[3],
                    counted_closing_centre_store: params[4],
                    counted_closing_dairy: params[5],
                    counted_closing_meat: params[6],
                    counted_closing_produce: params[7],
                    counted_closing_tobacco: params[8],
                    cycle_opening_total_grocery: params[9],
                    cycle_opening_centre_store: params[10],
                    cycle_opening_dairy: params[11],
                    cycle_opening_meat: params[12],
                    cycle_opening_produce: params[13],
                    cycle_opening_tobacco: params[14],
                    notes: params[15],
                    updated_at: params[16],
                    updated_by: params[17],
                });
            }
        },
    };
}

test('buildCountCyclePayload rolls up three periods with counted closing', () => {
    const db = makeDb();
    db.seedPeriod('2026-04-05', 7, { opening: 1234103, closing: 1240000 });
    db.seedPeriod('2026-05-10', 8, { opening: 1240000, closing: 1250000 });
    db.seedPeriod('2026-06-14', 9, { opening: 1250000, closing: 1281561, is_count_period: 1 });

    const payload = buildCountCyclePayload(db, '2026-06-14');
    assert.deepEqual(payload.period_numbers, [7, 8, 9]);
    assert.equal(payload.cycle_complete, true);
    assert.ok(payload.departments.total_grocery);
    assert.equal(payload.departments.total_grocery.sales_by_period.length, 3);
    assert.ok(payload.departments.total_grocery.sales_total > 0);
    assert.ok(payload.departments.total_grocery.purchases_total > 0);

    const saved = saveCountCycle(db, {
        cycle_end_period_start: '2026-06-14',
        counted_closing_total_grocery: 1281560.71,
        cycle_opening_total_grocery: 1234102.76,
    }, 'tester');

    assert.equal(saved.is_count_period, true);
    assert.equal(saved.departments.total_grocery.closing, 1281560.71);
    assert.equal(saved.departments.total_grocery.opening, 1234102.76);
    assert.ok(Number.isFinite(saved.departments.total_grocery.gross_margin_pct));
});

test('readCountCycleBlock maps Excel Periods N–N+2 open/close cells', async () => {
    const workbookPath = 'C:/Users/SMS/Downloads/9. Edmonton Wholesale Market Receiving Report 2026Jul18 (1).xlsx';
    if (!fs.existsSync(workbookPath)) {
        return;
    }
    const wb = await parseWorkbookFile(workbookPath);
    const block = readCountCycleBlock(wb);
    assert.ok(block);
    assert.equal(block.period_number_start, 7);
    assert.equal(block.period_number_end, 9);
    assert.equal(block.applies_to_this_workbook, true);
    assert.equal(block.cycle_opening.total_grocery, 1234102.76);
    assert.equal(block.counted_closing.total_grocery, 1281560.71);
    assert.ok(block.cycle_opening.centre_store > 0);
    assert.ok(block.counted_closing.dairy > 0);
});
