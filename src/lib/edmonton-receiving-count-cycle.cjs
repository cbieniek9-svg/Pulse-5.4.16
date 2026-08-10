'use strict';

const {
    addDays,
    normalizeStoreDate,
    resolvePeriodStart,
} = require('./edmonton-receiving-report.cjs');
const {
    buildSalesGrid,
    aggregateDailyPurchases,
    readMarginMeta,
    saveMarginMeta,
    roundMoney,
    roundPct,
} = require('./edmonton-receiving-analytics.cjs');

const COUNT_CYCLE_DEPTS = ['total_grocery', 'centre_store', 'dairy', 'meat', 'produce', 'tobacco'];

const COUNT_CYCLE_LABELS = {
    total_grocery: 'Total Grocery',
    centre_store: 'Centre Store',
    dairy: 'Dairy',
    meat: 'Meat',
    produce: 'Produce',
    tobacco: 'Tobacco',
};

function moneyOrNull(v) {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? roundMoney(n) : null;
}

function sumWeekMap(map) {
    if (!map || typeof map !== 'object') return 0;
    return roundMoney([1, 2, 3, 4, 5].reduce((sum, w) => sum + Number(map[w] || 0), 0));
}

function findPeriodStartByNumber(db, periodNumber) {
    const num = Number(periodNumber);
    if (!Number.isFinite(num) || num <= 0) return null;
    try {
        const row = db.get(
            `SELECT period_start FROM receiving_report_margin
              WHERE period_number=?
              ORDER BY period_start DESC
              LIMIT 1`,
            num,
        );
        return row?.period_start || null;
    } catch (_) {
        return null;
    }
}

/**
 * Clip each period's purchase window so overlapping period starts (when corporate
 * gaps are shorter than 35 days) do not double-count the same invoice days.
 */
function resolvePeriodPurchaseWindow(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    let end = addDays(start, 34);
    try {
        const next = db.get(
            `SELECT period_start FROM receiving_report_margin
              WHERE period_start > ?
              ORDER BY period_start ASC
              LIMIT 1`,
            start,
        );
        if (next?.period_start) {
            const clipped = addDays(next.period_start, -1);
            if (clipped < end) end = clipped;
        }
    } catch (_) { /* ignore */ }
    return { start, end };
}

function sumPurchasesInWindow(db, periodStart, windowStart, windowEnd) {
    const totals = {
        grocery: 0,
        dairy: 0,
        meat: 0,
        produce: 0,
        produce_shrink: 0,
        tobacco: 0,
    };
    // The count cycle must use the exact same period costing kernel as margin
    // reporting.  It also deliberately excludes write-offs and adjustment rows.
    const daily = aggregateDailyPurchases(db, periodStart, windowEnd);
    Object.values(daily).forEach((day) => {
        if (day.store_date < windowStart || day.store_date > windowEnd) return;
        Object.keys(totals).forEach((key) => {
            totals[key] = roundMoney(totals[key] + Number(day.purchases?.[key] || 0));
        });
    });

    try {
        const rebates = db.all(
            `SELECT grocery, tobacco, meat, produce, produce_shrink, dairy
               FROM receiving_report_rebate_lines
              WHERE period_start=?`,
            normalizeStoreDate(periodStart),
        ) || [];
        rebates.forEach((row) => {
            Object.keys(totals).forEach((key) => {
                totals[key] = roundMoney(totals[key] + Number(row[key] || 0));
            });
        });
    } catch (_) { /* rebates optional */ }

    return {
        total_grocery: roundMoney(totals.grocery + totals.dairy),
        centre_store: roundMoney(totals.grocery),
        dairy: roundMoney(totals.dairy),
        meat: roundMoney(totals.meat),
        produce: roundMoney(totals.produce + totals.produce_shrink),
        tobacco: roundMoney(totals.tobacco),
    };
}

/**
 * Remove count-cycle rows incorrectly created when prior-period workbooks still
 * carried a "Periods X–Y" template block (P7/P8 imports marking themselves as count).
 */
function repairStrayCountCycleImports(db) {
    const cycles = listCountCycles(db);
    cycles.forEach((cycle) => {
        const meta = readMarginMeta(db, cycle.cycle_end_period_start) || {};
        const pn = Number(meta.period_number);
        const end = Number(cycle.period_number_end);
        if (!Number.isFinite(pn) || !Number.isFinite(end) || pn === end) return;
        try {
            db.run(
                'DELETE FROM receiving_report_count_cycles WHERE cycle_end_period_start=?',
                cycle.cycle_end_period_start,
            );
        } catch (_) { /* ignore */ }
        try {
            db.run(
                'UPDATE receiving_report_margin SET is_count_period=0 WHERE period_start=?',
                cycle.cycle_end_period_start,
            );
        } catch (_) { /* ignore */ }
    });
}

