'use strict';

const fs = require('fs');
const ExcelJS = require('exceljs');
const { roundMoney } = require('./parse-money.cjs');
const {
    templatePath,
    normalizeStoreDate,
    addDays,
    resolvePeriodStart,
    buildReportPayload,
    parseUtcDate,
    DATA_START_ROW,
    DATA_END_ROW,
    DEPT_COLS,
    setCellNumber,
    setCellText,
    clearDataRows,
    writeLineToSheet,
} = require('./edmonton-receiving-report.cjs');
const {
    buildSalesGrid,
    buildReceivingTotalsPayload,
    buildMarginPayload,
    buildTotalReportPayload,
    SALES_CATEGORIES,
    PURCHASE_FIELDS,
    SHRINK_BUCKETS,
} = require('./edmonton-receiving-analytics.cjs');
const {
    buildAllDeptMargins,
    buildRebatesPayload,
    buildRecountsPayload,
    buildSalesDataPayload,
    buildMarginYtdPayload,
} = require('./edmonton-receiving-extended.cjs');
const {
    COSTING_METHOD,
    FREIGHT_DEPT_KEYS,
    allocateFreight,
    resolvePeriodCostingMethod,
} = require('./edmonton-receiving-costing.cjs');
const {
    resolveAppliedFreightRatePercent,
} = require('./receiving-period-freight-rates.cjs');
const {
    resolveAllocProfile,
    ALLOC_DEPT_KEYS,
} = require('./receiving-period-freight-alloc.cjs');
const {
    computeDayFreightReconciliation,
    computeEnteredFreight,
    dayLines,
} = require('./edmonton-receiving-integrity.cjs');

/** Deprecated 5.4.15 Pulse meta — non-authoritative if still written. */
const PERIOD_FREIGHT_RATE_LABEL = 'Period Freight Rate % (deprecated — non-authoritative)';
const PERIOD_FREIGHT_RATE_LABEL_ADDR = 'A118';
const PERIOD_FREIGHT_RATE_VALUE_ADDR = 'B118';

const RT_PURCHASE_COLS = ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
const RT_SHRINK_COLS = {
    bakery: 'O',
    dairy: 'P',
    freezer: 'Q',
    grocery: 'R',
    meat: 'S',
    produce: 'T',
};
const RT_WEEKLY_SHRINK_COLS = {
    bakery: 'U',
    dairy: 'V',
    freezer: 'W',
    grocery: 'X',
    meat: 'Y',
    produce: 'Z',
};
const SALES_WEEK_COLS = ['C', 'D', 'E', 'F', 'G'];
const FREIGHT_ROW = 56;
/** Template row 2 = allocation fractions (0.478 … totaling 1). Row 3 = dept% × $N$3 dollars. */
const FREIGHT_PCT_ROW = 2;
const FREIGHT_ALLOC_DOLLAR_ROW = 3;

function resolveWorksheet(wb, names) {
    const list = Array.isArray(names) ? names : [names];
    for (const name of list) {
        const sheet = wb.getWorksheet(name);
        if (sheet) return sheet;
    }
    return null;
}

function colLetter(index) {
    let n = index;
    let out = '';
    while (n >= 0) {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    }
    return out;
}

function duplicateWorksheet(wb, sourceSheet, newName) {
    const cloned = JSON.parse(JSON.stringify(sourceSheet.model));
    cloned.name = newName;
    delete cloned.id;
    const sheet = wb.addWorksheet(newName);
    sheet.model = cloned;
    return sheet;
}

function materializeSharedFormulaClones(sheet) {
    sheet.eachRow({ includeEmpty: false }, (row) => {
        row.eachCell({ includeEmpty: false }, (cell) => {
            const value = cell.value;
            if (value && typeof value === 'object' && value.sharedFormula) {
                cell.value = value.result ?? null;
            }
        });
    });
}

function sumFreightByDept(lines) {
    const totals = Object.fromEntries(FREIGHT_DEPT_KEYS.map((key) => [key, 0]));
    (lines || []).forEach((line) => {
        const kind = String(line.line_kind || 'invoice').toLowerCase();
        if (kind !== 'invoice') return;
        FREIGHT_DEPT_KEYS.forEach((key) => {
            totals[key] = roundMoney(totals[key] + Number(line[`freight_${key}`] || 0));
        });
    });
    return totals;
}

