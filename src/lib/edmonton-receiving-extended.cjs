'use strict';

const crypto = require('crypto');
const {
    normalizeStoreDate,
    addDays,
    resolvePeriodStart,
} = require('./edmonton-receiving-report.cjs');
const {
    resolvePeriodContext,
    buildSalesGrid,
    buildReceivingTotalsPayload,
    buildMarginPayload,
    SALES_CATEGORIES,
    roundMoney,
    roundPct,
} = require('./edmonton-receiving-analytics.cjs');
const { parseMoneyOrThrow, parseOptionalMoneyOrThrow } = require('./parse-money.cjs');

function emptyWeekMap() {
    return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

const DEPT_KEYS = ['tobacco', 'meat', 'produce', 'dairy', 'centre_store'];

const DEPT_LABELS = {
    tobacco: 'Tobacco',
    meat: 'Meat',
    produce: 'Produce',
    dairy: 'Dairy',
    centre_store: 'Centre Store',
};

const DEPT_SHEET_NAMES = {
    tobacco: ['Tobacco New', 'Tobacco'],
    meat: ['Meat New', 'Meat'],
    produce: ['Produce New', 'Produce'],
    dairy: ['Dairy'],
    centre_store: ['Centre Store'],
};

const REBATE_DEPT_KEYS = [
    'grocery', 'tobacco', 'meat', 'bakery', 'bakery_in_store',
    'deli', 'produce', 'produce_shrink', 'dairy', 'pharmacy', 'gst',
];

function sumWeekMap(map) {
    return roundMoney(Object.values(map).reduce((sum, v) => sum + Number(v || 0), 0));
}

function weekShrinkAmount(weeklyShrink, weekNum, buckets) {
    const week = weeklyShrink.find((w) => w.week_num === weekNum);
    if (!week || !buckets.length) return 0;
    return roundMoney(buckets.reduce((sum, key) => sum + Number(week.shrink?.[key] || 0), 0));
}

function categoryWeekAmount(sales, keys, weekNum) {
    return roundMoney(keys.reduce((sum, key) => {
        const cat = sales.categories.find((c) => c.key === key);
        return sum + Number(cat?.weeks?.[weekNum] || 0);
    }, 0));
}

function readDeptMarginMeta(db, periodStart, department) {
    try {
        return db.get(
            'SELECT * FROM receiving_report_dept_margin WHERE period_start=? AND department=?',
            normalizeStoreDate(periodStart),
            department,
        ) || null;
    } catch (_) {
        return null;
    }
}

function saveDeptMarginMeta(db, periodStart, department, payload = {}, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const dept = String(department || '').trim();
    if (!DEPT_KEYS.includes(dept)) {
        const err = new Error(`Unknown department "${dept}".`);
        err.status = 400;
        throw err;
    }

    const now = new Date().toISOString();
    const existing = readDeptMarginMeta(db, start, dept);
    const pick = (key, pct = false) => {
        const raw = payload[key] ?? payload[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())];
        if (raw === undefined) return existing?.[key] ?? null;
        if (raw === '' || raw == null) return null;
        if (pct) {
            const v = Number(raw);
            if (!Number.isFinite(v)) {
                const err = new Error(`Not a number: ${key}`);
                err.status = 400;
                throw err;
            }
            return roundPct(v);
        }
        return parseOptionalMoneyOrThrow(raw, key);
    };

    const next = {
        period_start: start,
        department: dept,
        opening_inventory: pick('opening_inventory'),
        closing_inventory: pick('closing_inventory'),
        last_inventory: pick('last_inventory'),
        target_margin_pct: pick('target_margin_pct', true),
        sms_margin_pct: pick('sms_margin_pct', true),
        sales_before_count: pick('sales_before_count'),
        sales_after_count: pick('sales_after_count'),
        sales_during_count: pick('sales_during_count'),
        inventory_adjustment: pick('inventory_adjustment'),
        variance_explanation: String(
            payload.variance_explanation ?? payload.varianceExplanation ?? existing?.variance_explanation ?? '',
        ).trim(),
        updated_at: now,
        updated_by: actorName || '',
    };

    if (existing) {
        db.run(
            `UPDATE receiving_report_dept_margin SET
                opening_inventory=?, closing_inventory=?, last_inventory=?,
                target_margin_pct=?, sms_margin_pct=?,
                sales_before_count=?, sales_after_count=?, sales_during_count=?,
                inventory_adjustment=?, variance_explanation=?, updated_at=?, updated_by=?
              WHERE period_start=? AND department=?`,
            next.opening_inventory,
            next.closing_inventory,
            next.last_inventory,
            next.target_margin_pct,
            next.sms_margin_pct,
            next.sales_before_count,
            next.sales_after_count,
            next.sales_during_count,
            next.inventory_adjustment,
            next.variance_explanation,
            next.updated_at,
            next.updated_by,
            start,
            dept,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_dept_margin (
                period_start, department, opening_inventory, closing_inventory, last_inventory,
                target_margin_pct, sms_margin_pct, sales_before_count, sales_after_count,
                sales_during_count, inventory_adjustment, variance_explanation, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            start,
            dept,
            next.opening_inventory,
            next.closing_inventory,
            next.last_inventory,
            next.target_margin_pct,
            next.sms_margin_pct,
            next.sales_before_count,
            next.sales_after_count,
            next.sales_during_count,
            next.inventory_adjustment,
            next.variance_explanation,
            next.updated_at,
            next.updated_by,
        );
    }

    return buildDeptMarginPayload(db, start, dept);
}

function deptWeeklySales(sales, department) {
    const summary = sales.summary || {};
    if (department === 'tobacco') return summary.tobacco || emptyWeekMap();
    if (department === 'meat') return summary.meat || emptyWeekMap();
    if (department === 'produce') return summary.produce_dept || emptyWeekMap();
    if (department === 'dairy') {
        const weeks = emptyWeekMap();
        for (let w = 1; w <= 5; w += 1) {
            weeks[w] = categoryWeekAmount(sales, ['dairy', 'fs_milk'], w);
        }
        return weeks;
    }
    if (department === 'centre_store') return summary.centre_store || emptyWeekMap();
    return emptyWeekMap();
}

function deptShrinkBuckets(department) {
    if (department === 'tobacco') return [];
    if (department === 'meat') return ['meat'];
    if (department === 'produce') return ['produce'];
    if (department === 'dairy') return ['dairy'];
    if (department === 'centre_store') return ['bakery', 'freezer', 'grocery'];
    return [];
}

function deptPurchases(receiving, department) {
    const pt = receiving.purchase_totals || {};
    if (department === 'tobacco') return roundMoney(pt.tobacco);
    if (department === 'meat') return roundMoney(pt.meat);
    if (department === 'produce') return roundMoney(pt.produce) + roundMoney(pt.produce_shrink);
    if (department === 'dairy') return roundMoney(pt.dairy);
    if (department === 'centre_store') {
        return roundMoney(pt.grocery);
    }
    return 0;
}

function buildDeptMarginPayload(db, periodStart, department) {
    const start = normalizeStoreDate(periodStart);
    const dept = String(department || '').trim();
    if (!DEPT_KEYS.includes(dept)) {
        const err = new Error(`Unknown department "${dept}".`);
        err.status = 400;
        throw err;
    }

    const ctx = resolvePeriodContext(db, start);
    const sales = buildSalesGrid(db, start);
    const receiving = buildReceivingTotalsPayload(db, start);
    const meta = readDeptMarginMeta(db, start, dept) || {};
    const weeklySalesMap = deptWeeklySales(sales, dept);
    const shrinkBuckets = deptShrinkBuckets(dept);
    const purchases = deptPurchases(receiving, dept);

    const weeks = ctx.week_ends.map((weekEnding, idx) => {
        const weekNum = idx + 1;
        const salesAmount = roundMoney(weeklySalesMap[weekNum] || 0);
        const shrinkAmount = weekShrinkAmount(receiving.weekly_shrink, weekNum, shrinkBuckets);
        const shrinkPct = salesAmount ? roundPct(shrinkAmount / salesAmount) : 0;
        return {
            week_num: weekNum,
            week_ending: weekEnding,
            sales: salesAmount,
            shrink_dollars: shrinkAmount,
            shrink_pct: shrinkPct,
        };
    });

    const totalSales = roundMoney(weeks.reduce((sum, w) => sum + w.sales, 0));
    const totalShrink = roundMoney(weeks.reduce((sum, w) => sum + w.shrink_dollars, 0));
    const totalShrinkPct = totalSales ? roundPct(totalShrink / totalSales) : 0;

    const opening = roundMoney(meta.opening_inventory || 0);
    const closing = roundMoney(meta.closing_inventory || 0);
    const adjustment = roundMoney(meta.inventory_adjustment || 0);
    const goodsAvailable = roundMoney(opening + purchases);
    const cogs = roundMoney(opening + purchases - closing + adjustment);
    const grossProfit = roundMoney(totalSales - cogs);
    const grossMarginPct = totalSales ? roundPct(grossProfit / totalSales) : 0;

    const smsMarginPct = roundPct(meta.sms_margin_pct || 0);
    const smsGp = roundMoney(totalSales * smsMarginPct);
    const gpDiff = roundMoney(grossProfit - smsGp);
    const gpDiffPct = roundPct(grossMarginPct - smsMarginPct);

    const shrinkAdjustedGp = roundMoney(grossProfit + totalShrink);
    const shrinkAdjustedMarginPct = totalSales ? roundPct(shrinkAdjustedGp / totalSales) : 0;

    const salesDuringCount = roundMoney(meta.sales_during_count || 0);
    const salesDuringHalf = roundMoney(salesDuringCount / 2);
    const salesBeforeCount = roundMoney(meta.sales_before_count || 0);
    const salesAfterCount = roundMoney(meta.sales_after_count || 0);

    return {
        department: dept,
        label: DEPT_LABELS[dept],
        sheet_names: DEPT_SHEET_NAMES[dept],
        ...ctx,
        missing_rate: !!receiving.missing_rate,
        freight_rate_status: receiving.freight_rate_status || null,
        period_freight_rate_percent: receiving.period_freight_rate_percent ?? null,
        costing_method: receiving.costing_method || '',
        available: receiving.available !== false,
        meta: {
            opening_inventory: meta.opening_inventory,
            closing_inventory: meta.closing_inventory,
            last_inventory: meta.last_inventory,
            target_margin_pct: meta.target_margin_pct,
            sms_margin_pct: meta.sms_margin_pct,
            sales_before_count: meta.sales_before_count,
            sales_after_count: meta.sales_after_count,
            sales_during_count: meta.sales_during_count,
            inventory_adjustment: meta.inventory_adjustment,
            variance_explanation: meta.variance_explanation || '',
            updated_at: meta.updated_at || null,
            updated_by: meta.updated_by || '',
        },
        weeks,
        totals: {
            sales: totalSales,
            shrink_dollars: totalShrink,
            shrink_pct: totalShrinkPct,
            purchases,
            goods_available: goodsAvailable,
            cogs,
            gross_profit: grossProfit,
            gross_margin_pct: grossMarginPct,
            sms_gp: smsGp,
            gp_diff: gpDiff,
            gp_diff_pct: gpDiffPct,
            shrink_adjusted_gp: shrinkAdjustedGp,
            shrink_adjusted_margin_pct: shrinkAdjustedMarginPct,
            sales_before_count: salesBeforeCount,
            sales_after_count: salesAfterCount,
            sales_during_count: salesDuringCount,
            sales_during_half: salesDuringHalf,
            inventory_current: closing,
            inventory_last: roundMoney(meta.last_inventory || 0),
            inventory_diff: roundMoney(closing - Number(meta.last_inventory || 0)),
        },
        has_shrink: shrinkBuckets.length > 0,
        has_count_day: ['meat', 'produce', 'centre_store'].includes(dept),
    };
}

function buildAllDeptMargins(db, periodStart) {
    return Object.fromEntries(
        DEPT_KEYS.map((dept) => [dept, buildDeptMarginPayload(db, periodStart, dept)]),
    );
}

function mapRebateRow(row) {
    if (!row) return null;
    const out = { ...row };
    REBATE_DEPT_KEYS.forEach((key) => {
        out[key] = roundMoney(row[key]);
    });
    return out;
}

function listRebateLines(db, periodStart) {
    try {
        return db.all(
            `SELECT * FROM receiving_report_rebate_lines
              WHERE period_start=?
              ORDER BY sort_order, invoice_number`,
            normalizeStoreDate(periodStart),
        ).map(mapRebateRow);
    } catch (_) {
        return [];
    }
}

function nextRebateSort(db, periodStart) {
    const row = db.get(
        'SELECT MAX(sort_order) AS max_sort FROM receiving_report_rebate_lines WHERE period_start=?',
        normalizeStoreDate(periodStart),
    );
    return Number(row?.max_sort || 0) + 1;
}

function saveRebateLine(db, periodStart, raw = {}, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const rebateId = String(raw.rebate_id || raw.rebateId || '').trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = db.get('SELECT rebate_id FROM receiving_report_rebate_lines WHERE rebate_id=?', rebateId);
    const payload = {
        invoice_number: String(raw.invoice_number || raw.invoiceNumber || '').trim(),
        supplier_name: String(raw.supplier_name || raw.supplierName || '').trim(),
        notes: String(raw.notes || '').trim(),
    };
    REBATE_DEPT_KEYS.forEach((key) => {
        payload[key] = parseMoneyOrThrow(raw[key], key);
    });

    if (existing) {
        db.run(
            `UPDATE receiving_report_rebate_lines SET
                invoice_number=?, supplier_name=?,
                grocery=?, tobacco=?, meat=?, bakery=?, bakery_in_store=?,
                deli=?, produce=?, produce_shrink=?, dairy=?, pharmacy=?, gst=?,
                notes=?, updated_at=?, updated_by=?
              WHERE rebate_id=?`,
            payload.invoice_number,
            payload.supplier_name,
            payload.grocery,
            payload.tobacco,
            payload.meat,
            payload.bakery,
            payload.bakery_in_store,
            payload.deli,
            payload.produce,
            payload.produce_shrink,
            payload.dairy,
            payload.pharmacy,
            payload.gst,
            payload.notes,
            now,
            actorName || '',
            rebateId,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_rebate_lines (
                rebate_id, period_start, invoice_number, supplier_name,
                grocery, tobacco, meat, bakery, bakery_in_store, deli, produce, produce_shrink,
                dairy, pharmacy, gst, notes, sort_order, created_at, updated_at, created_by, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            rebateId,
            start,
            payload.invoice_number,
            payload.supplier_name,
            payload.grocery,
            payload.tobacco,
            payload.meat,
            payload.bakery,
            payload.bakery_in_store,
            payload.deli,
            payload.produce,
            payload.produce_shrink,
            payload.dairy,
            payload.pharmacy,
            payload.gst,
            payload.notes,
            Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : nextRebateSort(db, start),
            now,
            now,
            actorName || '',
            actorName || '',
        );
    }

    return mapRebateRow(db.get('SELECT * FROM receiving_report_rebate_lines WHERE rebate_id=?', rebateId));
}

function deleteRebateLine(db, rebateId) {
    const id = String(rebateId || '').trim();
    if (!id) {
        const err = new Error('rebate_id is required.');
        err.status = 400;
        throw err;
    }
    const row = db.get('SELECT rebate_id FROM receiving_report_rebate_lines WHERE rebate_id=?', id);
    if (!row) {
        const err = new Error('Rebate line not found.');
        err.status = 404;
        throw err;
    }
    db.run('DELETE FROM receiving_report_rebate_lines WHERE rebate_id=?', id);
    return { success: true, rebate_id: id };
}

function buildRebatesPayload(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    const ctx = resolvePeriodContext(db, start);
    const lines = listRebateLines(db, start);
    const totals = Object.fromEntries(REBATE_DEPT_KEYS.map((key) => [key, 0]));
    lines.forEach((line) => {
        REBATE_DEPT_KEYS.forEach((key) => {
            totals[key] = roundMoney(totals[key] + Number(line[key] || 0));
        });
    });
    const lineTotal = roundMoney(Object.values(totals).reduce((sum, v) => sum + v, 0));

    return {
        ...ctx,
        period_ending: ctx.week_ends[4] || addDays(start, 34),
        lines,
        totals,
        line_total: lineTotal,
        line_count: lines.length,
    };
}

function listRecounts(db, periodStart) {
    try {
        return db.all(
            `SELECT * FROM receiving_report_recounts
              WHERE period_start=?
              ORDER BY sort_order, location`,
            normalizeStoreDate(periodStart),
        );
    } catch (_) {
        return [];
    }
}

function nextRecountSort(db, periodStart) {
    const row = db.get(
        'SELECT MAX(sort_order) AS max_sort FROM receiving_report_recounts WHERE period_start=?',
        normalizeStoreDate(periodStart),
    );
    return Number(row?.max_sort || 0) + 1;
}

function saveRecount(db, periodStart, raw = {}, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const recountId = String(raw.recount_id || raw.recountId || '').trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = db.get('SELECT recount_id FROM receiving_report_recounts WHERE recount_id=?', recountId);
    const location = String(raw.location || '').trim();
    if (!location) {
        const err = new Error('location is required.');
        err.status = 400;
        throw err;
    }

    const countFirst = raw.count_first ?? raw.countFirst;
    const countSecond = raw.count_second ?? raw.countSecond;
    const first = parseOptionalMoneyOrThrow(countFirst, 'Count 1');
    const second = parseOptionalMoneyOrThrow(countSecond, 'Count 2');

    if (existing) {
        db.run(
            `UPDATE receiving_report_recounts SET
                location=?, count_first=?, count_second=?, updated_at=?, updated_by=?
              WHERE recount_id=?`,
            location,
            first,
            second,
            now,
            actorName || '',
            recountId,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_recounts (
                recount_id, period_start, location, count_first, count_second,
                sort_order, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            recountId,
            start,
            location,
            first,
            second,
            Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : nextRecountSort(db, start),
            now,
            actorName || '',
        );
    }

    return db.get('SELECT * FROM receiving_report_recounts WHERE recount_id=?', recountId);
}

function deleteRecount(db, recountId) {
    const id = String(recountId || '').trim();
    if (!id) {
        const err = new Error('recount_id is required.');
        err.status = 400;
        throw err;
    }
    const row = db.get('SELECT recount_id FROM receiving_report_recounts WHERE recount_id=?', id);
    if (!row) {
        const err = new Error('Recount not found.');
        err.status = 404;
        throw err;
    }
    db.run('DELETE FROM receiving_report_recounts WHERE recount_id=?', id);
    return { success: true, recount_id: id };
}

function buildRecountsPayload(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    const ctx = resolvePeriodContext(db, start);
    const rows = listRecounts(db, start).map((row) => {
        const first = roundMoney(row.count_first || 0);
        const second = roundMoney(row.count_second || 0);
        const variance = roundMoney(first - second);
        const ratio = second ? roundPct(variance / second) : 0;
        return {
            ...row,
            variance_dollars: variance,
            variance_ratio: ratio,
        };
    });

    const totals = {
        count_first: roundMoney(rows.reduce((sum, r) => sum + Number(r.count_first || 0), 0)),
        count_second: roundMoney(rows.reduce((sum, r) => sum + Number(r.count_second || 0), 0)),
    };
    totals.variance_dollars = roundMoney(totals.count_first - totals.count_second);
    totals.variance_ratio = totals.count_second
        ? roundPct(totals.variance_dollars / totals.count_second)
        : 0;

    return {
        ...ctx,
        rows,
        totals,
        row_count: rows.length,
    };
}

function archivePeriodSalesToHistory(db, periodStart, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const sales = buildSalesGrid(db, start);
    const now = new Date().toISOString();
    let archived = 0;

    // Re-closing a period is a rebuild: remove stale category/week cells first,
    // then write every authoritative category, including confirmed zeroes.
    const weekEndings = (sales.week_ends || []).filter(Boolean);
    if (weekEndings.length) {
        const placeholders = weekEndings.map(() => '?').join(', ');
        db.run(
            `DELETE FROM receiving_report_sales_history
              WHERE period_start=? AND week_ending IN (${placeholders})`,
            start,
            ...weekEndings,
        );
    }
    sales.categories.forEach((cat) => {
        for (let w = 1; w <= 5; w += 1) {
            const amount = roundMoney(cat.weeks?.[w] || 0);
            const weekEnding = sales.week_ends[w - 1];
            if (!weekEnding) continue;
            db.run(
                `INSERT INTO receiving_report_sales_history (week_ending, category_key, amount, period_start, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(week_ending, category_key) DO UPDATE SET
                    amount=excluded.amount,
                    period_start=excluded.period_start,
                    updated_at=excluded.updated_at`,
                weekEnding,
                cat.key,
                amount,
                start,
                now,
            );
            archived += 1;
        }
    });

    return { archived, period_start: start, actor: actorName };
}

function buildSalesDataPayload(db, anchorDate) {
    const start = resolvePeriodStart(db, anchorDate);
    let rows = [];
    try {
        rows = db.all(
            `SELECT week_ending, category_key, amount, period_start
               FROM receiving_report_sales_history
              ORDER BY week_ending ASC, category_key ASC`,
        );
    } catch (_) {
        rows = [];
    }

    const weekColumns = [];
    const weekSet = new Set();
    rows.forEach((row) => {
        if (!weekSet.has(row.week_ending)) {
            weekSet.add(row.week_ending);
            weekColumns.push(row.week_ending);
        }
    });

    if (weekColumns.length > 52) {
        weekColumns.splice(0, weekColumns.length - 52);
    }

    const values = {};
    rows.forEach((row) => {
        if (!weekColumns.includes(row.week_ending)) return;
        if (!values[row.category_key]) values[row.category_key] = {};
        values[row.category_key][row.week_ending] = roundMoney(row.amount);
    });

    const categories = SALES_CATEGORIES.map((cat) => ({
        ...cat,
        weeks: Object.fromEntries(
            weekColumns.map((we) => [we, values[cat.key]?.[we] || 0]),
        ),
        total: roundMoney(
            weekColumns.reduce((sum, we) => sum + Number(values[cat.key]?.[we] || 0), 0),
        ),
    }));

    const rollups = {
        dry_grocery: ['grocery', 'fs_paper', 'pop_chips', 'confectionery', 'comm_bakery', 'bakery', 'frozen', 'french_fries'],
        paper: ['fs_paper'],
        hba: ['hba'],
    };

    const rollupRows = Object.entries(rollups).map(([key, keys]) => ({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        weeks: Object.fromEntries(
            weekColumns.map((we) => [
                we,
                roundMoney(keys.reduce((sum, catKey) => sum + Number(values[catKey]?.[we] || 0), 0)),
            ]),
        ),
    }));

    return {
        period_start: start,
        week_columns: weekColumns,
        categories,
        rollups: rollupRows,
        row_count: categories.length,
        column_count: weekColumns.length,
    };
}

function snapshotPeriodInner(db, periodStart, actorName = '', opts = {}) {
    const start = normalizeStoreDate(periodStart);
    const margin = buildMarginPayload(db, start);
    const receiving = buildReceivingTotalsPayload(db, start, {
        costingMethod: margin.costing_method,
    });
    const depts = buildAllDeptMargins(db, start);
    const now = new Date().toISOString();
    const reason = String(opts.reason || '').trim() || 'snapshot';
    const snapshot = {
        costing_method: margin.costing_method || receiving.costing_method || '',
        purchases: {
            base: receiving.base_purchases_total || 0,
            freight: receiving.freight_included_total || 0,
            landed: receiving.landed_purchases_total || 0,
        },
        inventories: {
            opening: margin.meta?.opening_inventory ?? null,
            closing: margin.meta?.closing_inventory ?? null,
        },
        cogs: margin.totals?.cogs ?? null,
        sales: margin.totals?.sales ?? 0,
        gross_profit: margin.totals?.gross_profit ?? null,
        gross_margin_pct: margin.totals?.gross_margin_pct ?? null,
        reconciliation_status: receiving.reconciliation_status || margin.reconciliation_status || '',
        model_status: margin.model_status || '',
        overrides: receiving.overrides || [],
        actor: actorName || '',
        captured_at: now,
        reason,
    };

    db.run(
        `INSERT INTO receiving_report_period_snapshots (
            period_start, period_number, total_grocery_sales, total_grocery_gp,
            total_grocery_margin_pct, centre_store_sales, dairy_sales, meat_sales,
            produce_sales, tobacco_sales, archived_at, costing_method, snapshot_json,
            snapshot_revision, base_purchases_total, freight_included_total,
            landed_purchases_total, reconciliation_status, model_status, archived_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(period_start) DO UPDATE SET
            period_number=excluded.period_number,
            total_grocery_sales=excluded.total_grocery_sales,
            total_grocery_gp=excluded.total_grocery_gp,
            total_grocery_margin_pct=excluded.total_grocery_margin_pct,
            centre_store_sales=excluded.centre_store_sales,
            dairy_sales=excluded.dairy_sales,
            meat_sales=excluded.meat_sales,
            produce_sales=excluded.produce_sales,
            tobacco_sales=excluded.tobacco_sales,
            archived_at=excluded.archived_at,
            costing_method=excluded.costing_method,
            snapshot_json=excluded.snapshot_json,
            snapshot_revision=receiving_report_period_snapshots.snapshot_revision + 1,
            base_purchases_total=excluded.base_purchases_total,
            freight_included_total=excluded.freight_included_total,
            landed_purchases_total=excluded.landed_purchases_total,
            reconciliation_status=excluded.reconciliation_status,
            model_status=excluded.model_status,
            archived_by=excluded.archived_by`,
        start,
        margin.meta?.period_number ?? margin.period_number ?? null,
        margin.totals?.sales ?? 0,
        margin.totals?.gross_profit ?? 0,
        margin.totals?.gross_margin_pct ?? 0,
        depts.centre_store?.totals?.sales ?? 0,
        depts.dairy?.totals?.sales ?? 0,
        depts.meat?.totals?.sales ?? 0,
        depts.produce?.totals?.sales ?? 0,
        depts.tobacco?.totals?.sales ?? 0,
        now,
        snapshot.costing_method,
        JSON.stringify(snapshot),
        snapshot.purchases.base,
        snapshot.purchases.freight,
        snapshot.purchases.landed,
        snapshot.reconciliation_status,
        snapshot.model_status,
        actorName || '',
    );

    const current = db.get('SELECT * FROM receiving_report_period_snapshots WHERE period_start=?', start);
    const revision = Number(current?.snapshot_revision || 1);
    const marginOutputs = {
        totals: margin.totals || null,
        meta: margin.meta || null,
        model_status: margin.model_status || '',
        weeks: margin.weeks || [],
    };
    db.run(
        `INSERT INTO receiving_report_period_snapshot_revisions (
                revision_id, period_start, revision, costing_method,
                base_purchases_total, freight_included_total, landed_purchases_total,
                reconciliation_status, model_status, margin_outputs_json, snapshot_json,
                actor_name, reason, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            crypto.randomUUID(),
            start,
            revision,
            snapshot.costing_method,
            snapshot.purchases.base,
            snapshot.purchases.freight,
            snapshot.purchases.landed,
            snapshot.reconciliation_status,
            snapshot.model_status,
            JSON.stringify(marginOutputs),
            JSON.stringify(snapshot),
            actorName || '',
            reason,
            now,
    );
    return current;
}

function snapshotPeriod(db, periodStart, actorName = '', opts = {}) {
    const createSnapshot = () => snapshotPeriodInner(db, periodStart, actorName, opts);
    return typeof db.transaction === 'function'
        ? db.transaction(createSnapshot)()
        : createSnapshot();
}

function listSnapshotRevisions(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    try {
        return db.all(
            `SELECT * FROM receiving_report_period_snapshot_revisions
              WHERE period_start=?
              ORDER BY revision ASC, created_at ASC`,
            start,
        ) || [];
    } catch (_) {
        return [];
    }
}

function buildMarginYtdPayload(db, anchorDate) {
    const start = resolvePeriodStart(db, anchorDate);
    let snapshots = [];
    try {
        snapshots = db.all(
            `SELECT * FROM receiving_report_period_snapshots
              ORDER BY period_start ASC`,
        );
    } catch (_) {
        snapshots = [];
    }

    const current = buildMarginPayload(db, start);
    const currentRow = {
        period_start: start,
        period_number: current.meta?.period_number ?? current.period_number,
        total_grocery_sales: current.totals?.sales ?? 0,
        total_grocery_gp: current.totals?.gross_profit ?? 0,
        total_grocery_margin_pct: current.totals?.gross_margin_pct ?? 0,
        is_current: true,
    };

    const allRows = [...snapshots.filter((s) => s.period_start !== start), currentRow]
        .sort((a, b) => a.period_start.localeCompare(b.period_start));

    const totals = {
        total_grocery_sales: roundMoney(allRows.reduce((sum, r) => sum + Number(r.total_grocery_sales || 0), 0)),
        total_grocery_gp: roundMoney(allRows.reduce((sum, r) => sum + Number(r.total_grocery_gp || 0), 0)),
    };
    totals.avg_margin_pct = totals.total_grocery_sales
        ? roundPct(totals.total_grocery_gp / totals.total_grocery_sales)
        : 0;

    return {
        period_start: start,
        rows: allRows,
        totals,
        period_count: allRows.length,
    };
}

function buildExtendedPeriodPayload(db, anchorDate) {
    const start = resolvePeriodStart(db, anchorDate);
    let count_cycle = null;
    try {
        const { buildCountCyclePayload } = require('./edmonton-receiving-count-cycle.cjs');
        count_cycle = buildCountCyclePayload(db, start);
    } catch (_) {
        count_cycle = null;
    }
    return {
        dept_margins: buildAllDeptMargins(db, start),
        rebates: buildRebatesPayload(db, start),
        recounts: buildRecountsPayload(db, start),
        sales_data: buildSalesDataPayload(db, anchorDate),
        margin_ytd: buildMarginYtdPayload(db, anchorDate),
        count_cycle,
    };
}

module.exports = {
    DEPT_KEYS,
    DEPT_LABELS,
    DEPT_SHEET_NAMES,
    REBATE_DEPT_KEYS,
    buildDeptMarginPayload,
    buildAllDeptMargins,
    saveDeptMarginMeta,
    readDeptMarginMeta,
    listRebateLines,
    saveRebateLine,
    deleteRebateLine,
    buildRebatesPayload,
    listRecounts,
    saveRecount,
    deleteRecount,
    buildRecountsPayload,
    archivePeriodSalesToHistory,
    buildSalesDataPayload,
    snapshotPeriod,
    listSnapshotRevisions,
    buildMarginYtdPayload,
    buildExtendedPeriodPayload,
};
