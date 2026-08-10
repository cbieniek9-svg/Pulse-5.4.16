'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { upsertSetting } = require('./settings-store.cjs');
const { SALES_CATEGORIES } = require('./edmonton-receiving-analytics.cjs');
const {
    SETTING_PERIOD_START,
    saveLine,
    upsertDayMeta,
} = require('./edmonton-receiving-report.cjs');
const {
    saveSalesAmount,
    saveMarginMeta,
    savePeriodNumber,
} = require('./edmonton-receiving-analytics.cjs');
const {
    DEPT_SHEET_NAMES,
    REBATE_DEPT_KEYS,
    saveRebateLine,
    saveRecount,
    saveDeptMarginMeta,
} = require('./edmonton-receiving-extended.cjs');
const { readSpreadsheetFile, excelSerialToDate } = require('./spreadsheet-read.cjs');
const {
    upsertDraftProfile,
    confirmProfile,
    validateAllocProfile,
    emptyPctMap,
    ALLOC_DEPT_KEYS,
    pctMapTotal,
} = require('./receiving-period-freight-alloc.cjs');
const { snapshotPeriodDayDeptFreight } = require('./edmonton-receiving-costing.cjs');

/** Deprecated 5.4.15 Pulse meta cells — read as metadata only; never authoritative. */
const PERIOD_FREIGHT_RATE_LABEL_ADDR = 'A118';
const PERIOD_FREIGHT_RATE_VALUE_ADDR = 'B118';
const PERIOD_FREIGHT_RATE_LABEL = 'Period Freight Rate % (deprecated)';

/** Template freight allocation % row (fractions totaling 1.0). Export writes the same cells. */
const FREIGHT_ALLOC_PCT_ROW = 2;
/** Row 3 holds dept% × $N$3 dollar formulas — not the profile percentages. */
const FREIGHT_ALLOC_DOLLAR_ROW = 3;

/** A1 column letters → 0-based index (A=0, B=1, …, AA=26). */
function colLettersToIndex(letters) {
    let n = 0;
    const s = String(letters || '').toUpperCase();
    for (let i = 0; i < s.length; i += 1) {
        const code = s.charCodeAt(i);
        if (code < 65 || code > 90) return -1;
        n = (n * 26) + (code - 64);
    }
    return n - 1;
}

/**
 * SheetJS-compatible cell accessor: `sheet.B4?.v` / `sheet['A6']?.v`.
 * Built on adapter `{ name, rows }` so existing A1 readers stay intact.
 */
function wrapSheet(sheet) {
    if (!sheet) return null;
    return new Proxy(sheet, {
        get(target, prop, receiver) {
            if (typeof prop === 'string' && /^[A-Za-z]+\d+$/.test(prop)) {
                const rows = target.rows;
                const m = /^([A-Za-z]+)(\d+)$/.exec(prop);
                const col = colLettersToIndex(m[1]);
                const row = Number(m[2]) - 1;
                if (!Array.isArray(rows) || row < 0 || col < 0 || !rows[row]) {
                    return undefined;
                }
                if (col >= rows[row].length) return undefined;
                return { v: rows[row][col] ?? null };
            }
            return Reflect.get(target, prop, receiver);
        },
    });
}

function wrapWorkbook(parsed) {
    const Sheets = Object.create(null);
    const SheetNames = [];
    for (const sheet of parsed.sheets || []) {
        SheetNames.push(sheet.name);
        Sheets[sheet.name] = wrapSheet(sheet);
    }
    return {
        format: parsed.format,
        sheets: parsed.sheets || [],
        SheetNames,
        Sheets,
    };
}

const DEPT_COLS = [
    ['grocery', 'C'],
    ['tobacco', 'D'],
    ['meat', 'E'],
    ['bakery', 'F'],
    ['bakery_in_store', 'G'],
    ['deli', 'H'],
    ['produce', 'I'],
    ['produce_shrink', 'J'],
    ['dairy', 'K'],
    ['pharmacy', 'L'],
    ['gst', 'M'],
];

/** Allocation profile departments (excludes gst). */
const ALLOC_DEPT_COLS = DEPT_COLS.filter(([key]) => key !== 'gst');

const SHRINK_RT_COLS = [
    ['bakery', 'O'],
    ['dairy', 'P'],
    ['freezer', 'Q'],
    ['grocery', 'R'],
    ['meat', 'S'],
    ['produce', 'T'],
];

const SALES_LABEL_MAP = Object.fromEntries(
    SALES_CATEGORIES.map((c) => [String(c.label).toUpperCase(), c.key]),
);

function roundMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 100) / 100;
}

function cellDate(value) {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) return '';
        return value.toISOString().slice(0, 10);
    }
    // ExcelJS occasionally leaves date-formatted cells as serial numbers.
    if (typeof value === 'number' && Number.isFinite(value) && value > 20000 && value < 80000) {
        const d = excelSerialToDate(value);
        if (d instanceof Date && !Number.isNaN(d.getTime())) {
            return d.toISOString().slice(0, 10);
        }
    }
    const s = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return '';
}