function writeFreightRowValues(sheet, freightByDept, { zeroAll = false } = {}) {
    const labelCell = sheet.getCell(`A${FREIGHT_ROW}`);
    if (!String(labelCell.value || '').trim()) {
        setCellText(sheet, `A${FREIGHT_ROW}`, 'Freight');
    }
    DEPT_COLS.forEach(([key, col]) => {
        let value = 0;
        if (!zeroAll) {
            if (key === 'produce_shrink' || key === 'gst') {
                value = 0;
            } else if (Object.prototype.hasOwnProperty.call(freightByDept, key)) {
                value = freightByDept[key] || 0;
            }
        }
        setCellNumber(sheet, `${col}${FREIGHT_ROW}`, value);
    });
    const entered = zeroAll
        ? 0
        : roundMoney(Object.values(freightByDept).reduce((sum, v) => sum + Number(v || 0), 0));
    setCellNumber(sheet, `N${FREIGHT_ROW}`, entered);
}

function breakLegacyFreightFormulas(sheet, freightByDept, costingMethod) {
    if (costingMethod !== COSTING_METHOD.INVOICE_FREIGHT) return;
    // Overwrite dollar allocation row (row 3) with invoice freight values — not the % profile row.
    FREIGHT_DEPT_KEYS.forEach((key) => {
        const col = DEPT_COLS.find(([k]) => k === key)?.[1];
        if (!col) return;
        setCellNumber(sheet, `${col}${FREIGHT_ALLOC_DOLLAR_ROW}`, freightByDept[key] || 0);
    });
    setCellNumber(sheet, `J${FREIGHT_ALLOC_DOLLAR_ROW}`, 0); // produce_shrink never receives invoice freight
    setCellText(sheet, 'O3', 'Pulse invoice freight (values, not fixed %)');
}

/**
 * Write period department allocation % into template row 2 as fractions (0.478)
 * matching the Edmonton workbook format, and write computed N3×% dollars on row 3 + freight row.
 */
function writePeriodDepartmentAllocationFreight(sheet, dailyFreightTotal, pctFractions, { zeroFreight = false } = {}) {
    const fractions = pctFractions || {};
    ALLOC_DEPT_KEYS.forEach((key) => {
        const col = DEPT_COLS.find(([k]) => k === key)?.[1];
        if (!col) return;
        const frac = Number(fractions[key] || 0);
        // Row 2 stores template fractions (0.478) — do not roundMoney or 47.8% becomes 48%.
        sheet.getCell(`${col}${FREIGHT_PCT_ROW}`).value = frac;
    });
    // N2 total check cell — keep as sum of fractions when template expects it.
    try {
        const totalFrac = ALLOC_DEPT_KEYS.reduce((s, k) => s + Number(fractions[k] || 0), 0);
        sheet.getCell(`N${FREIGHT_PCT_ROW}`).value = totalFrac;
    } catch (_) { /* optional */ }

    // Null/missing Daily Freight Allocation Total must not become $0 silently.
    const incomplete = !zeroFreight && (dailyFreightTotal == null || dailyFreightTotal === '');
    if (incomplete) {
        try { sheet.getCell('N3').value = null; } catch (_) { /* optional */ }
        setCellText(sheet, 'O3', 'Pulse Daily Freight Allocation Total missing (incomplete)');
        setCellText(sheet, 'O56', 'Daily Freight Allocation Total × Period Department Allocation %');
        return;
    }

    const n3 = zeroFreight ? 0 : Number(dailyFreightTotal);
    const n3Safe = Number.isFinite(n3) ? n3 : 0;
    setCellNumber(sheet, 'N3', n3Safe);

    const allocated = zeroFreight || n3Safe === 0
        ? Object.fromEntries(ALLOC_DEPT_KEYS.map((k) => [k, 0]))
        : allocateFreight(n3Safe, fractions);

    ALLOC_DEPT_KEYS.forEach((key) => {
        const col = DEPT_COLS.find(([k]) => k === key)?.[1];
        if (!col) return;
        setCellNumber(sheet, `${col}${FREIGHT_ALLOC_DOLLAR_ROW}`, allocated[key] || 0);
    });
    writeFreightRowValues(sheet, allocated, { zeroAll: zeroFreight });
    setCellText(sheet, 'O3', 'Pulse period department allocation (N3 × dept %)');
    setCellText(sheet, 'O56', 'Daily Freight Allocation Total × Period Department Allocation %');
}

