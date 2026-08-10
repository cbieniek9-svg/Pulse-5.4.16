'use strict';

/**
 * Forensic audit: compare Pulse margin math vs Excel workbook values.
 *
 * Usage:
 *   set TGP_DATA_DIR=<folder with imported tgp_ops.db>
 *   npx electron scripts/forensic-margin-audit.cjs "path/to/workbook.xlsx"
 */

const path = require('path');
const { parseWorkbookFile } = require('../src/lib/edmonton-receiving-workbook-import.cjs');
const { buildMarginPayload, buildReceivingTotalsPayload } = require('../src/lib/edmonton-receiving-analytics.cjs');
const { buildCountCyclePayload } = require('../src/lib/edmonton-receiving-count-cycle.cjs');
const { buildDeptMarginPayload } = require('../src/lib/edmonton-receiving-extended.cjs');

const DEPT_SHEET_NAMES = {
    centre_store: ['Centre Store'],
    dairy: ['Dairy'],
    meat: ['Meat'],
    produce: ['Produce'],
    tobacco: ['Tobacco New', 'Tobacco'],
};

function cellMoney(ws, addr) {
    const raw = ws?.[addr]?.v;
    if (raw === '' || raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function findSheet(wb, names) {
    for (const name of names) {
        if (wb.Sheets[name]) return wb.Sheets[name];
    }
    return null;
}

function diff(excel, pulse) {
    if (excel == null || pulse == null) return null;
    return Math.round((excel - pulse) * 100) / 100;
}

function pctDiff(excel, pulse) {
    if (excel == null || pulse == null) return null;
    return Math.round((excel - pulse) * 1e6) / 1e6;
}

function compareRow(label, excelVal, pulseVal, tolerance = 0.02) {
    const d = typeof excelVal === 'number' && typeof pulseVal === 'number'
        ? (Math.abs(excelVal) < 1 && Math.abs(pulseVal) < 1 ? pctDiff(excelVal, pulseVal) : diff(excelVal, pulseVal))
        : null;
    const match = d == null ? 'n/a' : (Math.abs(d) <= tolerance ? 'MATCH' : 'DIFF');
    return { label, excel: excelVal, pulse: pulseVal, delta: d, status: match };
}

function auditSection(title, rows) {
    const diffs = rows.filter((r) => r.status === 'DIFF');
    return { title, rows, pass: diffs.length === 0, diff_count: diffs.length };
}

function readExcelSinglePeriod(tg) {
    return {
        opening: cellMoney(tg, 'B16'),
        purchases: cellMoney(tg, 'B17'),
        goods_available: cellMoney(tg, 'B18'),
        closing: cellMoney(tg, 'B19'),
        cogs: cellMoney(tg, 'B20'),
        gross_profit: cellMoney(tg, 'B21'),
        gross_margin_pct: cellMoney(tg, 'B22'),
        sales: cellMoney(tg, 'B20') != null && cellMoney(tg, 'B21') != null
            ? Math.round((cellMoney(tg, 'B20') + cellMoney(tg, 'B21')) * 100) / 100
            : null,
    };
}

function readExcelCountCycle(tg) {
    return {
        opening: cellMoney(tg, 'N14'),
        purchases_p7: cellMoney(tg, 'N15'),
        purchases_p8: cellMoney(tg, 'N16'),
        purchases_p9: cellMoney(tg, 'N17'),
        purchases: cellMoney(tg, 'N18'),
        goods_available: cellMoney(tg, 'N19'),
        closing: cellMoney(tg, 'N20') ?? cellMoney(tg, 'K11'),
        cogs: cellMoney(tg, 'N21'),
        gross_profit: cellMoney(tg, 'N22'),
        gross_margin_pct: cellMoney(tg, 'N23'),
        sales: cellMoney(tg, 'N21') != null && cellMoney(tg, 'N22') != null
            ? Math.round((cellMoney(tg, 'N21') + cellMoney(tg, 'N22')) * 100) / 100
            : null,
    };
}

function readExcelDeptSingle(ws) {
    if (!ws) return null;
    const cogs = cellMoney(ws, 'B20');
    const gp = cellMoney(ws, 'B21');
    return {
        opening: cellMoney(ws, 'B16'),
        purchases: cellMoney(ws, 'B17'),
        closing: cellMoney(ws, 'B19'),
        cogs,
        gross_profit: gp,
        gross_margin_pct: cellMoney(ws, 'B22'),
        sales: cogs != null && gp != null ? Math.round((cogs + gp) * 100) / 100 : null,
    };
}

function readExcelDeptCycle(ws) {
    if (!ws) return null;
    const cogs = cellMoney(ws, 'G21') ?? cellMoney(ws, 'N21');
    const gp = cellMoney(ws, 'G22') ?? cellMoney(ws, 'N22');
    return {
        opening: cellMoney(ws, 'G14'),
        purchases: cellMoney(ws, 'G18') ?? cellMoney(ws, 'N18'),
        closing: cellMoney(ws, 'G20'),
        cogs,
        gross_profit: gp,
        gross_margin_pct: cellMoney(ws, 'G23') ?? cellMoney(ws, 'N23'),
        sales: cogs != null && gp != null ? Math.round((cogs + gp) * 100) / 100 : null,
    };
}

async function runAudit(workbookPath) {
    const appRoot = path.join(__dirname, '..');
    process.env.TGP_DATA_DIR = process.env.TGP_DATA_DIR || path.join(appRoot, 'data', 'forensic-audit');

    const { db } = require('../src/db.cjs');
    const wb = await parseWorkbookFile(workbookPath);
    const tg = wb.Sheets['Total Grocery'];
    if (!tg) throw new Error('Total Grocery sheet missing');

    const periodRow = db.get('SELECT period_start, period_number FROM receiving_report_margin ORDER BY period_start DESC LIMIT 1');
    if (!periodRow?.period_start) {
        throw new Error('No receiving_report_margin row found — import workbook data before auditing.');
    }
    const periodStart = periodRow.period_start;
    const periodNumber = periodRow.period_number;

    const excelSingle = readExcelSinglePeriod(tg);
    const excelCycle = readExcelCountCycle(tg);
    const margin = buildMarginPayload(db, periodStart);
    const receiving = buildReceivingTotalsPayload(db, periodStart);
    const cycle = buildCountCyclePayload(db, periodStart);
    const pulseCycle = cycle.departments?.total_grocery || {};

    const singleRows = [
        compareRow('Opening inventory', excelSingle.opening, margin.meta.opening_inventory),
        compareRow('Purchases (grocery+dairy+rebates)', excelSingle.purchases, margin.totals.purchases),
        compareRow('Goods available', excelSingle.goods_available, margin.totals.goods_available),
        compareRow('Closing inventory', excelSingle.closing, margin.meta.closing_inventory),
        compareRow('COGS', excelSingle.cogs, margin.totals.cogs),
        compareRow('Sales (5 weeks)', excelSingle.sales, margin.totals.sales),
        compareRow('Gross profit $', excelSingle.gross_profit, margin.totals.gross_profit),
        compareRow('Gross margin %', excelSingle.gross_margin_pct, margin.totals.gross_margin_pct, 0.0001),
    ];

    const cycleRows = [
        compareRow('Cycle opening', excelCycle.opening, pulseCycle.opening ?? cycle.cycle_opening?.total_grocery),
        compareRow('Cycle purchases (sum P7+P8+P9)', excelCycle.purchases, pulseCycle.purchases),
        compareRow('Counted closing', excelCycle.closing, pulseCycle.closing ?? cycle.counted_closing?.total_grocery),
        compareRow('Cycle COGS', excelCycle.cogs, pulseCycle.cogs),
        compareRow('Cycle sales (sum P7+P8+P9)', excelCycle.sales, pulseCycle.sales),
        compareRow('Cycle gross profit $', excelCycle.gross_profit, pulseCycle.gross_profit),
        compareRow('Cycle gross margin %', excelCycle.gross_margin_pct, pulseCycle.gross_margin_pct, 0.0001),
    ];

    const periodBreakdown = (cycle.periods || []).map((p) => ({
        period_number: p.period_number,
        period_start: p.period_start,
        missing: p.missing,
        purchases_total_grocery: p.purchases?.total_grocery,
        sales_total_grocery: p.sales?.total_grocery,
        excel_purchases: p.period_number === 7 ? excelCycle.purchases_p7
            : p.period_number === 8 ? excelCycle.purchases_p8
                : p.period_number === 9 ? excelCycle.purchases_p9 : null,
        purchase_delta: p.period_number === 7 ? diff(excelCycle.purchases_p7, p.purchases?.total_grocery)
            : p.period_number === 8 ? diff(excelCycle.purchases_p8, p.purchases?.total_grocery)
                : p.period_number === 9 ? diff(excelCycle.purchases_p9, p.purchases?.total_grocery) : null,
    }));

    const deptAudits = [];
    Object.entries(DEPT_SHEET_NAMES).forEach(([dept, names]) => {
        const ws = findSheet(wb, names);
        const excelDept = readExcelDeptSingle(ws);
        const pulseDept = buildDeptMarginPayload(db, periodStart, dept)?.totals;
        if (!excelDept || !pulseDept) return;
        deptAudits.push({
            department: dept,
            single_period: [
                compareRow('Opening', excelDept.opening, pulseDept.opening_inventory),
                compareRow('Purchases', excelDept.purchases, pulseDept.purchases),
                compareRow('Closing', excelDept.closing, pulseDept.closing_inventory),
                compareRow('COGS', excelDept.cogs, pulseDept.cogs),
                compareRow('Sales', excelDept.sales, pulseDept.sales),
                compareRow('GP$', excelDept.gross_profit, pulseDept.gross_profit),
                compareRow('GP%', excelDept.gross_margin_pct, pulseDept.gross_margin_pct, 0.0001),
            ],
        });
    });

    const purchaseDetail = {
        pulse_purchase_totals: receiving.purchase_totals,
        pulse_rebate_lines: db.all('SELECT COUNT(*) AS n, SUM(grocery+dairy+meat+produce+produce_shrink+tobacco) AS total FROM receiving_report_rebate_lines WHERE period_start=?', periodStart)?.[0],
    };

    const sections = [
        auditSection(`Period ${periodNumber} — Single-period Total Grocery (Excel B16–B22 vs Pulse Margin tab)`, singleRows),
        auditSection(`Periods 7–9 — Count Cycle Total Grocery (Excel N14–N23 vs Pulse Count Cycle)`, cycleRows),
    ];

    const deptDiffs = deptAudits.reduce(
        (n, d) => n + (d.single_period || []).filter((r) => r.status === 'DIFF').length,
        0,
    );
    const trustworthy = sections.every((s) => s.pass) && deptDiffs === 0;
    const cycleMissing = (cycle.periods || []).filter((p) => p.missing);

    return {
        workbook: workbookPath,
        period_start: periodStart,
        period_number: periodNumber,
        verdict: trustworthy && cycleMissing.length === 0 ? 'TRUSTWORTHY' : 'REVIEW_REQUIRED',
        trustworthy_single_period: sections[0].pass,
        trustworthy_count_cycle: sections[1].pass && cycleMissing.length === 0,
        trustworthy_dept_audits: deptDiffs === 0,
        sections,
        period_breakdown: periodBreakdown,
        missing_periods_in_db: cycleMissing.map((p) => p.period_number),
        dept_audits: deptAudits,
        purchase_detail: purchaseDetail,
        notes: [
            'Single-period margin uses B19 closing; Count Cycle uses N20/K11 counted closing — Excel intentionally differs between the two views.',
            'Count Cycle requires P7 and P8 data in the database (import those workbooks first). P9 workbook alone only loads P9 daily lines.',
            'Pulse nets rebate lines into purchases the same way Excel Receiving Totals does.',
        ],
    };
}

if (require.main === module) {
    const workbook = process.argv[2];
    if (!workbook) {
        console.error('Usage: forensic-margin-audit.cjs <workbook.xlsx>');
        process.exit(1);
    }
    runAudit(path.resolve(workbook)).then((report) => {
        console.log(JSON.stringify(report, null, 2));
    }).catch((e) => {
        console.error(e.stack || e.message || e);
        process.exit(1);
    });
}

module.exports = { runAudit };
