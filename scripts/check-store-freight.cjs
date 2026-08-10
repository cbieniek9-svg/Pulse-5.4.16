'use strict';

/**
 * Compare store DB freight/purchases vs an Excel workbook Total Grocery sheet.
 *
 * Usage:
 *   set TGP_DATA_DIR=<folder with tgp_ops.db>
 *   npx electron scripts/check-store-freight.cjs "path/to/workbook.xlsx"
 */

const path = require('path');
const {
    parseWorkbookFile,
    summarizeWorkbook,
    readCountCycleBlock,
} = require('../src/lib/edmonton-receiving-workbook-import.cjs');
const { buildReceivingTotalsPayload } = require('../src/lib/edmonton-receiving-analytics.cjs');
const { buildCountCyclePayload } = require('../src/lib/edmonton-receiving-count-cycle.cjs');
const { addDays } = require('../src/lib/edmonton-receiving-report.cjs');

const CYCLE_PURCHASE_CELLS = ['N15', 'N16', 'N17'];

async function main() {
    const workbookPath = process.argv[2];
    if (!workbookPath) {
        console.error('Usage: check-store-freight.cjs <workbook.xlsx>');
        console.error('Requires TGP_DATA_DIR pointing at a folder that contains tgp_ops.db.');
        process.exit(1);
    }
    if (!process.env.TGP_DATA_DIR) {
        console.error('TGP_DATA_DIR must be set (no live-path fallback).');
        process.exit(1);
    }

    const { db } = require('../src/db.cjs');
    const wb = await parseWorkbookFile(path.resolve(workbookPath));
    const tg = wb.Sheets['Total Grocery'];
    if (!tg) {
        throw new Error('Total Grocery sheet missing');
    }

    const summary = summarizeWorkbook(wb);
    const cycleBlock = readCountCycleBlock(wb);
    if (!summary.period_start || summary.period_number == null) {
        throw new Error('Could not derive period start/number from workbook; refusing to compare freight.');
    }
    if (!cycleBlock
        || cycleBlock.period_number_start == null
        || cycleBlock.period_number_end == null) {
        throw new Error('Workbook is missing a Periods X–Y count-cycle block; cannot validate freight periods.');
    }
    if (!cycleBlock.applies_to_this_workbook) {
        throw new Error(
            `Workbook Period ${summary.period_number} is not the count-cycle end period `
            + `(${cycleBlock.period_number_end}); refuse hard-coded freight compare.`,
        );
    }
    const startNum = Number(cycleBlock.period_number_start);
    const endNum = Number(cycleBlock.period_number_end);
    const span = endNum - startNum;
    if (!Number.isFinite(startNum) || !Number.isFinite(endNum) || span !== 2) {
        throw new Error(
            `Expected a 3-period count cycle for N15–N17; got Periods ${startNum}–${endNum}.`,
        );
    }

    function freightAlloc(total) {
        return Math.round((total * 0.478 + total * 0.142) * 100) / 100;
    }

    const endPeriodStart = summary.period_start;
    const periods = CYCLE_PURCHASE_CELLS.map((addr, i) => ({
        num: startNum + i,
        start: addDays(endPeriodStart, (i - span) * 35),
        excelPurch: tg[addr]?.v,
    }));

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

    const cycle = buildCountCyclePayload(db, endPeriodStart);
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