function writeDailySheet(wb, db, storeDate) {
    const payload = buildReportPayload(db, storeDate);
    const sheet = wb.getWorksheet(payload.sheet_name);
    if (!sheet) {
        const err = new Error(`Worksheet "${payload.sheet_name}" not found in template.`);
        err.status = 500;
        err.code = 'DAILY_SHEET_MISSING';
        throw err;
    }

    const periodStart = resolvePeriodStart(db, storeDate);
    let costingMethod = resolvePeriodCostingMethod(db, periodStart).method || COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION;
    costingMethod = costingMethod === COSTING_METHOD.LEGACY_FIXED_ALLOCATION
        ? COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
        : costingMethod;
    const freightByDept = sumFreightByDept(payload.lines);
    const reportDate = parseUtcDate(payload.store_date);
    reportDate.setUTCHours(6, 0, 52, 0);

    setCellText(sheet, 'B3', payload.receiver_name || ' ');
    // Daily Freight Allocation Total only on the primary sheet — continuation sheets use 0.
    // Leave N3 blank when incomplete (null); confirmed $0.00 writes zero.
    if (payload.freight_total == null || payload.freight_total === '') {
        try { sheet.getCell('N3').value = null; } catch (_) { /* optional */ }
    } else {
        setCellNumber(sheet, 'N3', payload.freight_total);
    }
    sheet.getCell('B4').value = reportDate;

    clearDataRows(sheet);
    const pageSize = DATA_END_ROW - DATA_START_ROW + 1;
    const primaryLines = payload.lines.slice(0, pageSize);
    primaryLines.forEach((line, idx) => {
        writeLineToSheet(sheet, DATA_START_ROW + idx, line);
    });

    let allocFractions = null;
    if (costingMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION) {
        try {
            const profile = resolveAllocProfile(db, periodStart);
            // Prefer confirmed (snapshot/profile); draft may preview on open periods.
            if (profile && profile.pct_fractions) {
                allocFractions = profile.pct_fractions;
            }
        } catch (_) {
            allocFractions = null;
        }
        if (allocFractions) {
            writePeriodDepartmentAllocationFreight(
                sheet,
                payload.freight_total,
                allocFractions,
                { zeroFreight: false },
            );
        } else {
            // Profile missing — still stamp N3; leave template % row as-is.
            setCellText(sheet, 'O3', 'Pulse Daily Freight Allocation Total (profile missing)');
        }
    } else if (costingMethod === COSTING_METHOD.INVOICE_FREIGHT) {
        writeFreightRowValues(sheet, freightByDept, { zeroAll: false });
        breakLegacyFreightFormulas(sheet, freightByDept, costingMethod);
    } else if (costingMethod === COSTING_METHOD.BASE_COST_ONLY) {
        writeFreightRowValues(sheet, freightByDept, { zeroAll: true });
        setCellText(sheet, 'O56', 'Freight memo only (base_cost_only)');
    } else if (costingMethod === COSTING_METHOD.PERIOD_RATE) {
        // Superseded path — do not leave purchases×rate conflicting with N3×% formulas.
        writeFreightRowValues(sheet, freightByDept, { zeroAll: true });
        setCellText(sheet, 'O56', 'Superseded period_rate — freight row values cleared (use period_department_allocation)');
    }

    const continuationSheets = [];
    for (let offset = pageSize, page = 2; offset < payload.lines.length; offset += pageSize, page += 1) {
        const contName = `${payload.sheet_name} Cont ${page}`;
        if (contName.length > 31) {
            const err = new Error(`Continuation sheet name exceeds Excel limit: ${contName}`);
            err.status = 500;
            err.code = 'CONTINUATION_NAME_TOO_LONG';
            throw err;
        }
        const continuation = duplicateWorksheet(wb, sheet, contName);
        clearDataRows(continuation);
        setCellText(continuation, 'B3', payload.receiver_name || ' ');
        setCellNumber(continuation, 'N3', 0);
        continuation.getCell('B4').value = reportDate;
        setCellText(continuation, 'A1', `${payload.sheet_name} — continuation ${page}`);
        payload.lines.slice(offset, offset + pageSize).forEach((line, idx) => {
            writeLineToSheet(continuation, DATA_START_ROW + idx, line);
        });
        // Cont sheets carry lines only — N3=0, no duplicate freight.
        if (costingMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION && allocFractions) {
            writePeriodDepartmentAllocationFreight(continuation, 0, allocFractions, { zeroFreight: true });
        } else {
            writeFreightRowValues(continuation, freightByDept, { zeroAll: true });
            if (costingMethod === COSTING_METHOD.INVOICE_FREIGHT) {
                breakLegacyFreightFormulas(
                    continuation,
                    Object.fromEntries(FREIGHT_DEPT_KEYS.map((k) => [k, 0])),
                    costingMethod,
                );
            }
        }
        continuationSheets.push(contName);
    }

    if (payload.lines.length > pageSize && continuationSheets.length === 0) {
        const err = new Error(`Failed to create continuation sheets for ${payload.lines.length} lines.`);
        err.status = 500;
        err.code = 'CONTINUATION_WRITE_FAILED';
        throw err;
    }

    return {
        ...payload,
        costing_method: costingMethod,
        continuation_sheets: continuationSheets.length,
        continuation_sheet_names: continuationSheets,
        lines_written: payload.lines.length,
        freight_by_dept: freightByDept,
    };
}