/**
 * Anchor Count Cycle on the physical-count period (e.g. P9), not whatever Period
 * start is currently active in the header (e.g. P10).
 */
function resolveCountPeriodStart(db, anchorDate) {
    const active = resolvePeriodStart(db, anchorDate);
    const activeMeta = readMarginMeta(db, active) || {};
    if (Number(activeMeta.is_count_period) === 1) return active;
    if (readCountCycleRow(db, active)) return active;

    try {
        const flagged = db.get(
            `SELECT period_start FROM receiving_report_margin
              WHERE is_count_period=1 AND period_start<=?
              ORDER BY period_start DESC
              LIMIT 1`,
            active,
        );
        if (flagged?.period_start) return flagged.period_start;
    } catch (_) { /* ignore */ }

    const num = Number(activeMeta.period_number);
    if (Number.isFinite(num) && num >= 3) {
        const endNum = Math.floor(num / 3) * 3;
        if (endNum >= 3) {
            const start = findPeriodStartByNumber(db, endNum);
            if (start) return start;
        }
    }

    try {
        const cycle = db.get(
            `SELECT cycle_end_period_start FROM receiving_report_count_cycles
              WHERE cycle_end_period_start<=?
              ORDER BY period_number_end DESC, cycle_end_period_start DESC
              LIMIT 1`,
            active,
        );
        if (cycle?.cycle_end_period_start) return cycle.cycle_end_period_start;
    } catch (_) { /* ignore */ }

    return active;
}

function readCountCycleRow(db, cycleEndPeriodStart) {
    const start = normalizeStoreDate(cycleEndPeriodStart);
    try {
        return db.get(
            'SELECT * FROM receiving_report_count_cycles WHERE cycle_end_period_start=?',
            start,
        ) || null;
    } catch (_) {
        return null;
    }
}

function listCountCycles(db) {
    try {
        return db.all(
            `SELECT * FROM receiving_report_count_cycles
              ORDER BY period_number_end DESC, cycle_end_period_start DESC`,
        ) || [];
    } catch (_) {
        return [];
    }
}

function readDeptOpeningClosing(db, periodStart, dept) {
    try {
        const { readDeptMarginMeta } = require('./edmonton-receiving-extended.cjs');
        const meta = readDeptMarginMeta(db, periodStart, dept) || {};
        return {
            opening: moneyOrNull(meta.opening_inventory),
            closing: moneyOrNull(meta.closing_inventory),
        };
    } catch (_) {
        return { opening: null, closing: null };
    }
}

function periodSalesAndPurchases(db, periodStart) {
    if (!periodStart || !/^\d{4}-\d{2}-\d{2}$/.test(String(periodStart).trim())) {
        return {
            period_start: null,
            period_end: null,
            sales: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, 0])),
            purchases: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, 0])),
            opening: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, null])),
            closing: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, null])),
            period_number: null,
            missing: true,
        };
    }
    const start = normalizeStoreDate(periodStart);

    const salesGrid = buildSalesGrid(db, start);
    const window = resolvePeriodPurchaseWindow(db, start);
    const purchases = sumPurchasesInWindow(db, start, window.start, window.end);
    const margin = readMarginMeta(db, start) || {};
    const rollups = salesGrid.rollups || [];
    const rollupTotal = (key) => roundMoney(rollups.find((r) => r.key === key)?.total || 0);

    const sales = {
        total_grocery: roundMoney(salesGrid.summary?.grocery?.total || sumWeekMap(salesGrid.summary?.grocery)),
        centre_store: roundMoney(salesGrid.summary?.centre_store?.total || sumWeekMap(salesGrid.summary?.centre_store)),
        dairy: rollupTotal('dairy'),
        meat: roundMoney(salesGrid.summary?.meat?.total || sumWeekMap(salesGrid.summary?.meat) || rollupTotal('meat')),
        produce: roundMoney(salesGrid.summary?.produce_dept?.total || sumWeekMap(salesGrid.summary?.produce_dept) || rollupTotal('produce')),
        tobacco: roundMoney(salesGrid.summary?.tobacco?.total || sumWeekMap(salesGrid.summary?.tobacco) || rollupTotal('tobacco')),
    };

    const opening = {
        total_grocery: moneyOrNull(margin.opening_inventory),
        centre_store: readDeptOpeningClosing(db, start, 'centre_store').opening,
        dairy: readDeptOpeningClosing(db, start, 'dairy').opening,
        meat: readDeptOpeningClosing(db, start, 'meat').opening,
        produce: readDeptOpeningClosing(db, start, 'produce').opening,
        tobacco: readDeptOpeningClosing(db, start, 'tobacco').opening,
    };

    const closing = {
        total_grocery: moneyOrNull(margin.closing_inventory),
        centre_store: readDeptOpeningClosing(db, start, 'centre_store').closing,
        dairy: readDeptOpeningClosing(db, start, 'dairy').closing,
        meat: readDeptOpeningClosing(db, start, 'meat').closing,
        produce: readDeptOpeningClosing(db, start, 'produce').closing,
        tobacco: readDeptOpeningClosing(db, start, 'tobacco').closing,
    };

    return {
        period_start: start,
        period_end: window.end,
        purchase_window_end: window.end,
        period_number: margin.period_number ?? null,
        is_count_period: Number(margin.is_count_period) === 1,
        sales,
        purchases,
        opening,
        closing,
        missing: false,
    };
}

