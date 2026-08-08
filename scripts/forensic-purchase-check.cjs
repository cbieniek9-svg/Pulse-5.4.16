'use strict';
process.env.TGP_DATA_DIR = process.env.TGP_DATA_DIR || require('path').join(__dirname, '..', 'data', 'forensic-audit');
const { db } = require('../src/db.cjs');
const { parseWorkbookFile } = require('../src/lib/edmonton-receiving-workbook-import.cjs');
const { buildReceivingTotalsPayload } = require('../src/lib/edmonton-receiving-analytics.cjs');

async function main() {
    const periodStart = '2026-06-21';
    const wb = await parseWorkbookFile('e:\\9. Edmonton Wholesale Market Receiving Report 2026Jul18.xlsx');
    const tg = wb.Sheets['Total Grocery'];

    const pulse = buildReceivingTotalsPayload(db, periodStart);
    const lineSum = db.get(
        `SELECT SUM(grocery) AS grocery, SUM(dairy) AS dairy, SUM(meat) AS meat,
            SUM(produce) AS produce, SUM(produce_shrink) AS produce_shrink, SUM(tobacco) AS tobacco
       FROM receiving_report_lines WHERE store_date >= ? AND store_date <= ?`,
        periodStart,
        pulse.period_end,
    );
    const rebateSum = db.get(
        `SELECT SUM(grocery) AS grocery, SUM(dairy) AS dairy,
            SUM(grocery+dairy) AS gd,
            SUM(grocery+dairy+meat+produce+produce_shrink+tobacco+bakery+bakery_in_store+deli+pharmacy) AS all_depts
       FROM receiving_report_rebate_lines WHERE period_start=?`,
        periodStart,
    );

    console.log(JSON.stringify({
        excel_B17_purchases: tg.B17?.v,
        pulse_grocery_plus_dairy: pulse.purchase_totals.grocery + pulse.purchase_totals.dairy,
        pulse_purchase_totals: pulse.purchase_totals,
        line_sums: lineSum,
        rebate_sums: rebateSum,
        period_end: pulse.period_end,
        invoice_lines: db.get('SELECT COUNT(*) AS n FROM receiving_report_lines WHERE store_date >= ? AND store_date <= ?', periodStart, pulse.period_end)?.n,
    }, null, 2));
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