function writeSalesNumbersSheet(wb, sales) {
    const sheet = wb.getWorksheet('Sales Numbers');
    if (!sheet) return;

    const periodNum = sales.period_number || sales.meta?.period_number;
    if (periodNum) {
        setCellText(sheet, 'A1', `Period ${periodNum}`);
    }

    SALES_WEEK_COLS.forEach((col, idx) => {
        const weekEnding = sales.week_ends?.[idx];
        if (weekEnding) {
            sheet.getCell(`${col}1`).value = parseUtcDate(weekEnding);
        }
    });

    SALES_CATEGORIES.forEach((cat, idx) => {
        const row = 2 + idx;
        setCellText(sheet, `B${row}`, cat.label);
        for (let w = 1; w <= 5; w += 1) {
            const col = SALES_WEEK_COLS[w - 1];
            const catRow = sales.categories.find((c) => c.key === cat.key);
            setCellNumber(sheet, `${col}${row}`, catRow?.weeks?.[w] || 0);
        }
    });
}

function writeReceivingTotalsSheet(wb, receiving) {
    const sheet = wb.getWorksheet('Receiving Totals');
    if (!sheet) return;

    SALES_WEEK_COLS.forEach((col, idx) => {
        const weekEnding = receiving.week_ends?.[idx];
        if (weekEnding) {
            sheet.getCell(`${col}1`).value = parseUtcDate(weekEnding);
        }
    });

    let rowNum = 2;
    (receiving.days || []).forEach((day) => {
        sheet.getCell(`A${rowNum}`).value = parseUtcDate(day.store_date);
        // Always write backend applyCosting values (not template fixed-% formulas).
        PURCHASE_FIELDS.forEach(([key], idx) => {
            setCellNumber(sheet, `${RT_PURCHASE_COLS[idx]}${rowNum}`, day.purchases?.[key] || 0);
        });
        SHRINK_BUCKETS.forEach((bucket) => {
            const col = RT_SHRINK_COLS[bucket];
            if (col) setCellNumber(sheet, `${col}${rowNum}`, day.shrink?.[bucket] || 0);
        });
        rowNum += 1;
    });

    (receiving.weekly_shrink || []).forEach((weekly) => {
        const r = 1 + weekly.week_num;
        SHRINK_BUCKETS.forEach((bucket) => {
            const col = RT_WEEKLY_SHRINK_COLS[bucket];
            if (col) setCellNumber(sheet, `${col}${r}`, weekly.shrink?.[bucket] || 0);
        });
    });

    PURCHASE_FIELDS.forEach(([key], idx) => {
        setCellNumber(sheet, `${RT_PURCHASE_COLS[idx]}38`, receiving.purchase_totals?.[key] || 0);
    });

    if (
        receiving.costing_method === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
        || receiving.costing_mode === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
        || receiving.costing_method === COSTING_METHOD.LEGACY_FIXED_ALLOCATION
    ) {
        setCellText(
            sheet,
            'A40',
            'Period department allocation — Daily Freight Allocation Total (N3) × department allocation %.',
        );
    } else if (receiving.costing_method === COSTING_METHOD.PERIOD_RATE
        || receiving.costing_mode === COSTING_METHOD.PERIOD_RATE) {
        setCellText(sheet, 'A40', 'Superseded period freight rate — comparison only (purchases × rate%).');
    } else if (receiving.costing_method === COSTING_METHOD.INVOICE_FREIGHT) {
        setCellText(sheet, 'A40', 'Pulse invoice freight — purchase cells are values from backend applyCosting (not fixed % formulas).');
    } else if (receiving.costing_method === COSTING_METHOD.BASE_COST_ONLY) {
        setCellText(sheet, 'A40', 'Base cost only — freight excluded from purchases/COGS.');
    }

    // Deprecated non-authoritative B118 — written only when a historical rate still exists.
    const ratePct = receiving.period_freight_rate_percent;
    if (ratePct != null && Number.isFinite(Number(ratePct))) {
        setCellText(sheet, PERIOD_FREIGHT_RATE_LABEL_ADDR, PERIOD_FREIGHT_RATE_LABEL);
        setCellNumber(sheet, PERIOD_FREIGHT_RATE_VALUE_ADDR, Number(ratePct));
    }
}