function deptMetrics(opening, purchases, closing, sales) {
    const open = Number(opening || 0);
    const purch = Number(purchases || 0);
    const close = Number(closing || 0);
    const salesAmt = Number(sales || 0);
    const goods = roundMoney(open + purch);
    const cogs = roundMoney(open + purch - close);
    const gp = roundMoney(salesAmt - cogs);
    const gpPct = salesAmt ? roundPct(gp / salesAmt) : 0;
    return {
        opening: moneyOrNull(opening),
        purchases: roundMoney(purch),
        goods_available: goods,
        closing: moneyOrNull(closing),
        cogs,
        sales: roundMoney(salesAmt),
        gross_profit: gp,
        gross_margin_pct: gpPct,
    };
}

function buildCountCyclePayload(db, anchorDate, opts = {}) {
    // Do not call repairStrayCountCycleImports here — reads must not delete manager-entered
    // count-cycle / margin flags. Repair runs on the workbook import path only.
    const skipPrior = opts.skipPrior === true;
    const countPeriodStart = resolveCountPeriodStart(db, anchorDate);
    const countMeta = readMarginMeta(db, countPeriodStart) || {};
    const endNum = Number(countMeta.period_number);
    const cycleRow = readCountCycleRow(db, countPeriodStart);

    let periodNumbers;
    if (Number.isFinite(endNum) && endNum >= 3) {
        periodNumbers = [endNum - 2, endNum - 1, endNum];
    } else if (cycleRow?.period_number_end) {
        const e = Number(cycleRow.period_number_end);
        periodNumbers = [e - 2, e - 1, e];
    } else {
        periodNumbers = [null, null, null];
    }

    const periods = periodNumbers.map((num) => {
        if (num == null) {
            return {
                period_number: null,
                period_start: null,
                period_end: null,
                missing: true,
                sales: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, 0])),
                purchases: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, 0])),
                opening: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, null])),
                closing: Object.fromEntries(COUNT_CYCLE_DEPTS.map((k) => [k, null])),
            };
        }
        const start = findPeriodStartByNumber(db, num) || (num === endNum ? countPeriodStart : null);
        const detail = periodSalesAndPurchases(db, start);
        return {
            ...detail,
            period_number: num,
            period_start: start,
            missing: !start,
        };
    });

    const first = periods[0];
    const last = periods[2];

    const openings = {};
    const closings = {};
    COUNT_CYCLE_DEPTS.forEach((dept) => {
        const openKey = `cycle_opening_${dept}`;
        const closeKey = `counted_closing_${dept}`;
        openings[dept] = cycleRow?.[openKey] != null
            ? moneyOrNull(cycleRow[openKey])
            : first?.opening?.[dept] ?? null;
        closings[dept] = cycleRow?.[closeKey] != null
            ? moneyOrNull(cycleRow[closeKey])
            : last?.closing?.[dept] ?? null;
    });

    const departments = {};
    COUNT_CYCLE_DEPTS.forEach((dept) => {
        const salesByPeriod = periods.map((p) => ({
            period_number: p.period_number,
            period_start: p.period_start,
            amount: roundMoney(p.sales?.[dept] || 0),
            missing: !!p.missing,
        }));
        const purchByPeriod = periods.map((p) => ({
            period_number: p.period_number,
            period_start: p.period_start,
            amount: roundMoney(p.purchases?.[dept] || 0),
            missing: !!p.missing,
        }));
        const salesTotal = roundMoney(salesByPeriod.reduce((s, r) => s + r.amount, 0));
        const purchTotal = roundMoney(purchByPeriod.reduce((s, r) => s + r.amount, 0));
        departments[dept] = {
            key: dept,
            label: COUNT_CYCLE_LABELS[dept] || dept,
            sales_by_period: salesByPeriod,
            purchases_by_period: purchByPeriod,
            sales_total: salesTotal,
            purchases_total: purchTotal,
            ...deptMetrics(openings[dept], purchTotal, closings[dept], salesTotal),
        };
    });

    let priorCycle = null;
    const priorEndNum = Number.isFinite(periodNumbers[2]) ? periodNumbers[2] - 3 : null;
    if (!skipPrior && priorEndNum) {
        try {
            const priorRow = db.get(
                'SELECT * FROM receiving_report_count_cycles WHERE period_number_end=?',
                priorEndNum,
            );
            if (priorRow?.cycle_end_period_start) {
                const priorPayload = buildCountCyclePayload(db, priorRow.cycle_end_period_start, { skipPrior: true });
                priorCycle = {
                    cycle_end_period_start: priorRow.cycle_end_period_start,
                    period_number_end: priorRow.period_number_end,
                    period_number_start: priorRow.period_number_start,
                    gross_margin_pct: priorPayload?.departments?.total_grocery?.gross_margin_pct ?? null,
                    gross_profit: priorPayload?.departments?.total_grocery?.gross_profit ?? null,
                };
            }
        } catch (_) {
            priorCycle = null;
        }
    }

    const missingPeriods = periods.filter((p) => p.missing).map((p) => p.period_number).filter(Boolean);
    const tg = departments.total_grocery;
    const priorGp = priorCycle?.gross_margin_pct;
    const gpDelta = priorGp != null && tg ? roundPct(tg.gross_margin_pct - priorGp) : null;

    return {
        count_period_start: countPeriodStart,
        active_period_start: resolvePeriodStart(db, anchorDate),
        is_count_period: Number(countMeta.is_count_period) === 1 || !!cycleRow,
        period_numbers: periodNumbers,
        period_number_start: periodNumbers[0],
        period_number_end: periodNumbers[2],
        periods,
        missing_periods: missingPeriods,
        cycle_complete: missingPeriods.length === 0 && periodNumbers.every((n) => n != null),
        departments,
        notes: cycleRow?.notes || '',
        prior_cycle: priorCycle,
        vs_prior_cycle_gp_pct: gpDelta,
        updated_at: cycleRow?.updated_at || null,
        updated_by: cycleRow?.updated_by || '',
    };
}

