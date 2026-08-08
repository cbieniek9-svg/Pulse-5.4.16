'use strict';
process.env.TGP_DATA_DIR = process.env.TGP_DATA_DIR || 'E:\\Live\\TGPV5\\TGP_V5';
const { db } = require('../src/db.cjs');
const { buildMarginPayload, buildReceivingTotalsPayload } = require('../src/lib/edmonton-receiving-analytics.cjs');
const { buildCountCyclePayload } = require('../src/lib/edmonton-receiving-count-cycle.cjs');

const periods = db.all(
    `SELECT period_start, period_number, opening_inventory, closing_inventory, is_count_period
       FROM receiving_report_margin
      ORDER BY period_number ASC`,
) || [];

const cycles = db.all('SELECT * FROM receiving_report_count_cycles ORDER BY period_number_end ASC') || [];

const freight = db.all(
    `SELECT SUM(freight_total) AS total, COUNT(*) AS days_with_freight
       FROM receiving_report_day
      WHERE freight_total IS NOT NULL AND freight_total != 0`,
)?.[0];

console.log('=== PERIODS IN DB ===');
console.log(JSON.stringify(periods, null, 2));
console.log('=== COUNT CYCLES ===');
console.log(JSON.stringify(cycles, null, 2));
console.log('=== FREIGHT IN DAY META ===', freight);

const p9 = periods.find((p) => Number(p.period_number) === 9);
if (p9) {
    const recv = buildReceivingTotalsPayload(db, p9.period_start);
    const margin = buildMarginPayload(db, p9.period_start);
    const cycle = buildCountCyclePayload(db, p9.period_start);
    console.log('=== P9 PURCHASES (pulse) ===', {
        grocery: recv.purchase_totals.grocery,
        dairy: recv.purchase_totals.dairy,
        grocery_plus_dairy: recv.purchase_totals.grocery + recv.purchase_totals.dairy,
        invoice_lines: db.get(
            'SELECT COUNT(*) n FROM receiving_report_lines WHERE store_date >= ? AND store_date <= ?',
            p9.period_start,
            recv.period_end,
        )?.n,
    });
    console.log('=== P9 COUNT CYCLE PERIODS ===', (cycle.periods || []).map((p) => ({
        n: p.period_number,
        start: p.period_start,
        missing: p.missing,
        purch_tg: p.purchases?.total_grocery,
        sales_tg: p.sales?.total_grocery,
    })));
    console.log('=== P9 CYCLE TOTAL GROCERY ===', cycle.departments?.total_grocery);
}