function parsePeriodNumber(sheet, addr = 'A1') {
    const raw = String(sheet?.[addr]?.v || '');
    const m = raw.match(/Period\s+(\d+)/i);
    return m ? Number(m[1]) : null;
}

function isBlankRow(inv, sup, amounts) {
    const a = String(inv || '').trim();
    const b = String(sup || '').trim();
    if (a && a !== ' ') return false;
    if (b && b !== ' ') return false;
    return !amounts.some((v) => roundMoney(v) !== 0);
}

function inferPeriodStart(wb) {
    for (const name of wb.SheetNames) {
        if (!/WK\d/.test(name)) continue;
        const ws = wb.Sheets[name];
        const date = cellDate(ws?.B4?.v);
        if (!date) continue;
        const dt = new Date(`${date}T12:00:00Z`);
        dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
        return dt.toISOString().slice(0, 10);
    }
    const sales = wb.Sheets['Sales Numbers'];
    if (sales) {
        const firstWeekEnd = cellDate(sales.C1?.v);
        if (firstWeekEnd) {
            const dt = new Date(`${firstWeekEnd}T12:00:00Z`);
            dt.setUTCDate(dt.getUTCDate() - 6);
            return dt.toISOString().slice(0, 10);
        }
    }
    throw new Error('Could not infer period start from workbook.');
}

function resolvePeriodNumber(wb) {
    const tg = parsePeriodNumber(wb.Sheets['Total Grocery'], 'A1');
    const cs = parsePeriodNumber(wb.Sheets['Centre Store'], 'A1');
    const sn = parsePeriodNumber(wb.Sheets['Sales Numbers'], 'A1');
    return tg || cs || sn || null;
}

/**
 * Read a cell as a numeric percent/fraction, preserving explicit zeros.
 * Returns null when the cell is blank / non-numeric (not when zero).
 */
function readAllocCellNumber(ws, addr) {
    const cell = ws?.[addr];
    if (!cell) return null;
    let raw = cell.v;
    if (raw && typeof raw === 'object') {
        if (raw.result != null) raw = raw.result;
        else if (raw.richText) raw = raw.richText.map((t) => t.text || '').join('');
    }
    if (raw === '' || raw == null) return null;
    if (typeof raw === 'string' && !String(raw).trim()) return null;
    const n = Number(String(raw).replace(/%/g, '').trim());
    if (!Number.isFinite(n)) return null;
    return n;
}

/**
 * Read department allocation percentages from a daily worksheet.
 * Prefer FREIGHT_ALLOC_PCT_ROW (row 2 — template fractions). Fall back to row 3
 * only when row 2 is entirely empty (never invent from dollar formulas that look filled).
 * Returns percent-points map (47.8) with zeros preserved.
 */
function readAllocPctMapFromSheet(ws, pctRow = FREIGHT_ALLOC_PCT_ROW) {
    const raw = emptyPctMap();
    let sawAny = false;
    ALLOC_DEPT_COLS.forEach(([key, col]) => {
        const n = readAllocCellNumber(ws, `${col}${pctRow}`);
        if (n == null) {
            raw[key] = 0;
            return;
        }
        sawAny = true;
        raw[key] = n;
    });
    if (!sawAny) return null;

    // Template stores fractions (0.478 totaling ~1). Convert to percent points when needed.
    const total = pctMapTotal(raw);
    const asPoints = emptyPctMap();
    if (total > 0 && total <= 1.5) {
        ALLOC_DEPT_KEYS.forEach((key) => {
            asPoints[key] = Math.round(Number(raw[key] || 0) * 10000) / 100; // 4dp fraction → 2dp %
        });
    } else {
        ALLOC_DEPT_KEYS.forEach((key) => {
            asPoints[key] = Number(raw[key] || 0);
        });
    }
    return asPoints;
}

function readAllocProfilesFromDailySheets(days, wb) {
    const profiles = [];
    for (const day of days) {
        const ws = wb.Sheets[day.sheetName];
        if (!ws) continue;
        let pctMap = readAllocPctMapFromSheet(ws, FREIGHT_ALLOC_PCT_ROW);
        if (!pctMap) {
            // Spec allows checking row 3 if row 2 empty — only when row 2 truly blank.
            pctMap = readAllocPctMapFromSheet(ws, FREIGHT_ALLOC_DOLLAR_ROW);
            // Row 3 is normally dollar formulas; if values look like dollars (>100 total points
            // without being ~100%), skip — do not invent a profile from freight dollars.
            if (pctMap) {
                const t = pctMapTotal(pctMap);
                if (Math.abs(t - 100) > 2 && Math.abs(t - 1) > 0.02) {
                    pctMap = null;
                }
            }
        }
        if (pctMap) {
            profiles.push({ sheetName: day.sheetName, storeDate: day.storeDate, pctMap });
        }
    }
    return profiles;
}