function writeTotalGrocerySheet(wb, margin) {
    const sheet = wb.getWorksheet('Total Grocery');
    if (!sheet) return;

    const meta = margin.meta || {};
    const periodNum = meta.period_number || margin.period_number;
    if (periodNum) setCellText(sheet, 'A1', `Period ${periodNum}`);

    (margin.weeks || []).forEach((week, idx) => {
        const row = 3 + idx;
        sheet.getCell(`A${row}`).value = parseUtcDate(week.week_ending);
        setCellNumber(sheet, `B${row}`, week.sales);
        setCellNumber(sheet, `C${row}`, week.shrink_dollars);
        setCellNumber(sheet, `D${row}`, week.shrink_pct);
    });

    if (margin.totals) {
        setCellNumber(sheet, 'B8', margin.totals.sales);
        setCellNumber(sheet, 'C8', margin.totals.shrink_dollars);
        setCellNumber(sheet, 'D8', margin.totals.shrink_pct);
    }

    if (meta.target_margin_pct != null) setCellNumber(sheet, 'B11', meta.target_margin_pct);
    if (meta.opening_inventory != null) setCellNumber(sheet, 'B16', meta.opening_inventory);
    if (meta.last_inventory != null) setCellNumber(sheet, 'B17', meta.last_inventory);
    if (meta.closing_inventory != null) setCellNumber(sheet, 'B19', meta.closing_inventory);
    if (meta.sms_margin_pct != null) setCellNumber(sheet, 'B24', meta.sms_margin_pct);
    if (meta.sales_before_count != null) setCellNumber(sheet, 'G4', meta.sales_before_count);
    if (meta.sales_after_count != null) setCellNumber(sheet, 'G5', meta.sales_after_count);
    if (meta.sales_during_count != null) setCellNumber(sheet, 'G7', meta.sales_during_count);
    if (meta.variance_explanation) setCellText(sheet, 'A34', meta.variance_explanation);
}