function saveCountCycle(db, payload = {}, actorName = '') {
    const countPeriodStart = normalizeStoreDate(
        payload.cycle_end_period_start || payload.count_period_start || payload.period_start,
    );
    if (!countPeriodStart) {
        const err = new Error('cycle_end_period_start is required.');
        err.status = 400;
        throw err;
    }

    const existingMargin = readMarginMeta(db, countPeriodStart) || {};
    const endNum = Number(payload.period_number_end ?? existingMargin.period_number);
    if (!Number.isFinite(endNum) || endNum < 3) {
        const err = new Error('Count cycle requires a period_number of 3 or higher on the count period.');
        err.status = 400;
        throw err;
    }
    const startNum = endNum - 2;
    const periodStarts = [startNum, startNum + 1, endNum].map(
        (n) => findPeriodStartByNumber(db, n) || (n === endNum ? countPeriodStart : null),
    );

    const now = new Date().toISOString();
    const existing = readCountCycleRow(db, countPeriodStart);

    const next = {
        cycle_end_period_start: countPeriodStart,
        period_number_start: startNum,
        period_number_end: endNum,
        period_starts_json: JSON.stringify(periodStarts),
        notes: String(payload.notes ?? existing?.notes ?? '').trim(),
        updated_at: now,
        updated_by: actorName || '',
    };

    COUNT_CYCLE_DEPTS.forEach((dept) => {
        const closeKey = `counted_closing_${dept}`;
        const openKey = `cycle_opening_${dept}`;
        if (payload[closeKey] !== undefined) next[closeKey] = moneyOrNull(payload[closeKey]);
        else if (payload.counted_closing?.[dept] !== undefined) next[closeKey] = moneyOrNull(payload.counted_closing[dept]);
        else next[closeKey] = existing?.[closeKey] ?? null;

        if (payload[openKey] !== undefined) next[openKey] = moneyOrNull(payload[openKey]);
        else if (payload.cycle_opening?.[dept] !== undefined) next[openKey] = moneyOrNull(payload.cycle_opening[dept]);
        else next[openKey] = existing?.[openKey] ?? null;
    });

    if (existing) {
        db.run(
            `UPDATE receiving_report_count_cycles SET
                period_number_start=?, period_number_end=?, period_starts_json=?,
                counted_closing_total_grocery=?, counted_closing_centre_store=?, counted_closing_dairy=?,
                counted_closing_meat=?, counted_closing_produce=?, counted_closing_tobacco=?,
                cycle_opening_total_grocery=?, cycle_opening_centre_store=?, cycle_opening_dairy=?,
                cycle_opening_meat=?, cycle_opening_produce=?, cycle_opening_tobacco=?,
                notes=?, updated_at=?, updated_by=?
              WHERE cycle_end_period_start=?`,
            next.period_number_start,
            next.period_number_end,
            next.period_starts_json,
            next.counted_closing_total_grocery,
            next.counted_closing_centre_store,
            next.counted_closing_dairy,
            next.counted_closing_meat,
            next.counted_closing_produce,
            next.counted_closing_tobacco,
            next.cycle_opening_total_grocery,
            next.cycle_opening_centre_store,
            next.cycle_opening_dairy,
            next.cycle_opening_meat,
            next.cycle_opening_produce,
            next.cycle_opening_tobacco,
            next.notes,
            next.updated_at,
            next.updated_by,
            countPeriodStart,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_count_cycles (
                cycle_end_period_start, period_number_start, period_number_end, period_starts_json,
                counted_closing_total_grocery, counted_closing_centre_store, counted_closing_dairy,
                counted_closing_meat, counted_closing_produce, counted_closing_tobacco,
                cycle_opening_total_grocery, cycle_opening_centre_store, cycle_opening_dairy,
                cycle_opening_meat, cycle_opening_produce, cycle_opening_tobacco,
                notes, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            next.cycle_end_period_start,
            next.period_number_start,
            next.period_number_end,
            next.period_starts_json,
            next.counted_closing_total_grocery,
            next.counted_closing_centre_store,
            next.counted_closing_dairy,
            next.counted_closing_meat,
            next.counted_closing_produce,
            next.counted_closing_tobacco,
            next.cycle_opening_total_grocery,
            next.cycle_opening_centre_store,
            next.cycle_opening_dairy,
            next.cycle_opening_meat,
            next.cycle_opening_produce,
            next.cycle_opening_tobacco,
            next.notes,
            next.updated_at,
            next.updated_by,
        );
    }

    saveMarginMeta(db, countPeriodStart, {
        is_count_period: 1,
        ...(next.counted_closing_total_grocery != null
            ? { closing_inventory: next.counted_closing_total_grocery }
            : {}),
    }, actorName);

    try {
        const { saveDeptMarginMeta, DEPT_KEYS } = require('./edmonton-receiving-extended.cjs');
        DEPT_KEYS.forEach((dept) => {
            const closeVal = next[`counted_closing_${dept}`];
            if (closeVal == null) return;
            saveDeptMarginMeta(db, countPeriodStart, dept, {
                closing_inventory: closeVal,
            }, actorName);
        });
    } catch (_) { /* optional */ }

    return buildCountCyclePayload(db, countPeriodStart);
}

function setCountPeriodFlag(db, periodStart, isCountPeriod, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    saveMarginMeta(db, start, { is_count_period: isCountPeriod ? 1 : 0 }, actorName);
    if (isCountPeriod) {
        const meta = readMarginMeta(db, start) || {};
        if (Number(meta.period_number) >= 3) {
            saveCountCycle(db, {
                cycle_end_period_start: start,
                counted_closing_total_grocery: meta.closing_inventory,
            }, actorName);
        }
    }
    return buildCountCyclePayload(db, start);
}

module.exports = {
    COUNT_CYCLE_DEPTS,
    COUNT_CYCLE_LABELS,
    findPeriodStartByNumber,
    resolveCountPeriodStart,
    resolvePeriodPurchaseWindow,
    repairStrayCountCycleImports,
    readCountCycleRow,
    listCountCycles,
    buildCountCyclePayload,
    saveCountCycle,
    setCountPeriodFlag,
};