function profilesConsistent(profiles, tolerance = 0.05) {
    if (!profiles.length) return { ok: true, reference: null, inconsistent: [] };
    const reference = profiles[0].pctMap;
    const inconsistent = [];
    for (let i = 1; i < profiles.length; i += 1) {
        const other = profiles[i].pctMap;
        const drift = ALLOC_DEPT_KEYS.some(
            (key) => Math.abs(Number(reference[key] || 0) - Number(other[key] || 0)) > tolerance,
        );
        if (drift) {
            inconsistent.push({
                sheetName: profiles[i].sheetName,
                storeDate: profiles[i].storeDate,
                pct_map: other,
            });
        }
    }
    return { ok: inconsistent.length === 0, reference, inconsistent };
}

function readDailySheets(wb) {
    const days = [];
    for (const sheetName of wb.SheetNames) {
        if (!/WK\d/.test(sheetName)) continue;
        // Continuation sheets must not contribute a second Daily Freight Allocation Total.
        if (/\bCont\b/i.test(sheetName)) continue;
        const ws = wb.Sheets[sheetName];
        const storeDate = cellDate(ws?.B4?.v);
        if (!storeDate) continue;

        const receiver = String(ws?.B3?.v || '').trim();
        // N3 = Daily Freight Allocation Total (authoritative day freight total).
        const freightRaw = ws?.N3?.v;
        const freight = freightRaw === '' || freightRaw == null ? null : roundMoney(freightRaw);
        const lines = [];

        for (let row = 6; row <= 55; row += 1) {
            const invoice = String(ws[`A${row}`]?.v ?? '').trim();
            const supplier = String(ws[`B${row}`]?.v ?? '').trim();
            const amounts = DEPT_COLS.map(([key, col]) => roundMoney(ws[`${col}${row}`]?.v));
            if (isBlankRow(invoice, supplier, amounts)) continue;

            const line = {
                invoice_number: invoice === ' ' ? '' : invoice,
                supplier_name: supplier === ' ' ? '' : supplier,
                notes: String(ws[`O${row}`]?.v ?? '').trim(),
            };
            DEPT_COLS.forEach(([key], idx) => { line[key] = amounts[idx]; });
            lines.push(line);
        }

        if (lines.length || receiver || freight != null) {
            days.push({ sheetName, storeDate, receiver, freight, lines });
        }
    }
    return days;
}

function readSalesNumbers(wb) {
    const ws = wb.Sheets['Sales Numbers'];
    if (!ws) return { entries: [], weekEnds: [] };

    const weekEnds = ['C', 'D', 'E', 'F', 'G'].map((col, idx) => ({
        weekNum: idx + 1,
        weekEnding: cellDate(ws[`${col}1`]?.v),
    }));

    const entries = [];
    for (let row = 2; row <= 31; row += 1) {
        const label = String(ws[`B${row}`]?.v || '').trim().toUpperCase();
        const categoryKey = SALES_LABEL_MAP[label];
        if (!categoryKey) continue;
        weekEnds.forEach(({ weekNum }) => {
            const col = String.fromCharCode(67 + weekNum - 1);
            const amount = roundMoney(ws[`${col}${row}`]?.v);
            entries.push({ categoryKey, weekNum, amount });
        });
    }
    return { entries, weekEnds };
}

function readReceivingTotalsShrink(wb, periodStart) {
    const ws = wb.Sheets['Receiving Totals'];
    if (!ws) return [];

    const start = new Date(`${periodStart}T12:00:00Z`);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 34);
    const endStr = end.toISOString().slice(0, 10);

    const rows = [];
    for (let row = 2; row <= 120; row += 1) {
        const storeDate = cellDate(ws[`A${row}`]?.v);
        if (!storeDate || storeDate < periodStart || storeDate > endStr) continue;

        SHRINK_RT_COLS.forEach(([bucket, col]) => {
            const amount = roundMoney(ws[`${col}${row}`]?.v);
            if (!amount) return;
            rows.push({
                store_date: storeDate,
                department: bucket,
                extended_cost: amount,
                description: `Imported ${bucket} shrink`,
                source_doc: 'workbook-import',
            });
        });
    }
    return rows;
}

function readMarginMeta(wb) {
    const ws = wb.Sheets['Total Grocery'];
    const meta = readDeptMarginFromSheet(ws) || {};
    const num = ws ? parsePeriodNumber(ws, 'A1') : null;
    if (num) meta.period_number = num;
    return meta;
}

function findWorksheet(wb, names) {
    for (const name of names) {
        if (wb.Sheets[name]) return wb.Sheets[name];
    }
    return null;
}

function readDeptMarginFromSheet(ws) {
    if (!ws) return null;
    const meta = {
        target_margin_pct: roundMoney(ws.B11?.v) || null,
        opening_inventory: roundMoney(ws.B16?.v) || null,
        last_inventory: roundMoney(ws.B13?.v) || null,
        closing_inventory: roundMoney(ws.B19?.v) || roundMoney(ws.B12?.v) || null,
        sms_margin_pct: roundMoney(ws.B24?.v) || null,
        inventory_adjustment: roundMoney(ws.G13?.v) || null,
        sales_before_count: roundMoney(ws.G4?.v) || null,
        sales_after_count: roundMoney(ws.G5?.v) || null,
        sales_during_count: roundMoney(ws.G7?.v) || null,
        variance_explanation: String(ws.A34?.v || ws.B34?.v || '').trim(),
    };
    const hasData = Object.entries(meta).some(([key, value]) => {
        if (key === 'variance_explanation') return !!value;
        return value != null && value !== 0;
    });
    return hasData ? meta : null;
}