function writeDeptMarginSheet(wb, deptMargin) {
    const sheet = resolveWorksheet(wb, deptMargin.sheet_names);
    if (!sheet) return;

    const meta = deptMargin.meta || {};
    const periodNum = deptMargin.period_number;
    if (periodNum) {
        setCellText(sheet, 'A1', `Period ${periodNum} ${deptMargin.label || ''}`.trim());
    }

    (deptMargin.weeks || []).forEach((week, idx) => {
        const row = 3 + idx;
        sheet.getCell(`A${row}`).value = parseUtcDate(week.week_ending);
        setCellNumber(sheet, `B${row}`, week.sales);
        if (deptMargin.has_shrink) {
            setCellNumber(sheet, `C${row}`, week.shrink_dollars);
            setCellNumber(sheet, `D${row}`, week.shrink_pct);
        }
    });

    if (deptMargin.totals) {
        setCellNumber(sheet, 'B8', deptMargin.totals.sales);
        if (deptMargin.has_shrink) {
            setCellNumber(sheet, 'C8', deptMargin.totals.shrink_dollars);
            setCellNumber(sheet, 'D8', deptMargin.totals.shrink_pct);
        }
        setCellNumber(sheet, 'B17', deptMargin.totals.purchases);
    }

    if (meta.target_margin_pct != null) setCellNumber(sheet, 'B11', meta.target_margin_pct);
    if (meta.opening_inventory != null) setCellNumber(sheet, 'B16', meta.opening_inventory);
    if (meta.last_inventory != null) setCellNumber(sheet, 'B13', meta.last_inventory);
    if (meta.closing_inventory != null) setCellNumber(sheet, 'B19', meta.closing_inventory);
    if (meta.sms_margin_pct != null) setCellNumber(sheet, 'B24', meta.sms_margin_pct);
    if (meta.inventory_adjustment != null) setCellNumber(sheet, 'G13', meta.inventory_adjustment);
    if (meta.sales_before_count != null) setCellNumber(sheet, 'G4', meta.sales_before_count);
    if (meta.sales_after_count != null) setCellNumber(sheet, 'G5', meta.sales_after_count);
    if (meta.sales_during_count != null) setCellNumber(sheet, 'G7', meta.sales_during_count);
    if (meta.variance_explanation) setCellText(sheet, 'A34', meta.variance_explanation);
}

function writeRebatesSheet(wb, rebates) {
    const sheet = wb.getWorksheet('Rebates');
    if (!sheet) return;

    if (rebates.period_ending) {
        sheet.getCell('B4').value = parseUtcDate(rebates.period_ending);
    }

    const deptCols = ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'];
    const deptKeys = [
        'grocery', 'tobacco', 'meat', 'bakery', 'bakery_in_store',
        'deli', 'produce', 'produce_shrink', 'dairy', 'pharmacy', 'gst',
    ];

    (rebates.lines || []).forEach((line, idx) => {
        const row = 6 + idx;
        setCellText(sheet, `A${row}`, line.invoice_number || ' ');
        setCellText(sheet, `B${row}`, line.supplier_name || ' ');
        deptKeys.forEach((key, colIdx) => {
            setCellNumber(sheet, `${deptCols[colIdx]}${row}`, line[key] || 0);
        });
        setCellText(sheet, `O${row}`, line.notes || ' ');
    });
}

function writeRecountsSheet(wb, recounts) {
    const sheet = wb.getWorksheet('Recounts');
    if (!sheet) return;

    (recounts.rows || []).forEach((row, idx) => {
        const r = 4 + idx;
        setCellText(sheet, `C${r}`, row.location || '');
        setCellNumber(sheet, `D${r}`, row.count_first);
        setCellNumber(sheet, `E${r}`, row.count_second);
    });

    if (recounts.totals) {
        setCellNumber(sheet, 'D37', recounts.totals.count_first);
        setCellNumber(sheet, 'E37', recounts.totals.count_second);
    }
}

function writeSalesDataSheet(wb, salesData) {
    const sheet = wb.getWorksheet('Sales Data');
    if (!sheet || !salesData.week_columns?.length) return;
    // The template uses shared-formula clones across the historical grid. Pulse
    // replaces some master cells with authoritative dates/values, so materialize
    // clones first; otherwise ExcelJS rejects orphaned clones at serialization.
    materializeSharedFormulaClones(sheet);

    const startCol = 3;
    salesData.week_columns.forEach((weekEnding, idx) => {
        const col = colLetter(startCol + idx);
        sheet.getCell(`${col}1`).value = parseUtcDate(weekEnding);
    });

    (salesData.categories || []).forEach((cat, rowIdx) => {
        const row = 2 + rowIdx;
        setCellText(sheet, `B${row}`, cat.label);
        if (cat.code) setCellText(sheet, `C${row}`, cat.code);
        salesData.week_columns.forEach((weekEnding, colIdx) => {
            const col = colLetter(startCol + colIdx);
            setCellNumber(sheet, `${col}${row}`, cat.weeks?.[weekEnding] || 0);
        });
    });
}

