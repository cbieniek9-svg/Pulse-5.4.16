'use strict';
process.env.TGP_DATA_DIR = process.env.TGP_DATA_DIR || 'E:\\Live\\TGPV5\\TGP_V5';
const { db } = require('../src/db.cjs');
const { buildReceivingTotalsPayload } = require('../src/lib/edmonton-receiving-analytics.cjs');
const { buildCountCyclePayload } = require('../src/lib/edmonton-receiving-count-cycle.cjs');

const { parseWorkbookFile } = require('../src/lib/edmonton-receiving-workbook-import.cjs');

async function main() {
    const wb = await parseWorkbookFile('e:\\9. Edmonton Wholesale Market Receiving Report 2026Jul18.xlsx');
    const tg = wb.Sheets['Total Grocery'];

    function freightAlloc(total) {
        return Math.round((total * 0.478 + total * 0.142) * 100) / 100;
    }

    const periods = [
        { num: 7, start: '2026-04-19', excelPurch: tg.N15?.v },
        { num: 8, start: '2026-05-24', excelPurch: tg.N16?.v },
        { num: 9, start: '2026-06-21', excelPurch: tg.N17?.v },
    ];

    console.log('=== STORE DB vs EXCEL COUNT-CYCLE PURCHASES ===');
    periods.forEach(({ num, start, excelPurch }) => {
        const r = buildReceivingTotalsPayload(db, start);
        const pulseGd = r.purchase_totals.grocery + r.purchase_totals.dairy;
        const freight = db.get(
            'SELECT SUM(freight_total) AS s FROM receiving_report_day WHERE store_date >= ? AND store_date <= ?',
            start,
            r.period_end,
        )?.s || 0;
        const withFreight = pulseGd + freightAlloc(freight);
        console.log({
            period: num,
            excel_N: excelPurch,
            pulse_lines_rebates: pulseGd,
            pulse_plus_freight_alloc: withFreight,
            freight_raw_N3_sum: freight,
            delta_vs_excel: Math.round((excelPurch - pulseGd) * 100) / 100,
            delta_if_freight_added: Math.round((excelPurch - withFreight) * 100) / 100,
        });
    });

    const cycle = buildCountCyclePayload(db, '2026-06-21');
    console.log('=== COUNT CYCLE PERIOD LIST ===', (cycle.periods || []).map((p) => p.period_number));
    console.log('=== CYCLE TOTAL GROCERY ===', {
        opening: cycle.departments?.total_grocery?.opening,
        purchases: cycle.departments?.total_grocery?.purchases_total,
        closing: cycle.departments?.total_grocery?.closing,
        cogs: cycle.departments?.total_grocery?.cogs,
        sales: cycle.departments?.total_grocery?.sales_total,
        gp: cycle.departments?.total_grocery?.gross_profit,
        gp_pct: cycle.departments?.total_grocery?.gross_margin_pct,
    });
    console.log('=== EXCEL CYCLE BLOCK ===', {
        opening: tg.N14?.v,
        purchases: tg.N18?.v,
        closing: tg.N20?.v,
        cogs: tg.N21?.v,
        gp: tg.N22?.v,
        gp_pct: tg.N23?.v,
    });
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