function readDeptMargins(wb) {
    const entries = [];
    Object.entries(DEPT_SHEET_NAMES).forEach(([department, names]) => {
        const meta = readDeptMarginFromSheet(findWorksheet(wb, names));
        if (meta) entries.push({ department, meta });
    });
    return entries;
}

function cellMoney(ws, addr) {
    if (!ws) return null;
    const raw = ws[addr]?.v;
    if (raw === '' || raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? roundMoney(n) : null;
}

function hasPeriodsRollupHeader(ws, addr) {
    return /Periods\s+\d+\s*[-–]\s*\d+/i.test(String(ws?.[addr]?.v || ''));
}

function parsePeriodsRange(ws, addr) {
    const m = String(ws?.[addr]?.v || '').match(/Periods\s+(\d+)\s*[-–]\s*(\d+)/i);
    if (!m) return null;
    return { start: Number(m[1]), end: Number(m[2]) };
}

/**
 * Read Excel right-hand "Periods X–Y" physical-count block (open + counted close).
 * Total Grocery uses N14/N20; Centre Store / Dairy use G14/G20.
 * Only the workbook whose Period N equals Y (the count period) should persist the cycle.
 */
function readCountCycleBlock(wb) {
    const tg = wb.Sheets['Total Grocery'];
    if (!tg || !hasPeriodsRollupHeader(tg, 'M1')) return null;

    const range = parsePeriodsRange(tg, 'M1');
    const periodNumber = parsePeriodNumber(tg, 'A1');
    const counted_closing = {};
    const cycle_opening = {};

    cycle_opening.total_grocery = cellMoney(tg, 'N14');
    counted_closing.total_grocery = cellMoney(tg, 'N20') ?? cellMoney(tg, 'K11');

    const deptSheetMap = {
        centre_store: DEPT_SHEET_NAMES.centre_store,
        dairy: DEPT_SHEET_NAMES.dairy,
        meat: DEPT_SHEET_NAMES.meat,
        produce: DEPT_SHEET_NAMES.produce,
        tobacco: DEPT_SHEET_NAMES.tobacco,
    };

    Object.entries(deptSheetMap).forEach(([department, names]) => {
        const ws = findWorksheet(wb, names);
        if (ws && hasPeriodsRollupHeader(ws, 'F1')) {
            cycle_opening[department] = cellMoney(ws, 'G14');
            counted_closing[department] = cellMoney(ws, 'G20');
            return;
        }
        const left = readDeptMarginFromSheet(ws);
        if (left?.closing_inventory != null) {
            counted_closing[department] = left.closing_inventory;
        }
    });

    const hasValues = [...Object.values(cycle_opening), ...Object.values(counted_closing)]
        .some((v) => v != null);
    if (!hasValues) return null;

    const period_number_start = range?.start ?? (periodNumber != null ? periodNumber - 2 : null);
    const period_number_end = range?.end ?? periodNumber;
    const applies_to_this_workbook = periodNumber != null
        && period_number_end != null
        && Number(periodNumber) === Number(period_number_end);

    return {
        workbook_period_number: periodNumber,
        period_number_start,
        period_number_end,
        applies_to_this_workbook,
        counted_closing,
        cycle_opening,
    };
}

function readRebates(wb) {
    const ws = wb.Sheets.Rebates;
    if (!ws) return [];

    const lines = [];
    for (let row = 6; row <= 55; row += 1) {
        const invoice = String(ws[`A${row}`]?.v ?? '').trim();
        const supplier = String(ws[`B${row}`]?.v ?? '').trim();
        const amounts = REBATE_DEPT_KEYS.map((key, idx) => {
            const col = String.fromCharCode(67 + idx);
            return roundMoney(ws[`${col}${row}`]?.v);
        });
        if (!invoice && !supplier && !amounts.some((v) => v !== 0)) continue;

        const line = {
            invoice_number: invoice,
            supplier_name: supplier,
            notes: String(ws[`O${row}`]?.v ?? '').trim(),
        };
        REBATE_DEPT_KEYS.forEach((key, idx) => {
            line[key] = amounts[idx];
        });
        lines.push(line);
    }
    return lines;
}

function readRecounts(wb) {
    const ws = wb.Sheets.Recounts;
    if (!ws) return [];

    const rows = [];
    for (let row = 4; row <= 36; row += 1) {
        const location = String(ws[`C${row}`]?.v ?? '').trim();
        const countFirst = ws[`D${row}`]?.v;
        const countSecond = ws[`E${row}`]?.v;
        if (!location
            && (countFirst === '' || countFirst == null)
            && (countSecond === '' || countSecond == null)) {
            continue;
        }
        if (!location) continue;
        rows.push({
            location,
            count_first: countFirst === '' || countFirst == null ? null : roundMoney(countFirst),
            count_second: countSecond === '' || countSecond == null ? null : roundMoney(countSecond),
        });
    }
    return rows;
}

function synthesizeSalesFromPurchases(wb, periodStart) {
    const rt = wb.Sheets['Receiving Totals'];
    if (!rt) return [];

    const start = periodStart;
    const endDt = new Date(`${periodStart}T12:00:00Z`);
    endDt.setUTCDate(endDt.getUTCDate() + 34);
    const end = endDt.toISOString().slice(0, 10);

    const weekly = {};
    for (let row = 2; row <= 120; row += 1) {
        const storeDate = cellDate(rt[`A${row}`]?.v);
        if (!storeDate || storeDate < start || storeDate > end) continue;
        const dt = new Date(`${storeDate}T12:00:00Z`);
        const weekNum = Math.floor((dt - new Date(`${periodStart}T12:00:00Z`)) / 604800000) + 1;
        if (weekNum < 1 || weekNum > 5) continue;
        if (!weekly[weekNum]) {
            weekly[weekNum] = { grocery: 0, meat: 0, produce: 0, dairy: 0, tobacco: 0 };
        }
        weekly[weekNum].grocery += roundMoney(rt[`B${row}`]?.v);
        weekly[weekNum].tobacco += roundMoney(rt[`C${row}`]?.v);
        weekly[weekNum].meat += roundMoney(rt[`D${row}`]?.v);
        weekly[weekNum].produce += roundMoney(rt[`H${row}`]?.v);
        weekly[weekNum].dairy += roundMoney(rt[`J${row}`]?.v);
    }

    const synthesized = [];
    Object.entries(weekly).forEach(([weekNum, totals]) => {
        const w = Number(weekNum);
        if (!totals.grocery && !totals.meat && !totals.produce && !totals.dairy) return;
        const markup = 1.45;
        synthesized.push({ categoryKey: 'grocery', weekNum: w, amount: roundMoney(totals.grocery * markup * 0.55) });
        synthesized.push({ categoryKey: 'fs_paper', weekNum: w, amount: roundMoney(totals.grocery * markup * 0.08) });
        synthesized.push({ categoryKey: 'pop_chips', weekNum: w, amount: roundMoney(totals.grocery * markup * 0.22) });
        synthesized.push({ categoryKey: 'confectionery', weekNum: w, amount: roundMoney(totals.grocery * markup * 0.15) });
        synthesized.push({ categoryKey: 'meat', weekNum: w, amount: roundMoney(totals.meat * markup) });
        synthesized.push({ categoryKey: 'produce', weekNum: w, amount: roundMoney(totals.produce * markup * 0.85) });
        synthesized.push({ categoryKey: 'produce_selloff', weekNum: w, amount: roundMoney(totals.produce * markup * 0.15) });
        synthesized.push({ categoryKey: 'dairy', weekNum: w, amount: roundMoney(totals.dairy * markup * 0.7) });
        synthesized.push({ categoryKey: 'fs_milk', weekNum: w, amount: roundMoney(totals.dairy * markup * 0.3) });
        synthesized.push({ categoryKey: 'frozen', weekNum: w, amount: roundMoney(totals.grocery * markup * 0.08) });
        synthesized.push({ categoryKey: 'comm_bakery', weekNum: w, amount: roundMoney(totals.grocery * markup * 0.04) });
        synthesized.push({ categoryKey: 'bakery', weekNum: w, amount: roundMoney(totals.grocery * markup * 0.03) });
        synthesized.push({ categoryKey: 'cigarettes', weekNum: w, amount: roundMoney(totals.tobacco) });
    });

    return synthesized.filter((e) => e.amount !== 0);
}

function clearPeriod(db, periodStart) {
    const endDt = new Date(`${periodStart}T12:00:00Z`);
    endDt.setUTCDate(endDt.getUTCDate() + 34);
    const end = endDt.toISOString().slice(0, 10);

    db.run('DELETE FROM receiving_report_lines WHERE store_date >= ? AND store_date <= ?', periodStart, end);
    db.run('DELETE FROM receiving_report_day WHERE store_date >= ? AND store_date <= ?', periodStart, end);
    db.run('DELETE FROM receiving_shrink_lines WHERE store_date >= ? AND store_date <= ?', periodStart, end);
    db.run('DELETE FROM receiving_report_sales WHERE period_start=?', periodStart);
    db.run('DELETE FROM receiving_report_margin WHERE period_start=?', periodStart);
    db.run('DELETE FROM receiving_report_rebate_lines WHERE period_start=?', periodStart);
    db.run('DELETE FROM receiving_report_recounts WHERE period_start=?', periodStart);
    db.run('DELETE FROM receiving_report_dept_margin WHERE period_start=?', periodStart);
    db.run('DELETE FROM receiving_report_exception_acks WHERE period_start=?', periodStart);
    db.run('DELETE FROM receiving_report_sales_zero_confirm WHERE period_start=?', periodStart);
    db.run('DELETE FROM receiving_report_negative_freight_acks WHERE store_date >= ? AND store_date <= ?', periodStart, end);
    try {
        db.run('DELETE FROM receiving_report_count_cycles WHERE cycle_end_period_start=?', periodStart);
    } catch (_) { /* table may not exist yet */ }
}

function saveImportedShrinkLine(db, storeDate, payload, actor) {
    const shrinkId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO receiving_shrink_lines (
            shrink_id, store_date, line_id, source_doc, source_filename, invoice_number,
            supplier_name, sku, description, department, quantity, unit_cost, extended_cost,
            reason, sort_order, created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        shrinkId,
        storeDate,
        null,
        payload.source_doc || 'workbook-import',
        payload.source_filename || '',
        '',
        '',
        '',
        payload.description || 'Imported shrink',
        payload.department || 'grocery',
        1,
        payload.extended_cost,
        payload.extended_cost,
        'import',
        payload.sort_order || 0,
        now,
        now,
        actor,
        actor,
    );
    return shrinkId;
}

async function parseWorkbookFile(workbookPath) {
    if (!fs.existsSync(workbookPath)) {
        const err = new Error(`Workbook not found: ${workbookPath}`);
        err.status = 404;
        throw err;
    }
    const parsed = await readSpreadsheetFile(workbookPath);
    return wrapWorkbook(parsed);
}

/**
 * Normalize a workbook/API freight rate into percent points (e.g. 1.5207).
 * Accepts percent (0.2–20) or decimal fraction (< 0.2 → ×100). Rejects junk.
 */
function normalizeImportedFreightRatePercent(raw) {
    if (raw == null || raw === '') return null;
    let n = Number(raw);
    if (!Number.isFinite(n)) {
        const text = String(raw).trim().replace(/%/g, '');
        n = Number(text);
    }
    if (!Number.isFinite(n) || n <= 0) return null;
    // Decimal fraction form (0.015207) → percent points.
    if (n > 0 && n < 0.2) n *= 100;
    if (n < 0.2 || n > 20) return null;
    return Math.round(n * 10000) / 10000;
}

function cellText(cell) {
    if (!cell) return '';
    const v = cell.v != null ? cell.v : cell;
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'object') {
        if (v.richText) return v.richText.map((t) => t.text || '').join('');
        if (v.text != null) return String(v.text);
        if (v.result != null) return String(v.result);
    }
    return String(v);
}