function writeMarginYtdSheet(wb, marginYtd) {
    const sheet = wb.getWorksheet('Margin YTD');
    if (!sheet) return;

    (marginYtd.rows || []).forEach((row, idx) => {
        const r = 3 + idx;
        sheet.getCell(`A${r}`).value = parseUtcDate(row.period_start);
        setCellNumber(sheet, `B${r}`, row.total_grocery_sales);
        setCellNumber(sheet, `C${r}`, row.total_grocery_gp);
        setCellNumber(sheet, `D${r}`, row.total_grocery_margin_pct);
        if (row.period_number != null) setCellNumber(sheet, `E${r}`, row.period_number);
    });

    if (marginYtd.totals) {
        setCellNumber(sheet, 'B20', marginYtd.totals.total_grocery_sales);
        setCellNumber(sheet, 'C20', marginYtd.totals.total_grocery_gp);
        setCellNumber(sheet, 'D20', marginYtd.totals.avg_margin_pct);
    }
}

function writeTotalReportSheet(wb, totalReport) {
    const sheet = wb.getWorksheet('Total Report');
    if (!sheet) return;

    (totalReport.columns || []).forEach((col, idx) => {
        const letter = colLetter(idx + 1);
        sheet.getCell(`${letter}4`).value = parseUtcDate(col.store_date);
        col.invoices.forEach((inv, rowIdx) => {
            setCellText(sheet, `${letter}${6 + rowIdx}`, inv.invoice_number);
        });
    });
}

function writePulseFreightReconciliationSheet(wb, db, periodStart, receiving) {
    const existing = wb.getWorksheet('Pulse Freight Reconciliation');
    if (existing) wb.removeWorksheet(existing.id);
    const sheet = wb.addWorksheet('Pulse Freight Reconciliation');
    const headers = [
        'Date',
        'Costing method',
        'Expected freight',
        ...FREIGHT_DEPT_KEYS.map((key) => `Freight ${key}`),
        'Entered total',
        'Difference',
        'Tolerance',
        'Status',
        'Override manager',
        'Override reason',
    ];
    headers.forEach((h, idx) => {
        sheet.getCell(1, idx + 1).value = h;
        sheet.getCell(1, idx + 1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getCell(1, idx + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    });
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: { row: 1, column: headers.length } };
    sheet.columns = headers.map((header, idx) => ({
        header,
        key: `c${idx + 1}`,
        width: idx === 0 ? 14 : (idx === 1 ? 28 : (idx >= headers.length - 2 ? 28 : 16)),
    }));

    const method = receiving.costing_method
        || resolvePeriodCostingMethod(db, periodStart).method
        || '';
    (receiving.days || []).forEach((day, idx) => {
        const row = 2 + idx;
        const dayRow = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', day.store_date);
        const lines = dayLines(db, day.store_date);
        const inactive = lines.length === 0 && dayRow?.freight_total == null;
        const recon = inactive
            ? { expected: null, entered: 0, difference: null, tolerance: null, status: 'INACTIVE' }
            : computeDayFreightReconciliation(db, day.store_date, dayRow, lines);
        const freightByDept = sumFreightByDept(lines);
        const entered = day.entered_freight_total != null
            ? Number(day.entered_freight_total)
            : computeEnteredFreight(lines);

        sheet.getCell(row, 1).value = day.store_date;
        sheet.getCell(row, 2).value = method;
        sheet.getCell(row, 3).value = recon.expected == null ? null : Number(recon.expected);
        FREIGHT_DEPT_KEYS.forEach((key, deptIdx) => {
            sheet.getCell(row, 4 + deptIdx).value = freightByDept[key] || 0;
        });
        const afterDepts = 4 + FREIGHT_DEPT_KEYS.length;
        sheet.getCell(row, afterDepts).value = entered;
        sheet.getCell(row, afterDepts + 1).value = recon.difference == null ? null : Number(recon.difference);
        sheet.getCell(row, afterDepts + 2).value = recon.tolerance == null ? null : Number(recon.tolerance);
        sheet.getCell(row, afterDepts + 3).value = recon.status || '';
        sheet.getCell(row, afterDepts + 4).value = recon.override_by || dayRow?.freight_override_by || '';
        sheet.getCell(row, afterDepts + 5).value = recon.override_reason || dayRow?.freight_override_reason || '';
        // Keep names/status/reasons as text. Applying numFmt to the entire row
        // caused blank override cells to render as currency in Excel.
        for (let col = 3; col <= afterDepts + 2; col += 1) {
            sheet.getCell(row, col).numFmt = '$#,##0.00;[Red]-$#,##0.00';
        }
        sheet.getCell(row, 1).numFmt = 'yyyy-mm-dd';
        sheet.getCell(row, 2).numFmt = '@';
        for (let col = afterDepts + 3; col <= afterDepts + 5; col += 1) {
            sheet.getCell(row, col).numFmt = '@';
        }
    });
}

function formatPeriodFilename(periodStart) {
    const [y, m, d] = normalizeStoreDate(periodStart).split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `Edmonton Wholesale Market Receiving Report ${y}${months[Number(m) - 1]}${d}-period.xlsx`;
}

async function buildFullPeriodWorkbookBuffer(db, anchorDate) {
    const file = templatePath();
    if (!fs.existsSync(file)) {
        const err = new Error('Edmonton receiving report template is missing.');
        err.status = 500;
        throw err;
    }

    const periodStart = resolvePeriodStart(db, anchorDate);
    const dates = [];
    for (let i = 0; i < 35; i += 1) {
        dates.push(addDays(periodStart, i));
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);

    const dailySummaries = [];
    const failedDates = [];
    dates.forEach((date) => {
        try {
            dailySummaries.push(writeDailySheet(wb, db, date));
        } catch (error) {
            failedDates.push({ date, message: error.message || String(error) });
        }
    });
    if (dailySummaries.length !== 35) {
        const err = new Error(`Unable to write all daily receiving sheets (${dailySummaries.length}/35).`);
        err.status = 500;
        err.code = 'DAILY_SHEETS_INCOMPLETE';
        err.expected = 35;
        err.written = dailySummaries.length;
        err.failed_dates = failedDates;
        throw err;
    }

    const omitted = dailySummaries.filter((d) => Number(d.lines_written || 0) < Number(d.lines?.length || 0));
    if (omitted.length) {
        const err = new Error(`Export omitted lines on ${omitted.length} day(s).`);
        err.status = 500;
        err.code = 'LINES_OMITTED';
        err.days = omitted.map((d) => d.store_date);
        throw err;
    }

    const sales = buildSalesGrid(db, periodStart);
    const receiving = buildReceivingTotalsPayload(db, periodStart);
    if (receiving.period_freight_rate_percent == null) {
        try {
            receiving.period_freight_rate_percent = resolveAppliedFreightRatePercent(db, periodStart);
        } catch (_) {
            receiving.period_freight_rate_percent = null;
        }
    }
    const margin = buildMarginPayload(db, periodStart);
    const totalReport = buildTotalReportPayload(db, anchorDate);
    const deptMargins = buildAllDeptMargins(db, periodStart);
    const rebates = buildRebatesPayload(db, periodStart);
    const recounts = buildRecountsPayload(db, periodStart);
    const salesData = buildSalesDataPayload(db, anchorDate);
    const marginYtd = buildMarginYtdPayload(db, anchorDate);

    writeSalesNumbersSheet(wb, sales);
    writeReceivingTotalsSheet(wb, receiving);
    writeTotalGrocerySheet(wb, margin);
    writeTotalReportSheet(wb, totalReport);
    Object.values(deptMargins).forEach((dept) => writeDeptMarginSheet(wb, dept));
    writeRebatesSheet(wb, rebates);
    writeRecountsSheet(wb, recounts);
    writeSalesDataSheet(wb, salesData);
    writeMarginYtdSheet(wb, marginYtd);
    writePulseFreightReconciliationSheet(wb, db, periodStart, receiving);

    return {
        buffer: await wb.xlsx.writeBuffer(),
        filename: formatPeriodFilename(periodStart),
        period_start: periodStart,
        period_end: addDays(periodStart, 34),
        daily_sheets_written: dailySummaries.length,
        invoice_count: totalReport.invoice_count,
        continuation_sheets: dailySummaries.reduce((sum, d) => sum + Number(d.continuation_sheets || 0), 0),
        lines_written: dailySummaries.reduce((sum, d) => sum + Number(d.lines_written || 0), 0),
    };
}

module.exports = {
    buildFullPeriodWorkbookBuffer,
    formatPeriodFilename,
    writeDailySheet,
    writePulseFreightReconciliationSheet,
};