function cellNumber(cell) {
    if (!cell) return null;
    const v = cell.v != null ? cell.v : cell;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (v && typeof v === 'object' && typeof v.result === 'number') return v.result;
    const n = Number(String(v ?? '').replace(/%/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function isPeriodFreightRateLabel(text) {
    const s = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
    if (!s) return false;
    if (/period\s*freight\s*rate/.test(s)) return true;
    if (/^freight\s*rate\s*%?$/.test(s)) return true;
    if (/applied\s*freight\s*rate/.test(s)) return true;
    return false;
}

/**
 * Read deprecated B118 period freight rate% for metadata only.
 * Does NOT invent a rate from N3 / invoice freight dollars.
 * Never used as authoritative landing rate under 5.4.16.
 */
function readPeriodFreightRateFromWorkbook(wb) {
    const rt = wb.Sheets?.['Receiving Totals'];
    if (rt) {
        const label = cellText(rt[PERIOD_FREIGHT_RATE_LABEL_ADDR]);
        const value = cellNumber(rt[PERIOD_FREIGHT_RATE_VALUE_ADDR]);
        if (isPeriodFreightRateLabel(label) || /period freight rate/i.test(label) || /deprecated/i.test(label)) {
            const rate = normalizeImportedFreightRatePercent(value);
            if (rate != null) {
                return {
                    rate_percent: rate,
                    source: 'workbook_receiving_totals_B118_deprecated',
                    deprecated: true,
                };
            }
        }
    }

    const sheetNames = wb.SheetNames || Object.keys(wb.Sheets || {});
    for (const name of sheetNames) {
        const sheet = wb.Sheets[name];
        if (!sheet) continue;
        // wrapSheet stores grid data on .rows (not enumerable A1 keys).
        const rows = sheet.rows || [];
        for (let r = 0; r < rows.length; r += 1) {
            const row = rows[r] || [];
            for (let c = 0; c < row.length; c += 1) {
                if (!isPeriodFreightRateLabel(row[c])) continue;
                const addr = `${colIndexToLetters(c)}${r + 1}`;
                const right = row[c + 1];
                const below = rows[r + 1]?.[c];
                for (const cand of [right, below]) {
                    const rate = normalizeImportedFreightRatePercent(
                        typeof cand === 'number' ? cand : Number(String(cand ?? '').replace(/%/g, '')),
                    );
                    if (rate != null) {
                        return {
                            rate_percent: rate,
                            source: `workbook_label:${name}!${addr}`,
                            deprecated: true,
                        };
                    }
                }
            }
        }
    }
    return null;
}

function colIndexToLetters(index) {
    let n = Number(index);
    if (!Number.isFinite(n) || n < 0) return 'A';
    let out = '';
    while (n >= 0) {
        out = String.fromCharCode(65 + (n % 26)) + out;
        n = Math.floor(n / 26) - 1;
    }
    return out;
}

function summarizeWorkbook(wb, opts = {}) {
    const periodStart = inferPeriodStart(wb);
    const periodNumber = resolvePeriodNumber(wb);
    const dailySheets = readDailySheets(wb);
    const sales = readSalesNumbers(wb);
    const shrinkRows = readReceivingTotalsShrink(wb, periodStart);
    const marginMeta = readMarginMeta(wb);
    const rebateLines = readRebates(wb);
    const recountRows = readRecounts(wb);
    const deptMargins = readDeptMargins(wb);
    const countCycle = readCountCycleBlock(wb);
    // Deprecated B118 rate — metadata only; never authoritative under 5.4.16.
    const workbookRate = readPeriodFreightRateFromWorkbook(wb);
    const allocProfiles = readAllocProfilesFromDailySheets(dailySheets, wb);
    const consistency = profilesConsistent(allocProfiles);
    const firstProfile = consistency.reference || allocProfiles[0]?.pctMap || null;
    const validation = firstProfile
        ? validateAllocProfile(firstProfile, { requireComplete: true })
        : { ok: false, errors: ['No allocation profile found on daily sheets'], total: 0, pctMap: emptyPctMap() };

    let salesEntries = sales.entries.filter((e) => e.amount !== 0);
    let synthesized = [];
    if (opts.fillSales === true && salesEntries.length === 0) {
        // Estimates only — never assign into _salesEntries / persist as manager-entered sales.
        synthesized = synthesizeSalesFromPurchases(wb, periodStart);
    }

    return {
        period_start: periodStart,
        period_number: periodNumber,
        daily_sheets: dailySheets.length,
        invoice_lines: dailySheets.reduce((n, d) => n + d.lines.length, 0),
        sales_cells: salesEntries.length,
        synthesized_sales: synthesized.length,
        shrink_lines: shrinkRows.length,
        margin_fields: Object.values(marginMeta).filter((v) => v != null && v !== '').length,
        rebate_lines: rebateLines.length,
        recount_rows: recountRows.length,
        dept_margin_sheets: deptMargins.length,
        count_cycle_fields: countCycle
            ? Object.values({ ...countCycle.counted_closing, ...countCycle.cycle_opening })
                .filter((v) => v != null).length
            : 0,
        has_count_cycle_block: !!countCycle,
        count_cycle_applies: !!(countCycle && countCycle.applies_to_this_workbook),
        // Authoritative path: department allocation profile + Daily Freight Allocation Total (N3).
        alloc_pct_map: firstProfile,
        alloc_profile_total_pct: firstProfile ? Math.round(pctMapTotal(firstProfile) * 100) / 100 : null,
        alloc_profile_valid: validation.ok,
        alloc_profile_errors: validation.errors,
        alloc_profile_inconsistent_days: consistency.inconsistent,
        alloc_profile_needs_manager_review: !consistency.ok,
        profile_needs_confirmation: true,
        // Deprecated 5.4.15 metadata — never used to land freight.
        deprecated_period_freight_rate_percent: workbookRate?.rate_percent ?? null,
        deprecated_freight_rate_source: workbookRate?.source || null,
        period_freight_rate_percent: null,
        freight_rate_source: null,
        _dailySheets: dailySheets,
        _salesEntries: salesEntries,
        _shrinkRows: shrinkRows,
        _marginMeta: marginMeta,
        _rebateLines: rebateLines,
        _recountRows: recountRows,
        _deptMargins: deptMargins,
        _countCycle: countCycle,
        _workbookFreightRate: workbookRate,
        _allocPctMap: firstProfile,
    };
}

async function importWorkbookToDb(db, workbookPath, opts = {}) {
    const wb = await parseWorkbookFile(workbookPath);
    const summary = summarizeWorkbook(wb, opts);
    if (opts.dryRun) {
        delete summary._dailySheets;
        delete summary._salesEntries;
        delete summary._shrinkRows;
        delete summary._marginMeta;
        delete summary._rebateLines;
        delete summary._recountRows;
        delete summary._deptMargins;
        delete summary._countCycle;
        delete summary._workbookFreightRate;
        delete summary._allocPctMap;
        return summary;
    }

    const actor = opts.actor || 'workbook-import';
    const periodStart = summary.period_start;

    const groceryInventoryCell = (addr) => {
        const n = cellNumber(wb.Sheets?.['Total Grocery']?.[addr]);
        return n == null ? null : roundMoney(n);
    };

    const persistImport = () => {
        if (opts.replacePeriod) clearPeriod(db, periodStart);

        upsertSetting(db, SETTING_PERIOD_START, periodStart);
        if (summary.period_number) savePeriodNumber(db, summary.period_number);

        // N3 → freight_total as Daily Freight Allocation Total (authoritative day total).
        // Not an invoice-estimate memo. Do not invent a period rate from N3.
        // Deprecated B118 (if present) is kept on the summary only — never upserted as landing rate.

        summary._dailySheets.forEach((day) => {
            upsertDayMeta(db, day.storeDate, {
                receiver_name: day.receiver,
                freight_total: day.freight,
                period_start: periodStart,
            }, actor);
            day.lines.forEach((line, idx) => {
                saveLine(db, day.storeDate, { ...line, sort_order: idx + 1 }, actor);
            });
        });

        summary._salesEntries.forEach((entry) => {
            saveSalesAmount(db, periodStart, entry.weekNum, entry.categoryKey, entry.amount, actor);
        });

        summary._shrinkRows.forEach((row, idx) => {
            saveImportedShrinkLine(db, row.store_date, { ...row, sort_order: idx + 1 }, actor);
        });

        saveMarginMeta(db, periodStart, {
            ...summary._marginMeta,
            // Missing/non-numeric Total Grocery cells stay null; intentional zeros preserved.
            opening_inventory: summary._marginMeta.opening_inventory ?? groceryInventoryCell('B17'),
            closing_inventory: summary._marginMeta.closing_inventory ?? groceryInventoryCell('B19'),
            ...(summary._countCycle?.applies_to_this_workbook ? { is_count_period: 1 } : {}),
        }, actor);

        summary._rebateLines.forEach((line, idx) => {
            saveRebateLine(db, periodStart, { ...line, sort_order: idx + 1 }, actor);
        });

        summary._recountRows.forEach((row, idx) => {
            saveRecount(db, periodStart, { ...row, sort_order: idx + 1 }, actor);
        });

        summary._deptMargins.forEach(({ department, meta }) => {
            saveDeptMarginMeta(db, periodStart, department, meta, actor);
        });

        // Upsert draft allocation profile from imported % — do NOT auto-confirm unless asked.
        const importedPct = summary._allocPctMap;
        summary.freight_rate_applied = false;
        summary.profile_applied = false;
        summary.profile_confirmed = false;
        if (importedPct) {
            try {
                upsertDraftProfile(db, periodStart, importedPct, actor);
                summary.profile_applied = true;
                summary.profile_needs_confirmation = true;
                const confirmOpt = opts.confirm_profile === true || opts.confirmProfile === true;
                if (confirmOpt && summary.alloc_profile_valid && !summary.alloc_profile_needs_manager_review) {
                    const reason = String(opts.confirm_reason || opts.confirmReason || 'Imported from workbook').trim()
                        || 'Imported from workbook';
                    confirmProfile(db, periodStart, actor, reason);
                    summary.profile_confirmed = true;
                    summary.profile_needs_confirmation = false;
                    try {
                        snapshotPeriodDayDeptFreight(db, periodStart);
                    } catch (_) { /* snapshot only after confirm */ }
                }
            } catch (e) {
                summary.profile_apply_error = e.message || String(e);
            }
        } else {
            summary.profile_needs_confirmation = true;
        }

        // Only the count-period workbook (Period Y of "Periods X–Y") owns the cycle record.
        // Prior-period workbooks often still carry the same right-hand block as a template remnant.
        if (summary._countCycle?.applies_to_this_workbook) {
            try {
                const { saveCountCycle } = require('./edmonton-receiving-count-cycle.cjs');
                const cycle = summary._countCycle;
                saveCountCycle(db, {
                    cycle_end_period_start: periodStart,
                    period_number_end: cycle.period_number_end,
                    counted_closing: cycle.counted_closing,
                    cycle_opening: cycle.cycle_opening,
                    notes: `Imported from Excel Periods ${cycle.period_number_start || '?'}–${cycle.period_number_end || '?'} block`,
                }, actor);
            } catch (_) { /* count-cycle optional if migration pending */ }
        }

        // Import-path only: strip stray count-cycle rows from prior-period template remnants.
        try {
            const { repairStrayCountCycleImports } = require('./edmonton-receiving-count-cycle.cjs');
            repairStrayCountCycleImports(db);
        } catch (_) { /* optional */ }
    };

    if (typeof db.transaction === 'function') {
        db.transaction(persistImport)();
    } else {
        persistImport();
    }

    delete summary._dailySheets;
    delete summary._salesEntries;
    delete summary._shrinkRows;
    delete summary._marginMeta;
    delete summary._rebateLines;
    delete summary._recountRows;
    delete summary._deptMargins;
    delete summary._countCycle;
    delete summary._workbookFreightRate;
    delete summary._allocPctMap;

    return summary;
}

module.exports = {
    importWorkbookToDb,
    summarizeWorkbook,
    parseWorkbookFile,
    readCountCycleBlock,
    readPeriodFreightRateFromWorkbook,
    normalizeImportedFreightRatePercent,
    readAllocPctMapFromSheet,
    FREIGHT_ALLOC_PCT_ROW,
    FREIGHT_ALLOC_DOLLAR_ROW,
    PERIOD_FREIGHT_RATE_LABEL,
    PERIOD_FREIGHT_RATE_LABEL_ADDR,
    PERIOD_FREIGHT_RATE_VALUE_ADDR,
};
