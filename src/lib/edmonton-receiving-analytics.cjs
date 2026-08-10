'use strict';

const { upsertSetting } = require('./settings-store.cjs');
const { createStoreTimeAccessors } = require('./store-time.cjs');
const { roundMoney, parseMoneyOrThrow, parseOptionalMoneyOrThrow } = require('./parse-money.cjs');
const {
    addDays,
    normalizeStoreDate,
    resolvePeriodStart,
    resolveSheetMeta,
    listLines,
    buildLineWarningsForDay,
    SETTING_PERIOD_START,
} = require('./edmonton-receiving-report.cjs');
const {
    PURCHASE_FIELDS,
    FREIGHT_DEPT_KEYS,
    FREIGHT_COLUMN,
    COSTING_METHOD,
    COSTING_MODE,
    FREIGHT_ALLOC_PCT,
    allocateFreight,
    normalizeCostingMethod,
    normalizeCostingMode,
    resolvePeriodCostingMethod,
    setPeriodCostingMethod,
    applyCostingToDay,
    reconcileDayFreight,
    readFreightTolerance,
    computeItemLandedCost,
    buildFreightValidationVariance,
    DEFAULT_FREIGHT_TOLERANCE,
} = require('./edmonton-receiving-costing.cjs');
const { resolveAppliedFreightRatePercent } = require('./receiving-period-freight-rates.cjs');
const {
    resolveAllocProfile,
    requireConfirmedAllocProfile,
} = require('./receiving-period-freight-alloc.cjs');

const SETTING_PERIOD_NUMBER = 'Receiving_Report_Period_Number';

const SALES_CATEGORIES = [
    { key: 'grocery', code: '1', label: 'GROCERY', rollup: 'dry_grocery' },
    { key: 'fs_paper', code: '2', label: 'FS PAPER', rollup: 'dry_grocery' },
    { key: 'hba', code: '3', label: 'HBA', rollup: 'hbc' },
    { key: 'dairy', code: '5', label: 'DAIRY', rollup: 'dairy' },
    { key: 'meat', code: '6', label: 'MEAT', rollup: 'meat' },
    { key: 'non_foods_1', code: '7', label: 'NON FOODS 1', rollup: 'non_foods' },
    { key: 'non_foods_2', code: '8', label: 'NON FOODS 2', rollup: 'non_foods' },
    { key: 'pop_chips', code: '13', label: 'POP&CHIPS', rollup: 'confection' },
    { key: 'confectionery', code: '14', label: 'CONFECTIONERY', rollup: 'confection' },
    { key: 'tobacco', code: '15', label: 'TOBACCO', rollup: 'tobacco' },
    { key: 'cigarettes', code: '16', label: 'CIGARETTES', rollup: 'tobacco' },
    { key: 'comm_bakery', code: '18', label: 'COMM BAKERY', rollup: 'bakery_grocery' },
    { key: 'deli', code: '19', label: 'DELI', rollup: null },
    { key: 'frozen', code: '20', label: 'FROZEN', rollup: 'frozen' },
    { key: 'bakery', code: '21', label: 'BAKERY', rollup: 'bakery_grocery' },
    { key: 'produce', code: '22', label: 'PRODUCE', rollup: 'produce' },
    { key: 'produce_selloff', code: '23', label: 'PRODUCE SELLOFF', rollup: 'produce' },
    { key: 'frz_seafood', code: '28', label: 'FRZ SEAFOOD', rollup: 'frozen' },
    { key: 'froz_meat', code: '29', label: 'FROZ MEAT', rollup: 'meat' },
    { key: 'blackhawk', code: '41', label: 'BLACKHAWK', rollup: null },
    { key: 'frz_seafood_meat', code: '43', label: 'FRZ SEAFOOD Meat', rollup: 'meat' },
    { key: 'cooler_ctch_wt', code: '45', label: 'COOLER CTCH WT', rollup: null },
    { key: 'french_fries', code: '47', label: 'FRENCH FRIES', rollup: 'frozen' },
    { key: 'fs_milk', code: '53', label: 'FS MILK', rollup: 'dairy' },
    { key: 'books', code: '55', label: 'BOOKS', rollup: null },
    { key: 'magazines', code: '56', label: 'MAGAZINES', rollup: null },
    { key: 'deposit', code: '39', label: 'DEPOSIT', rollup: null },
    { key: 'enviro_fee', code: '40', label: 'ENVIRO FEE', rollup: null },
    { key: 'handling_fee', code: null, label: 'HANDLING FEE', rollup: null, integer: true },
    { key: 'customers', code: null, label: 'CUSTOMERS', rollup: null, integer: true },
];

const ROLLUP_GROUPS = {
    dry_grocery: ['grocery', 'fs_paper'],
    hbc: ['hba'],
    dairy: ['dairy', 'fs_milk'],
    non_foods: ['non_foods_1', 'non_foods_2'],
    confection: ['pop_chips', 'confectionery'],
    bakery_grocery: ['comm_bakery', 'bakery'],
    // Centre-store frozen only — Froz Meat belongs with Meat (Balance Sheet Calculator).
    frozen: ['frozen', 'frz_seafood', 'french_fries'],
    meat: ['meat', 'frz_seafood_meat', 'froz_meat'],
    tobacco: ['tobacco', 'cigarettes'],
    produce: ['produce', 'produce_selloff'],
};

/** Fees included in centre store / Total Grocery (Balance Sheet "Included Additional Values"). */
const CENTRE_STORE_FEE_KEYS = ['deposit', 'enviro_fee', 'handling_fee'];

const ROLLUP_LABELS = {
    dry_grocery: 'Dry Grocery',
    hbc: 'HBC',
    dairy: 'Dairy',
    non_foods: 'Non-Foods',
    confection: 'Confection',
    bakery_grocery: 'Bakery-Grocery',
    frozen: 'Frozen Food',
    meat: 'Meat',
    tobacco: 'Tobacco',
    produce: 'Produce',
};

const SHRINK_BUCKETS = ['bakery', 'dairy', 'freezer', 'grocery', 'meat', 'produce'];

const SHRINK_DEPT_MAP = {
    bakery: ['bakery', 'comm_bakery'],
    dairy: ['dairy', 'fs_milk'],
    freezer: ['frozen', 'frz_seafood', 'french_fries'],
    grocery: ['grocery'],
    meat: ['meat', 'froz_meat', 'frz_seafood_meat'],
    produce: ['produce', 'produce_shrink'],
};

const GROCERY_MARGIN_SHRINK_BUCKETS = ['bakery', 'dairy', 'freezer', 'grocery'];

function roundPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 1000000) / 1000000;
}

function readPeriodNumberSetting(db) {
    const row = db.get(
        'SELECT setting_value FROM settings WHERE setting_name=?',
        SETTING_PERIOD_NUMBER,
    );
    const val = String(row?.setting_value || '').trim();
    const num = Number(val);
    return Number.isFinite(num) && num > 0 ? num : null;
}

function resolvePeriodContext(db, anchorDate) {
    const periodStart = resolvePeriodStart(db, anchorDate);
    const weekEnds = [];
    for (let w = 1; w <= 5; w += 1) {
        weekEnds.push(addDays(periodStart, w * 7 - 1));
    }
    const periodEnd = addDays(periodStart, 34);
    return {
        period_start: periodStart,
        period_end: periodEnd,
        week_ends: weekEnds,
        period_number: readPeriodNumberSetting(db),
    };
}

/** End date for purchase/shrink rollups — clips before the next period starts. */
function resolvePurchaseWindowEnd(db, periodStart) {
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
        if (next?.period_start && next.period_start > start) {
            const clipped = addDays(next.period_start, -1);
            if (clipped >= start && clipped < end) end = clipped;
        }
    } catch (_) { /* optional */ }
    return end;
}

function listDatesInclusive(start, end) {
    const dates = [];
    let cursor = normalizeStoreDate(start);
    const last = normalizeStoreDate(end);
    while (cursor <= last) {
        dates.push(cursor);
        cursor = addDays(cursor, 1);
    }
    return dates;
}

function listPeriodDates(periodStart) {
    const start = normalizeStoreDate(periodStart);
    const dates = [];
    for (let i = 0; i < 35; i += 1) {
        dates.push(addDays(start, i));
    }
    return dates;
}

function weekNumForDate(periodStart, storeDate) {
    const meta = resolveSheetMeta(storeDate, periodStart);
    return meta.weekNum;
}

function emptyWeekMap() {
    return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
}

function sumWeekMap(map) {
    return roundMoney(Object.values(map).reduce((sum, v) => sum + Number(v || 0), 0));
}

function readSalesRows(db, periodStart) {
    try {
        return db.all(
            `SELECT week_num, category_key, amount
               FROM receiving_report_sales
              WHERE period_start=?`,
            normalizeStoreDate(periodStart),
        );
    } catch (_) {
        return [];
    }
}

function buildSalesGrid(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    const ctx = resolvePeriodContext(db, start);
    const stored = readSalesRows(db, start);
    const values = {};
    stored.forEach((row) => {
        const w = Number(row.week_num);
        if (!values[row.category_key]) values[row.category_key] = emptyWeekMap();
        if (w >= 1 && w <= 5) values[row.category_key][w] = roundMoney(row.amount);
    });

    const categories = SALES_CATEGORIES.map((cat) => {
        const weeks = values[cat.key] || emptyWeekMap();
        return {
            ...cat,
            weeks,
            entered_weeks: Object.keys(values[cat.key] || {}).map(Number).filter((w) => w >= 1 && w <= 5),
            total: sumWeekMap(weeks),
        };
    });
    let zeroConfirmations = [];
    try {
        zeroConfirmations = db.all(
            `SELECT period_start, category_key, week_number, confirmed_by, confirmed_at, reason
               FROM receiving_report_sales_zero_confirm
              WHERE period_start=? AND confirmed_zero=1
              ORDER BY week_number, category_key`,
            start,
        ) || [];
    } catch (_) { /* migration 057 not present on old database */ }

    const rollups = {};
    Object.entries(ROLLUP_GROUPS).forEach(([rollupKey, keys]) => {
        const weeks = emptyWeekMap();
        for (let w = 1; w <= 5; w += 1) {
            weeks[w] = roundMoney(keys.reduce((sum, key) => {
                const cat = categories.find((c) => c.key === key);
                return sum + Number(cat?.weeks?.[w] || 0);
            }, 0));
        }
        rollups[rollupKey] = {
            key: rollupKey,
            label: ROLLUP_LABELS[rollupKey] || rollupKey,
            weeks,
            total: sumWeekMap(weeks),
        };
    });

    const summary = {
        tobacco: rollups.tobacco.weeks,
        meat: rollups.meat.weeks,
        fruits_veg: categories.find((c) => c.key === 'produce')?.weeks || emptyWeekMap(),
        produce_dept: rollups.produce.weeks,
        centre_store: emptyWeekMap(),
        grocery: emptyWeekMap(),
        total: emptyWeekMap(),
    };

    for (let w = 1; w <= 5; w += 1) {
        const rollupGrocery = Object.entries(rollups)
            .filter(([key]) => !['meat', 'tobacco', 'produce'].includes(key))
            .reduce((sum, [, group]) => sum + Number(group.weeks[w] || 0), 0);
        const feeExtras = CENTRE_STORE_FEE_KEYS.reduce((sum, key) => {
            const cat = categories.find((c) => c.key === key);
            return sum + Number(cat?.weeks?.[w] || 0);
        }, 0);
        // Total Grocery ≈ centre-store departments + dairy (+ fees). Excludes meat/tobacco/produce.
        summary.grocery[w] = roundMoney(rollupGrocery + feeExtras);
        const dairyWeek = roundMoney(Number(rollups.dairy?.weeks?.[w] || 0));
        // Centre Store = Total Grocery without dairy (Balance Sheet Calculator departments + fees).
        summary.centre_store[w] = roundMoney(summary.grocery[w] - dairyWeek);
        summary.total[w] = roundMoney(
            Object.values(rollups).reduce((sum, group) => sum + Number(group.weeks[w] || 0), 0)
            + feeExtras,
        );
    }

    summary.centre_store.total = sumWeekMap(summary.centre_store);
    summary.grocery.total = sumWeekMap(summary.grocery);
    summary.total.total = sumWeekMap(summary.total);

    return {
        ...ctx,
        categories,
        zero_confirmations: zeroConfirmations,
        rollups: Object.values(rollups),
        summary,
    };
}

function saveSalesAmount(db, periodStart, weekNum, categoryKey, amount, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const week = Number(weekNum);
    const key = String(categoryKey || '').trim();
    if (week < 1 || week > 5) {
        const err = new Error('week_num must be between 1 and 5.');
        err.status = 400;
        throw err;
    }
    if (!SALES_CATEGORIES.some((c) => c.key === key)) {
        const err = new Error(`Unknown sales category "${key}".`);
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO receiving_report_sales (period_start, week_num, category_key, amount, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(period_start, week_num, category_key) DO UPDATE SET
            amount=excluded.amount,
            updated_at=excluded.updated_at,
            updated_by=excluded.updated_by`,
        start,
        week,
        key,
        parseMoneyOrThrow(amount, 'Sales amount'),
        now,
        actorName || '',
    );
    // A manager's "remaining blanks are zero" statement is a review of the
    // current week. Any later sales edit makes that acknowledgement stale.
    try {
        db.run(
            `DELETE FROM receiving_report_sales_zero_confirm
              WHERE period_start=? AND week_number=? AND category_key='__week__'`,
            start,
            week,
        );
    } catch (_) { /* table added in migration 057 */ }
    return buildSalesGrid(db, start);
}

/**
 * Explicit confirmation that a sales week/category is intentionally zero (blank ≠ zero).
 */
function saveSalesZeroConfirm(db, periodStart, categoryKey, weekNumber, actor = '', reason = '') {
    const start = normalizeStoreDate(periodStart);
    const week = Number(weekNumber);
    const key = String(categoryKey || '').trim() || '__week__';
    const why = String(reason || '').trim();
    if (week < 1 || week > 5) {
        const err = new Error('week_number must be between 1 and 5.');
        err.status = 400;
        throw err;
    }
    if (!why) {
        const err = new Error('A reason is required to confirm sales as zero.');
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    const confirmId = require('crypto').randomUUID();
    db.run(
        `INSERT INTO receiving_report_sales_zero_confirm (
            confirm_id, period_start, category_key, week_number,
            confirmed_zero, confirmed_by, confirmed_at, reason
         ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(period_start, category_key, week_number) DO UPDATE SET
            confirmed_zero=1,
            confirmed_by=excluded.confirmed_by,
            confirmed_at=excluded.confirmed_at,
            reason=excluded.reason`,
        confirmId,
        start,
        key,
        week,
        actor || '',
        now,
        why,
    );
    return db.get(
        `SELECT * FROM receiving_report_sales_zero_confirm
          WHERE period_start=? AND category_key=? AND week_number=?`,
        start,
        key,
        week,
    );
}

function savePeriodNumber(db, periodNumber) {
    const num = Number(periodNumber);
    if (!Number.isFinite(num) || num <= 0) {
        upsertSetting(db, SETTING_PERIOD_NUMBER, '');
        return null;
    }
    upsertSetting(db, SETTING_PERIOD_NUMBER, String(Math.floor(num)));
    return Math.floor(num);
}

/**
 * @param {object} db
 * @param {string} periodStart
 * @param {string|null} [periodEnd]
 * @param {{ costingMethod?: string, allocateFreight?: boolean }} [opts]
 */
function aggregateDailyPurchases(db, periodStart, periodEnd = null, opts = {}) {
    const start = normalizeStoreDate(periodStart);
    const end = periodEnd ? normalizeStoreDate(periodEnd) : addDays(start, 34);
    let method = normalizeCostingMethod(opts.costingMethod || opts.costingMode);
    if (!method) {
        if (opts.allocateFreight === false) method = COSTING_METHOD.BASE_COST_ONLY;
        else if (opts.allocateFreight === true) method = COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION;
        else method = resolvePeriodCostingMethod(db, start).method;
    }
    method = normalizeCostingMethod(method) || method;
    const dates = listDatesInclusive(start, end);
    const byDate = {};
    dates.forEach((date) => {
        byDate[date] = {
            store_date: date,
            week_num: weekNumForDate(periodStart, date),
            purchases: Object.fromEntries(PURCHASE_FIELDS.map(([key]) => [key, 0])),
            base_purchases: Object.fromEntries(PURCHASE_FIELDS.map(([key]) => [key, 0])),
            freight_included: Object.fromEntries(FREIGHT_DEPT_KEYS.map((key) => [key, 0])),
            entered_freight_by_dept: Object.fromEntries(FREIGHT_DEPT_KEYS.map((key) => [key, 0])),
            freight_total: 0,
            entered_freight_total: 0,
            expected_freight: null,
            applied_freight_rate: null,
            costing_method: method,
        };
    });

    const freightCols = FREIGHT_DEPT_KEYS.map((k) => FREIGHT_COLUMN[k]).join(', ');
    let rows = [];
    try {
        rows = db.all(
            `SELECT store_date, line_kind, grocery, tobacco, meat, bakery, bakery_in_store, deli,
                    produce, produce_shrink, dairy, pharmacy, gst, ${freightCols}
               FROM receiving_report_lines
              WHERE store_date >= ? AND store_date <= ?
                AND COALESCE(NULLIF(TRIM(line_kind), ''), 'invoice') = 'invoice'`,
            dates[0],
            dates[dates.length - 1],
        ) || [];
    } catch (_) {
        // Pre-migration DBs may lack freight_* columns — fall back to base only.
        rows = db.all(
            `SELECT store_date, line_kind, grocery, tobacco, meat, bakery, bakery_in_store, deli,
                    produce, produce_shrink, dairy, pharmacy, gst
               FROM receiving_report_lines
              WHERE store_date >= ? AND store_date <= ?
                AND COALESCE(NULLIF(TRIM(line_kind), ''), 'invoice') = 'invoice'`,
            dates[0],
            dates[dates.length - 1],
        ) || [];
    }

    const linesByDate = {};
    rows.forEach((row) => {
        if (!linesByDate[row.store_date]) linesByDate[row.store_date] = [];
        linesByDate[row.store_date].push(row);
    });

    let freightRows = [];
    try {
        freightRows = db.all(
            `SELECT store_date, freight_total, freight_recon_status, freight_override_reason,
                    freight_override_by, freight_override_at, freight_tolerance
               FROM receiving_report_day
              WHERE store_date >= ? AND store_date <= ?`,
            dates[0],
            dates[dates.length - 1],
        ) || [];
    } catch (_) {
        try {
            freightRows = db.all(
                `SELECT store_date, freight_total
                   FROM receiving_report_day
                  WHERE store_date >= ? AND store_date <= ?`,
                dates[0],
                dates[dates.length - 1],
            ) || [];
        } catch (__) {
            freightRows = [];
        }
    }
    const dayMetaByDate = {};
    freightRows.forEach((row) => {
        dayMetaByDate[row.store_date] = row;
    });

    const tolerance = readFreightTolerance(db);
    let ratePercent = opts.ratePercent;
    let missingRate = false;
    let pctFractions = opts.pctFractions || null;
    let missingAllocProfile = false;
    let allocProfileStatus = null;

    if (method === COSTING_METHOD.PERIOD_RATE && ratePercent == null) {
        try {
            ratePercent = resolveAppliedFreightRatePercent(db, start);
        } catch (e) {
            if (e?.code === 'FREIGHT_RATE_MISSING') {
                // Structural payloads (import, open dashboards) must not invent a rate or
                // silently apply 0%. Aggregate eligible merchandise only and surface the gap.
                // Confirm / close remain fail-closed.
                if (opts.requireFreightRate) throw e;
                missingRate = true;
            } else {
                throw e;
            }
        }
    }

    if (method === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION && pctFractions == null) {
        const failClosed = !!(opts.requireFreightRate || opts.requireAllocProfile);
        try {
            if (failClosed) {
                const confirmed = requireConfirmedAllocProfile(db, start);
                pctFractions = confirmed.pct_fractions;
                allocProfileStatus = confirmed.status;
            } else {
                const resolved = resolveAllocProfile(db, start);
                allocProfileStatus = resolved.status;
                if (resolved.pct_fractions) {
                    // Confirmed or draft fractions — use for soft dashboard aggregation.
                    pctFractions = resolved.pct_fractions;
                } else {
                    missingAllocProfile = true;
                }
            }
        } catch (e) {
            if (e?.code === 'FREIGHT_ALLOC_PROFILE_MISSING' || e?.code === 'FREIGHT_ALLOC_PROFILE_INVALID') {
                if (failClosed) throw e;
                missingAllocProfile = true;
            } else {
                throw e;
            }
        }
    }

    // When rate/profile is missing, do not invent 0% math — aggregate base merchandise only.
    const applyMethod = (
        (method === COSTING_METHOD.PERIOD_RATE && missingRate)
        || (method === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION && missingAllocProfile)
    )
        ? COSTING_METHOD.BASE_COST_ONLY
        : method;
    dates.forEach((date) => {
        const dayMeta = dayMetaByDate[date] || {};
        const applyOpts = {};
        if (applyMethod === COSTING_METHOD.PERIOD_RATE) applyOpts.ratePercent = ratePercent;
        if (applyMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION && pctFractions) {
            applyOpts.pctFractions = pctFractions;
        }
        const applied = applyCostingToDay(
            linesByDate[date] || [],
            dayMeta.freight_total,
            applyMethod,
            applyOpts,
        );
        const bucket = byDate[date];
        bucket.purchases = applied.purchases;
        bucket.base_purchases = applied.base_purchases;
        bucket.freight_included = applied.freight_included;
        bucket.entered_freight_by_dept = applied.entered_freight_by_dept;
        // Authoritative day total = Daily Freight Allocation Total (N3 / freight_total).
        bucket.freight_total = applied.expected_freight || 0;
        bucket.daily_freight_allocation_total = applied.expected_freight;
        bucket.expected_freight = applied.expected_freight;
        bucket.entered_freight_total = applied.entered_freight_total;
        bucket.base_purchases_total = applied.base_purchases_total;
        bucket.freight_included_total = applied.freight_included_total;
        bucket.landed_purchases_total = applied.landed_purchases_total;
        bucket.applied_freight_rate = applied.applied_freight_rate;
        bucket.base_payable = applied.base_payable;
        const override = String(dayMeta.freight_recon_status || '').toUpperCase() === 'OVERRIDE'
            || !!String(dayMeta.freight_override_reason || '').trim();
        const dayLines = linesByDate[date] || [];
        const hasActivity = dayLines.length > 0 || dayMeta.freight_total != null;
        // Inactive days (no lines, no expected freight) are not part of period recon rollup.
        bucket.reconciliation = hasActivity
            ? reconcileDayFreight({
                expected: applied.expected_freight,
                entered: applied.entered_freight_total,
                tolerance: dayMeta.freight_tolerance != null ? Number(dayMeta.freight_tolerance) : tolerance,
                override,
            })
            : { status: 'PASS', expected: null, entered: 0, difference: 0, tolerance, inactive: true };
        bucket.active_for_recon = hasActivity;
        bucket.missing_rate = missingRate;
        bucket.missing_alloc_profile = missingAllocProfile;
        bucket.freight_rate_status = missingRate ? 'FREIGHT_RATE_MISSING' : null;
        bucket.freight_alloc_profile_status = missingAllocProfile
            ? 'FREIGHT_ALLOC_PROFILE_MISSING'
            : allocProfileStatus;
    });

    Object.defineProperty(byDate, '__missing_rate', {
        value: missingRate,
        enumerable: false,
        configurable: true,
    });
    Object.defineProperty(byDate, '__missing_alloc_profile', {
        value: missingAllocProfile,
        enumerable: false,
        configurable: true,
    });
    Object.defineProperty(byDate, '__alloc_profile_status', {
        value: allocProfileStatus,
        enumerable: false,
        configurable: true,
    });
    return byDate;
}

function mapShrinkDepartment(dept) {
    const d = String(dept || 'grocery').toLowerCase();
    for (const [bucket, keys] of Object.entries(SHRINK_DEPT_MAP)) {
        if (keys.includes(d)) return bucket;
    }
    return 'grocery';
}

function aggregateDailyShrink(db, periodStart, periodEnd = null) {
    const start = normalizeStoreDate(periodStart);
    const end = periodEnd ? normalizeStoreDate(periodEnd) : addDays(start, 34);
    const dates = listDatesInclusive(start, end);
    const byDate = {};
    dates.forEach((date) => {
        byDate[date] = {
            store_date: date,
            week_num: weekNumForDate(periodStart, date),
            shrink: Object.fromEntries(SHRINK_BUCKETS.map((key) => [key, 0])),
        };
    });

    let shrinkRows = [];
    try {
        shrinkRows = db.all(
            `SELECT store_date, department, extended_cost
               FROM receiving_shrink_lines
              WHERE store_date >= ? AND store_date <= ?`,
            dates[0],
            dates[dates.length - 1],
        );
    } catch (_) {
        shrinkRows = [];
    }

    shrinkRows.forEach((row) => {
        const bucket = byDate[row.store_date];
        if (!bucket) return;
        const key = mapShrinkDepartment(row.department);
        bucket.shrink[key] = roundMoney(bucket.shrink[key] + Math.abs(Number(row.extended_cost || 0)));
    });

    return byDate;
}

function buildReceivingTotalsPayload(db, periodStart, opts = {}) {
    const start = normalizeStoreDate(periodStart);
    const resolved = resolvePeriodCostingMethod(db, start);
    let costingMethod = normalizeCostingMethod(opts.costingMethod || opts.costingMode);
    if (!costingMethod) costingMethod = resolved.method;
    const ctx = resolvePeriodContext(db, start);
    const windowEnd = resolvePurchaseWindowEnd(db, start);
    const purchasesByDate = aggregateDailyPurchases(db, start, windowEnd, {
        costingMethod,
        ratePercent: opts.ratePercent,
        pctFractions: opts.pctFractions,
        requireFreightRate: opts.requireFreightRate,
        requireAllocProfile: opts.requireAllocProfile,
    });
    const missingRate = !!purchasesByDate.__missing_rate;
    const missingAllocProfile = !!purchasesByDate.__missing_alloc_profile;
    const allocProfileStatus = purchasesByDate.__alloc_profile_status || null;
    delete purchasesByDate.__missing_rate;
    delete purchasesByDate.__missing_alloc_profile;
    delete purchasesByDate.__alloc_profile_status;
    const softUnavailable = missingRate || missingAllocProfile;
    const shrinkByDate = aggregateDailyShrink(db, start, windowEnd);
    const dates = listDatesInclusive(start, windowEnd);

    const days = dates.map((date) => {
        const dayPurch = purchasesByDate[date] || {};
        const purchases = dayPurch.purchases || {};
        const shrink = shrinkByDate[date]?.shrink || {};
        const weekNum = weekNumForDate(start, date);
        const dayOfWeek = resolveSheetMeta(date, start).dayOfWeek;
        return {
            store_date: date,
            week_num: weekNum,
            day_of_week: dayOfWeek,
            is_week_end: dayOfWeek === 6,
            purchases,
            base_purchases: dayPurch.base_purchases || {},
            freight_included: dayPurch.freight_included || {},
            entered_freight_by_dept: dayPurch.entered_freight_by_dept || {},
            shrink,
            freight_total: roundMoney(dayPurch.freight_total || 0),
            daily_freight_allocation_total: dayPurch.daily_freight_allocation_total ?? dayPurch.expected_freight ?? null,
            expected_freight: dayPurch.expected_freight,
            entered_freight_total: dayPurch.entered_freight_total || 0,
            reconciliation: dayPurch.reconciliation || null,
            base_purchases_total: dayPurch.base_purchases_total || 0,
            freight_included_total: dayPurch.freight_included_total || 0,
            landed_purchases_total: dayPurch.landed_purchases_total || 0,
            applied_freight_rate: dayPurch.applied_freight_rate ?? null,
        };
    });

    const weeklyShrink = [];
    for (let w = 1; w <= 5; w += 1) {
        const weekDays = days.filter((d) => d.week_num === w);
        const subtotal = Object.fromEntries(SHRINK_BUCKETS.map((key) => [key, 0]));
        weekDays.forEach((day) => {
            SHRINK_BUCKETS.forEach((key) => {
                subtotal[key] = roundMoney(subtotal[key] + Number(day.shrink[key] || 0));
            });
        });
        weeklyShrink.push({
            week_num: w,
            week_ending: ctx.week_ends[w - 1],
            shrink: subtotal,
            total: roundMoney(SHRINK_BUCKETS.reduce((sum, key) => sum + subtotal[key], 0)),
        });
    }

    const purchaseTotals = Object.fromEntries(PURCHASE_FIELDS.map(([key]) => [key, 0]));
    const baseTotals = Object.fromEntries(PURCHASE_FIELDS.map(([key]) => [key, 0]));
    const freightTotals = Object.fromEntries(FREIGHT_DEPT_KEYS.map((key) => [key, 0]));
    const enteredFreightByDept = Object.fromEntries(FREIGHT_DEPT_KEYS.map((key) => [key, 0]));
    days.forEach((day) => {
        PURCHASE_FIELDS.forEach(([key]) => {
            purchaseTotals[key] = roundMoney(purchaseTotals[key] + Number(day.purchases[key] || 0));
            baseTotals[key] = roundMoney(baseTotals[key] + Number(day.base_purchases?.[key] || 0));
        });
        FREIGHT_DEPT_KEYS.forEach((key) => {
            freightTotals[key] = roundMoney(
                freightTotals[key] + Number(day.freight_included?.[key] || 0),
            );
            enteredFreightByDept[key] = roundMoney(
                enteredFreightByDept[key] + Number(day.entered_freight_by_dept?.[key] || 0),
            );
        });
        if (day.freight_included?.produce_shrink) {
            freightTotals.produce_shrink = roundMoney(
                Number(freightTotals.produce_shrink || 0) + Number(day.freight_included.produce_shrink || 0),
            );
        }
    });

    // Net period rebates into purchases (Excel Receiving Totals includes rebate rows as negatives).
    try {
        const rebateRows = db.all(
            `SELECT grocery, tobacco, meat, bakery, bakery_in_store, deli,
                    produce, produce_shrink, dairy, pharmacy
               FROM receiving_report_rebate_lines
              WHERE period_start=?`,
            start,
        ) || [];
        rebateRows.forEach((line) => {
            PURCHASE_FIELDS.forEach(([key]) => {
                purchaseTotals[key] = roundMoney(purchaseTotals[key] + Number(line[key] || 0));
                baseTotals[key] = roundMoney(baseTotals[key] + Number(line[key] || 0));
            });
        });
    } catch (_) { /* rebates table optional */ }

    const freightMemoTotal = roundMoney(
        days.reduce((sum, day) => sum + Number(day.freight_total || 0), 0),
    );
    const dailyFreightAllocationTotal = roundMoney(
        days.reduce((sum, day) => {
            const v = day.daily_freight_allocation_total != null
                ? day.daily_freight_allocation_total
                : day.freight_total;
            return sum + Number(v || 0);
        }, 0),
    );
    const enteredFreightTotal = roundMoney(
        days.reduce((sum, day) => sum + Number(day.entered_freight_total || 0), 0),
    );
    const freightIncludedTotal = roundMoney(
        Object.values(freightTotals).reduce((s, v) => s + Number(v || 0), 0),
    );
    const basePurchasesTotal = roundMoney(
        Object.values(baseTotals).reduce((s, v) => s + Number(v || 0), 0),
    );
    const reconStatuses = days.map((d) => d.reconciliation?.status).filter(Boolean);
    let reconciliationStatus = 'PASS';
    if (reconStatuses.includes('FAIL')) reconciliationStatus = 'FAIL';
    else if (reconStatuses.includes('OVERRIDE')) reconciliationStatus = 'OVERRIDE';
    else if (reconStatuses.includes('WARNING')) reconciliationStatus = 'WARNING';

    let blockedStatus = null;
    if (missingAllocProfile) blockedStatus = 'FREIGHT_ALLOC_PROFILE_MISSING';
    else if (missingRate) blockedStatus = 'FREIGHT_RATE_MISSING';

    return {
        ...ctx,
        period_end: windowEnd,
        costing_mode: costingMethod,
        costing_method: costingMethod,
        costing_method_meta: resolved,
        freight_allocated: (
            costingMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
            || costingMethod === COSTING_METHOD.LEGACY_FIXED_ALLOCATION
            || costingMethod === COSTING_METHOD.PERIOD_RATE
        ) && !softUnavailable,
        freight_memo_total: freightMemoTotal,
        daily_freight_allocation_total: dailyFreightAllocationTotal,
        expected_freight_total: freightMemoTotal,
        entered_freight_total: enteredFreightTotal,
        entered_freight_by_dept: enteredFreightByDept,
        base_purchases: baseTotals,
        base_purchases_total: basePurchasesTotal,
        freight_included: freightTotals,
        freight_included_total: freightIncludedTotal,
        landed_purchases: purchaseTotals,
        landed_purchases_total: roundMoney(Object.values(purchaseTotals).reduce((s, v) => s + v, 0)),
        period_freight_rate_percent: costingMethod === COSTING_METHOD.PERIOD_RATE && !missingRate
            ? (opts.ratePercent ?? days.find((d) => d.applied_freight_rate != null)?.applied_freight_rate ?? null)
            : null,
        reconciliation_status: blockedStatus || reconciliationStatus,
        missing_rate: missingRate,
        missing_alloc_profile: missingAllocProfile,
        freight_rate_status: missingRate ? 'FREIGHT_RATE_MISSING' : null,
        freight_alloc_profile_status: missingAllocProfile
            ? 'FREIGHT_ALLOC_PROFILE_MISSING'
            : allocProfileStatus,
        available: !softUnavailable,
        days,
        weekly_shrink: weeklyShrink,
        purchase_totals: purchaseTotals,
        purchase_total: roundMoney(Object.values(purchaseTotals).reduce((s, v) => s + v, 0)),
    };
}

function readMarginMeta(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    try {
        return db.get('SELECT * FROM receiving_report_margin WHERE period_start=?', start) || null;
    } catch (_) {
        return null;
    }
}

function saveMarginMeta(db, periodStart, payload = {}, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const now = new Date().toISOString();
    const existing = readMarginMeta(db, start);
    const num = payload.period_number ?? payload.periodNumber;
    if (num != null && num !== '') savePeriodNumber(db, num);

    const fields = {
        opening_inventory: payload.opening_inventory ?? payload.openingInventory,
        closing_inventory: payload.closing_inventory ?? payload.closingInventory,
        last_inventory: payload.last_inventory ?? payload.lastInventory,
        target_margin_pct: payload.target_margin_pct ?? payload.targetMarginPct,
        sms_margin_pct: payload.sms_margin_pct ?? payload.smsMarginPct,
        sales_before_count: payload.sales_before_count ?? payload.salesBeforeCount,
        sales_after_count: payload.sales_after_count ?? payload.salesAfterCount,
        sales_during_count: payload.sales_during_count ?? payload.salesDuringCount,
        count_time_hours: payload.count_time_hours ?? payload.countTimeHours,
        variance_explanation: payload.variance_explanation ?? payload.varianceExplanation,
        is_count_period: payload.is_count_period ?? payload.isCountPeriod,
    };
    // Only touch period_number when explicitly provided — otherwise keep this
    // period's stored number (do not stamp the global setting onto every row).
    if (num != null && num !== '') {
        fields.period_number = Math.floor(Number(num));
    }

    const pick = (key, fallback = null) => {
        const raw = fields[key];
        if (raw === undefined) return existing?.[key] ?? fallback;
        if (raw === '' || raw == null) return null;
        if (key.includes('pct')) {
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

    const pickFlag = (key, fallback = 0) => {
        const raw = fields[key];
        if (raw === undefined) return existing?.[key] != null ? Number(existing[key]) : fallback;
        return raw === true || raw === 1 || raw === '1' ? 1 : 0;
    };

    const next = {
        period_start: start,
        period_number: fields.period_number !== undefined
            ? fields.period_number
            : (existing?.period_number ?? readPeriodNumberSetting(db)),
        opening_inventory: pick('opening_inventory'),
        closing_inventory: pick('closing_inventory'),
        last_inventory: pick('last_inventory'),
        target_margin_pct: pick('target_margin_pct'),
        sms_margin_pct: pick('sms_margin_pct'),
        sales_before_count: pick('sales_before_count'),
        sales_after_count: pick('sales_after_count'),
        sales_during_count: pick('sales_during_count'),
        count_time_hours: pick('count_time_hours'),
        variance_explanation: String(fields.variance_explanation ?? existing?.variance_explanation ?? '').trim(),
        is_count_period: pickFlag('is_count_period', 0),
        updated_at: now,
        updated_by: actorName || '',
    };

    if (existing) {
        db.run(
            `UPDATE receiving_report_margin SET
                period_number=?, opening_inventory=?, closing_inventory=?, last_inventory=?,
                target_margin_pct=?, sms_margin_pct=?,
                sales_before_count=?, sales_after_count=?, sales_during_count=?, count_time_hours=?,
                variance_explanation=?, is_count_period=?, updated_at=?, updated_by=?
              WHERE period_start=?`,
            next.period_number,
            next.opening_inventory,
            next.closing_inventory,
            next.last_inventory,
            next.target_margin_pct,
            next.sms_margin_pct,
            next.sales_before_count,
            next.sales_after_count,
            next.sales_during_count,
            next.count_time_hours,
            next.variance_explanation,
            next.is_count_period,
            next.updated_at,
            next.updated_by,
            start,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_margin (
                period_start, period_number, opening_inventory, closing_inventory, last_inventory,
                target_margin_pct, sms_margin_pct, sales_before_count, sales_after_count,
                sales_during_count, count_time_hours, variance_explanation, is_count_period,
                updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            start,
            next.period_number,
            next.opening_inventory,
            next.closing_inventory,
            next.last_inventory,
            next.target_margin_pct,
            next.sms_margin_pct,
            next.sales_before_count,
            next.sales_after_count,
            next.sales_during_count,
            next.count_time_hours,
            next.variance_explanation,
            next.is_count_period,
            next.updated_at,
            next.updated_by,
        );
    }

    return buildMarginPayload(db, start);
}

function groceryShrinkForWeek(weeklyShrink, weekNum) {
    const week = weeklyShrink.find((w) => w.week_num === weekNum);
    if (!week) return 0;
    return roundMoney(
        GROCERY_MARGIN_SHRINK_BUCKETS.reduce((sum, key) => sum + Number(week.shrink[key] || 0), 0),
    );
}

function buildMarginPayload(db, periodStart, opts = {}) {
    const start = normalizeStoreDate(periodStart);
    const resolved = resolvePeriodCostingMethod(db, start);
    let costingMethod = normalizeCostingMethod(opts.costingMethod || opts.costingMode);
    if (!costingMethod) costingMethod = resolved.method;
    const ctx = resolvePeriodContext(db, start);
    let sales;
    let receiving;
    try {
        sales = buildSalesGrid(db, start);
        receiving = buildReceivingTotalsPayload(db, start, {
            costingMethod,
            ratePercent: opts.ratePercent,
            pctFractions: opts.pctFractions,
            requireFreightRate: opts.requireFreightRate,
            requireAllocProfile: opts.requireAllocProfile,
        });
    } catch (err) {
        return {
            ...ctx,
            costing_mode: costingMethod,
            costing_method: costingMethod,
            available: false,
            error: err.message || 'Margin calculation unavailable',
            reconciliation_status: 'UNAVAILABLE',
            missing_rate: err.code === 'FREIGHT_RATE_MISSING',
            missing_alloc_profile: err.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
        };
    }
    const meta = readMarginMeta(db, start) || {};

    const weeks = ctx.week_ends.map((weekEnding, idx) => {
        const weekNum = idx + 1;
        const salesAmount = roundMoney(sales.summary.grocery[weekNum] || 0);
        const shrinkAmount = groceryShrinkForWeek(receiving.weekly_shrink, weekNum);
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

    const opening = meta.opening_inventory == null ? null : roundMoney(meta.opening_inventory);
    const closing = meta.closing_inventory == null ? null : roundMoney(meta.closing_inventory);
    const pt = receiving.purchase_totals || {};
    const purchases = roundMoney(Number(pt.grocery || 0) + Number(pt.dairy || 0));
    const basePurchases = roundMoney(
        Number(receiving.base_purchases?.grocery || 0) + Number(receiving.base_purchases?.dairy || 0),
    );
    const freightIncluded = roundMoney(
        Number(receiving.freight_included?.grocery || 0) + Number(receiving.freight_included?.dairy || 0),
    );

    const inventoryComplete = opening != null && closing != null;
    const openVal = opening || 0;
    const closeVal = closing || 0;
    const goodsAvailable = inventoryComplete ? roundMoney(openVal + purchases) : null;
    const cogs = inventoryComplete ? roundMoney(openVal + purchases - closeVal) : null;
    const grossProfit = cogs == null ? null : roundMoney(totalSales - cogs);
    const grossMarginPct = (cogs == null || !totalSales) ? null : roundPct(grossProfit / totalSales);

    const smsMarginPct = meta.sms_margin_pct == null ? null : roundPct(meta.sms_margin_pct);
    const smsGp = (smsMarginPct == null) ? null : roundMoney(totalSales * smsMarginPct);
    const gpDiff = (grossProfit == null || smsGp == null) ? null : roundMoney(grossProfit - smsGp);
    const gpDiffPct = (grossMarginPct == null || smsMarginPct == null)
        ? null
        : roundPct(grossMarginPct - smsMarginPct);

    const shrinkAdjustedGp = grossProfit == null ? null : roundMoney(grossProfit + totalShrink);
    const shrinkAdjustedMarginPct = (shrinkAdjustedGp == null || !totalSales)
        ? null
        : roundPct(shrinkAdjustedGp / totalSales);
    const varianceGp = (grossProfit == null || shrinkAdjustedGp == null)
        ? null
        : roundMoney(grossProfit - shrinkAdjustedGp);
    const variancePct = (grossMarginPct == null || shrinkAdjustedMarginPct == null)
        ? null
        : roundPct(grossMarginPct - shrinkAdjustedMarginPct);

    const salesDuringCount = roundMoney(meta.sales_during_count || 0);
    const salesDuringHalf = roundMoney(salesDuringCount / 2);
    const salesBeforeCount = roundMoney(meta.sales_before_count || 0);
    const salesAfterCount = roundMoney(meta.sales_after_count || 0);
    const totalSalesSaturday = roundMoney(salesBeforeCount + salesAfterCount + salesDuringHalf);
    const salesAdjusted = roundMoney(totalSalesSaturday - salesDuringHalf);

    const missingRate = !!receiving.missing_rate;
    const missingAllocProfile = !!receiving.missing_alloc_profile;
    const softUnavailable = missingRate || missingAllocProfile;
    return {
        ...ctx,
        available: !softUnavailable,
        missing_rate: missingRate,
        missing_alloc_profile: missingAllocProfile,
        freight_rate_status: missingRate ? 'FREIGHT_RATE_MISSING' : null,
        freight_alloc_profile_status: receiving.freight_alloc_profile_status || null,
        costing_mode: costingMethod,
        costing_method: costingMethod,
        costing_method_meta: resolved,
        freight_allocated: (
            costingMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
            || costingMethod === COSTING_METHOD.LEGACY_FIXED_ALLOCATION
            || (costingMethod === COSTING_METHOD.PERIOD_RATE && !missingRate)
        ) && !softUnavailable,
        freight_memo_total: receiving.freight_memo_total || 0,
        daily_freight_allocation_total: receiving.daily_freight_allocation_total || 0,
        base_purchases_total: basePurchases,
        freight_included_total: freightIncluded,
        landed_purchases_total: purchases,
        period_freight_rate_percent: receiving.period_freight_rate_percent ?? null,
        reconciliation_status: receiving.reconciliation_status || 'PASS',
        meta: {
            period_number: meta.period_number ?? ctx.period_number,
            opening_inventory: meta.opening_inventory,
            closing_inventory: meta.closing_inventory,
            last_inventory: meta.last_inventory,
            target_margin_pct: meta.target_margin_pct,
            sms_margin_pct: meta.sms_margin_pct,
            sales_before_count: meta.sales_before_count,
            sales_after_count: meta.sales_after_count,
            sales_during_count: meta.sales_during_count,
            count_time_hours: meta.count_time_hours,
            variance_explanation: meta.variance_explanation || '',
            is_count_period: Number(meta.is_count_period) === 1,
            updated_at: meta.updated_at || null,
            updated_by: meta.updated_by || '',
        },
        weeks,
        totals: {
            sales: totalSales,
            shrink_dollars: totalShrink,
            shrink_pct: totalShrinkPct,
            purchases,
            base_purchases: basePurchases,
            freight_included: freightIncluded,
            goods_available: goodsAvailable,
            cogs,
            gross_profit: grossProfit,
            gross_margin_pct: grossMarginPct,
            sms_gp: smsGp,
            gp_diff: gpDiff,
            gp_diff_pct: gpDiffPct,
            shrink_adjusted_gp: shrinkAdjustedGp,
            shrink_adjusted_margin_pct: shrinkAdjustedMarginPct,
            variance_gp: varianceGp,
            variance_pct: variancePct,
            sales_before_count: salesBeforeCount,
            sales_after_count: salesAfterCount,
            sales_during_count: salesDuringCount,
            sales_during_half: salesDuringHalf,
            total_sales_saturday: totalSalesSaturday,
            sales_adjusted: salesAdjusted,
            inventory_should_be: cogs == null ? null : roundMoney(closeVal + cogs),
            inventory_current: closing,
            inventory_last: meta.last_inventory == null ? null : roundMoney(meta.last_inventory),
            inventory_diff: (closing == null || meta.last_inventory == null)
                ? null
                : roundMoney(closing - Number(meta.last_inventory || 0)),
            inventory_complete: inventoryComplete,
        },
        receiving_purchase_total: purchases,
    };
}

/**
 * Side-by-side period_department_allocation (authoritative) vs superseded period_rate
 * vs invoice estimate (reference) vs base-only diagnostic.
 */
function buildCostingComparisonPayload(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    const resolved = resolvePeriodCostingMethod(db, start);
    const primaryMethod = resolved.method === COSTING_METHOD.LEGACY_FIXED_ALLOCATION
        ? COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
        : (resolved.method || COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION);

    let periodRatePercent = null;
    try {
        periodRatePercent = resolveAppliedFreightRatePercent(db, start);
    } catch (_) {
        periodRatePercent = null;
    }

    let allocResolved = null;
    try {
        allocResolved = resolveAllocProfile(db, start);
    } catch (_) {
        allocResolved = null;
    }
    const missingAllocProfile = !allocResolved?.pct_fractions;

    const methods = [
        COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        COSTING_METHOD.PERIOD_RATE,
        COSTING_METHOD.INVOICE_FREIGHT,
        COSTING_METHOD.BASE_COST_ONLY,
    ];

    const modeSnaps = {};
    methods.forEach((method) => {
        try {
            if (method === COSTING_METHOD.PERIOD_RATE && periodRatePercent == null) {
                modeSnaps[method] = {
                    costing_mode: method,
                    costing_method: method,
                    available: false,
                    purchase_total: null,
                    grocery_dairy_purchases: null,
                    base_purchases: null,
                    freight_included: null,
                    landed_purchases: null,
                    freight_memo_total: null,
                    daily_freight_allocation_total: null,
                    cogs: null,
                    gross_profit: null,
                    gross_margin_pct: null,
                    sms_margin_pct: null,
                    gp_diff_vs_sms_pct: null,
                    reconciliation_status: null,
                    missing_rate: true,
                };
                return;
            }
            if (method === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION && missingAllocProfile) {
                modeSnaps[method] = {
                    costing_mode: method,
                    costing_method: method,
                    available: false,
                    purchase_total: null,
                    grocery_dairy_purchases: null,
                    base_purchases: null,
                    freight_included: null,
                    landed_purchases: null,
                    freight_memo_total: null,
                    daily_freight_allocation_total: null,
                    cogs: null,
                    gross_profit: null,
                    gross_margin_pct: null,
                    sms_margin_pct: null,
                    gp_diff_vs_sms_pct: null,
                    reconciliation_status: 'FREIGHT_ALLOC_PROFILE_MISSING',
                    missing_alloc_profile: true,
                };
                return;
            }
            const marginOpts = { costingMethod: method };
            if (method === COSTING_METHOD.PERIOD_RATE) marginOpts.ratePercent = periodRatePercent;
            if (method === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION) {
                marginOpts.pctFractions = allocResolved.pct_fractions;
            }
            const margin = buildMarginPayload(db, start, marginOpts);
            const receiving = buildReceivingTotalsPayload(db, start, marginOpts);
            modeSnaps[method] = {
                costing_mode: method,
                costing_method: method,
                available: margin.available !== false,
                purchase_total: receiving.purchase_total,
                grocery_dairy_purchases: margin.totals?.purchases ?? null,
                base_purchases: receiving.base_purchases_total,
                freight_included: receiving.freight_included_total,
                landed_purchases: receiving.landed_purchases_total,
                freight_memo_total: receiving.freight_memo_total,
                daily_freight_allocation_total: receiving.daily_freight_allocation_total,
                cogs: margin.totals?.cogs ?? null,
                gross_profit: margin.totals?.gross_profit ?? null,
                gross_margin_pct: margin.totals?.gross_margin_pct ?? null,
                sms_margin_pct: margin.meta?.sms_margin_pct ?? null,
                gp_diff_vs_sms_pct: margin.totals?.gp_diff_pct ?? null,
                reconciliation_status: receiving.reconciliation_status,
                missing_alloc_profile: !!receiving.missing_alloc_profile,
                missing_rate: !!receiving.missing_rate,
            };
        } catch (e) {
            modeSnaps[method] = {
                costing_mode: method,
                costing_method: method,
                available: false,
                purchase_total: null,
                grocery_dairy_purchases: null,
                base_purchases: null,
                freight_included: null,
                landed_purchases: null,
                missing_rate: e?.code === 'FREIGHT_RATE_MISSING',
                missing_alloc_profile: e?.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
                error: e?.message || 'unavailable',
            };
        }
    });

    const primary = modeSnaps[primaryMethod]
        || modeSnaps[COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION]
        || modeSnaps[COSTING_METHOD.BASE_COST_ONLY];
    const periodAlloc = modeSnaps[COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION];
    const periodRate = modeSnaps[COSTING_METHOD.PERIOD_RATE];
    const invoice = modeSnaps[COSTING_METHOD.INVOICE_FREIGHT];
    const baseOnly = modeSnaps[COSTING_METHOD.BASE_COST_ONLY];

    const diffFromPrimary = (snap) => {
        if (!snap || !primary || snap.available === false || primary.available === false) {
            return {
                purchase_total: null,
                grocery_dairy_purchases: null,
                cogs: null,
                gross_profit: null,
                gross_margin_pct: null,
                freight_included: null,
            };
        }
        return {
            purchase_total: (snap.purchase_total == null || primary.purchase_total == null)
                ? null
                : roundMoney(snap.purchase_total - primary.purchase_total),
            grocery_dairy_purchases: (snap.grocery_dairy_purchases == null || primary.grocery_dairy_purchases == null)
                ? null
                : roundMoney(snap.grocery_dairy_purchases - primary.grocery_dairy_purchases),
            cogs: (snap.cogs == null || primary.cogs == null) ? null : roundMoney(snap.cogs - primary.cogs),
            gross_profit: (snap.gross_profit == null || primary.gross_profit == null)
                ? null
                : roundMoney(snap.gross_profit - primary.gross_profit),
            gross_margin_pct: (snap.gross_margin_pct == null || primary.gross_margin_pct == null)
                ? null
                : roundPct(snap.gross_margin_pct - primary.gross_margin_pct),
            freight_included: (snap.freight_included == null || primary.freight_included == null)
                ? null
                : roundMoney(snap.freight_included - primary.freight_included),
        };
    };

    // Department variance — use real sales rollups (dairy / produce_dept / centre_store)
    const sales = buildSalesGrid(db, start);
    const safeRecv = (method, extra = {}) => {
        try {
            return buildReceivingTotalsPayload(db, start, {
                costingMethod: method,
                ...extra,
            });
        } catch (_) {
            return {
                freight_included: {},
                base_purchases: {},
                landed_purchases: {},
                entered_freight_by_dept: {},
                freight_memo_total: 0,
                daily_freight_allocation_total: 0,
            };
        }
    };
    const allocRecv = safeRecv(COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION, {
        ...(allocResolved?.pct_fractions ? { pctFractions: allocResolved.pct_fractions } : {}),
    });
    const periodRecv = periodRatePercent != null
        ? safeRecv(COSTING_METHOD.PERIOD_RATE, { ratePercent: periodRatePercent })
        : { freight_included: {}, landed_purchases: {} };
    const invRecv = safeRecv(COSTING_METHOD.INVOICE_FREIGHT);
    const baseOnlyRecv = safeRecv(COSTING_METHOD.BASE_COST_ONLY);
    const allocFreightMap = allocRecv.freight_included || {};
    const periodFreightMap = periodRecv.freight_included || {};
    const invEnteredMap = invRecv.entered_freight_by_dept || {};
    const baseMap = allocRecv.base_purchases || invRecv.base_purchases || {};
    const allocLandedMap = allocRecv.landed_purchases || {};
    const periodLandedMap = periodRecv.landed_purchases || {};
    const invLandedMap = invRecv.landed_purchases || {};
    const baseLandedMap = baseOnlyRecv.landed_purchases || {};

    const weekSum = (weeks) => {
        if (!weeks) return null;
        return roundMoney([1, 2, 3, 4, 5].reduce((s, w) => s + Number(weeks[w] || 0), 0));
    };
    const rollupWeeks = (key) => (sales.rollups || []).find((r) => r.key === key)?.weeks;
    const deptSalesFor = (key) => {
        if (key === 'dairy') return weekSum(rollupWeeks('dairy'));
        if (key === 'meat') return weekSum(rollupWeeks('meat')) ?? weekSum(sales.summary?.meat);
        if (key === 'produce') return weekSum(sales.summary?.produce_dept) ?? weekSum(rollupWeeks('produce'));
        if (key === 'tobacco') return weekSum(sales.summary?.tobacco) ?? weekSum(rollupWeeks('tobacco'));
        if (key === 'grocery') return weekSum(sales.summary?.centre_store);
        return null;
    };

    const deptKeys = ['grocery', 'meat', 'produce', 'dairy', 'tobacco', 'bakery', 'bakery_in_store', 'deli', 'pharmacy', 'produce_shrink'];
    const refinedDeptTable = deptKeys.map((key) => {
        const allocFreight = roundMoney(allocFreightMap[key] || 0);
        const periodFreight = roundMoney(periodFreightMap[key] || 0);
        const invFreight = roundMoney(invEnteredMap[key] || 0);
        const basePurch = roundMoney(baseMap[key] || 0);
        const allocLanded = roundMoney(allocLandedMap[key] || 0);
        const periodLanded = roundMoney(periodLandedMap[key] || 0);
        const invLanded = roundMoney(invLandedMap[key] || 0);
        const baseLanded = roundMoney(baseLandedMap[key] || 0);
        const freightVariance = roundMoney(periodFreight - allocFreight);
        const deptSales = deptSalesFor(key);
        const salesAvailable = deptSales != null;
        return {
            department: key,
            base_purchases: basePurch,
            period_allocated_freight: allocFreight,
            invoice_freight: invFreight,
            invoice_estimated_freight_reference: invFreight,
            superseded_period_rate_freight: periodFreight,
            legacy_freight: periodFreight,
            freight_variance: freightVariance,
            landed_period_department_allocation: allocLanded,
            landed_period_rate: periodLanded,
            landed_invoice_freight: invLanded,
            landed_base_cost_only: baseLanded,
            sales: salesAvailable ? deptSales : null,
            sales_available: salesAvailable,
            gp_effect: roundMoney(-freightVariance),
            margin_effect: (salesAvailable && deptSales)
                ? roundPct(-freightVariance / deptSales)
                : null,
            unavailable: !salesAvailable ? 'sales' : null,
        };
    });

    let actualBills = null;
    try {
        actualBills = db.get(
            'SELECT actual_freight_bills_total FROM receiving_report_period_status WHERE period_start=?',
            start,
        )?.actual_freight_bills_total;
    } catch (_) { /* optional */ }
    // Variance = actual bills − sum of daily freight allocation totals (N3), not purchases×rate.
    const allocatedDailyTotalsSum = allocRecv.daily_freight_allocation_total
        ?? allocRecv.freight_memo_total
        ?? periodAlloc?.daily_freight_allocation_total
        ?? periodAlloc?.freight_memo_total
        ?? 0;
    const validation = buildFreightValidationVariance({
        allocatedTotal: allocatedDailyTotalsSum,
        actualBillsTotal: actualBills,
    });

    return {
        period_start: start,
        primary_mode: primaryMethod,
        primary_method: primaryMethod,
        period_freight_rate_percent: periodRatePercent,
        alloc_profile_status: allocResolved?.status || 'missing',
        alloc_pct_map: allocResolved?.pctMap || null,
        missing_rate: periodRatePercent == null && primaryMethod === COSTING_METHOD.PERIOD_RATE,
        missing_alloc_profile: missingAllocProfile && primaryMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        freight_validation: validation,
        freight_validation_variance: validation,
        modes: {
            period_department_allocation: {
                id: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
                label: 'Period department allocation (N3 × dept %)',
                blurb: 'Daily Freight Allocation Total × Period Department Allocation % (authoritative landed cost).',
                role: 'primary',
                ...periodAlloc,
                difference_from_primary: diffFromPrimary(periodAlloc),
            },
            period_rate: {
                id: COSTING_METHOD.PERIOD_RATE,
                label: 'Superseded (purchases × rate)',
                blurb: 'Eligible merchandise × period freight rate% — superseded 5.4.15 comparison only.',
                role: periodRatePercent != null ? 'comparison' : 'unavailable',
                ...periodRate,
                difference_from_primary: diffFromPrimary(periodRate),
            },
            invoice_freight: {
                id: COSTING_METHOD.INVOICE_FREIGHT,
                label: 'Invoice Estimated Freight — Reference Only',
                blurb: 'Invoice freight_* estimates are reference-only — never included in landed/COGS/margin.',
                role: 'reference',
                ...invoice,
                difference_from_primary: diffFromPrimary(invoice),
            },
            base_cost_only: {
                id: COSTING_METHOD.BASE_COST_ONLY,
                label: 'Base cost only',
                blurb: 'Invoice $ only — freight excluded from purchases/COGS (diagnostic).',
                role: 'diagnostic',
                ...baseOnly,
                difference_from_primary: diffFromPrimary(baseOnly),
            },
            // Backward-compatible aliases
            legacy_fixed_allocation: {
                id: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
                label: 'Period department allocation (N3 × dept %)',
                ...periodAlloc,
                workbook_alloc_alias: true,
            },
            workbook_alloc: {
                id: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
                label: 'Period department allocation (N3 × dept %)',
                ...periodAlloc,
            },
            sms_landed: {
                id: COSTING_METHOD.BASE_COST_ONLY,
                label: 'Base cost only (diagnostic)',
                ...baseOnly,
            },
        },
        departments: refinedDeptTable,
        delta: {
            purchase_total: roundMoney((periodRate?.purchase_total || 0) - (periodAlloc?.purchase_total || 0)),
            grocery_dairy_purchases: roundMoney(
                (periodRate?.grocery_dairy_purchases || 0) - (periodAlloc?.grocery_dairy_purchases || 0),
            ),
            cogs: (periodRate?.cogs == null || periodAlloc?.cogs == null)
                ? null
                : roundMoney(periodRate.cogs - periodAlloc.cogs),
            gross_profit: (periodRate?.gross_profit == null || periodAlloc?.gross_profit == null)
                ? null
                : roundMoney(periodRate.gross_profit - periodAlloc.gross_profit),
            gross_margin_pct: (periodRate?.gross_margin_pct == null || periodAlloc?.gross_margin_pct == null)
                ? null
                : roundPct(periodRate.gross_margin_pct - periodAlloc.gross_margin_pct),
        },
        note: 'Daily Freight Allocation Total × Period Department Allocation % is authoritative. Invoice estimated freight is reference only. Freight bills validate variance against the sum of daily allocation totals — they never replace allocation. Purchases × rate is superseded comparison only.',
    };
}

function buildTotalReportPayload(db, anchorDate) {
    const start = resolvePeriodStart(db, anchorDate);
    const dates = listPeriodDates(start);
    let maxRows = 0;

    const columns = dates.map((date) => {
        let lines = [];
        try {
            lines = db.all(
                `SELECT invoice_number, line_kind, supplier_name
                   FROM receiving_report_lines
                  WHERE store_date=?
                  ORDER BY sort_order, invoice_number`,
                date,
            );
        } catch (_) {
            lines = [];
        }

        const invoices = [];
        lines.forEach((line) => {
            if (line.line_kind === 'spacer') return;
            const inv = String(line.invoice_number || '').trim();
            if (!inv || inv === ' ') return;
            invoices.push({
                invoice_number: inv,
                supplier_name: String(line.supplier_name || '').trim(),
            });
        });

        maxRows = Math.max(maxRows, invoices.length);
        const meta = resolveSheetMeta(date, start);
        return {
            store_date: date,
            week_num: meta.weekNum,
            day_of_week: meta.dayOfWeek,
            sheet_name: meta.sheetName,
            invoices,
        };
    });

    return {
        period_start: start,
        period_end: addDays(start, 34),
        columns,
        max_rows: maxRows,
        invoice_count: columns.reduce((sum, col) => sum + col.invoices.length, 0),
    };
}

function countLineWarnings(warningsByIndex) {
    return Object.values(warningsByIndex || {}).reduce(
        (sum, warnings) => sum + (Array.isArray(warnings) ? warnings.length : 0),
        0,
    );
}

function buildReceivingChecklistSummary(db, anchorDate, dayActivity) {
    const start = resolvePeriodStart(db, anchorDate);
    const end = addDays(start, 34);
    const { getStoreDateStamp } = createStoreTimeAccessors(() => db.getSettings());
    const storeToday = getStoreDateStamp();
    const periodEndPassed = storeToday >= end;

    let daysWithData = 0;
    let daysWithWarnings = 0;
    let lineWarningCount = 0;
    const warningDates = [];

    listPeriodDates(start).forEach((date) => {
        const lineCount = Number(dayActivity[date] || 0);
        if (lineCount <= 0) return;
        daysWithData += 1;
        const lines = listLines(db, date);
        const warnings = buildLineWarningsForDay(db, date, lines);
        const warningCount = countLineWarnings(warnings);
        if (warningCount > 0) {
            daysWithWarnings += 1;
            lineWarningCount += warningCount;
            warningDates.push(date);
        }
    });

    return {
        days_with_data: daysWithData,
        days_with_warnings: daysWithWarnings,
        line_warning_count: lineWarningCount,
        warning_dates: warningDates,
        period_end_passed: periodEndPassed,
        receiving_ready: periodEndPassed && daysWithWarnings === 0,
    };
}

function buildPeriodCloseReadiness(db, anchorDate) {
    const dashboard = buildPeriodDashboard(db, anchorDate);
    const start = resolvePeriodStart(db, anchorDate);
    const periodEnd = addDays(start, 34);
    const receivingChecklist = dashboard.receiving_checklist || {};
    const sales = dashboard.sales;
    const {
        computeDayFreightReconciliation,
        freightReconBlocksClose,
        unresolvedDuplicateGroups,
        isOverflowAcknowledged,
        dayContentFingerprint,
        PAGE_SIZE,
        dayLines,
    } = require('./edmonton-receiving-integrity.cjs');

    const checks = [];
    const addCheck = (id, pass, message, remediation, severity = 'error', extra = {}) => {
        checks.push({
            id,
            status: pass ? 'pass' : 'fail',
            severity: pass ? 'info' : severity,
            message,
            remediation: pass ? '' : remediation,
            ...extra,
        });
        return pass;
    };

    const { getStoreDateStamp } = createStoreTimeAccessors(() => db.getSettings());
    const today = normalizeStoreDate(getStoreDateStamp());
    let finalDayComplete = today > periodEnd;
    const finalDay = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', periodEnd);
    if (finalDay) {
        finalDayComplete = finalDayComplete
            || !!finalDay.eod_completed_at
            || !!finalDay.certified_at;
    }

    // Active receiving days include a day with an expected freight entry even
    // when its last invoice was deleted. Otherwise a deleted freight line could
    // make an unresolved expected amount disappear from close readiness.
    const activeDates = (db.all(
        `SELECT DISTINCT store_date FROM (
            SELECT store_date FROM receiving_report_lines
             WHERE store_date>=? AND store_date<=?
               AND COALESCE(NULLIF(TRIM(line_kind), ''), 'invoice')='invoice'
            UNION
            SELECT store_date FROM receiving_report_day
             WHERE store_date>=? AND store_date<=?
               AND freight_total IS NOT NULL
        ) ORDER BY store_date`,
        start, periodEnd, start, periodEnd,
    ) || []).map((r) => r.store_date);

    const uncertifiedDays = [];
    const freightFailures = [];
    const overflowFailures = [];
    const receivingWarnings = [];
    const duplicateGroups = unresolvedDuplicateGroups(db, start, periodEnd);
    const unresolvedDuplicateLineIds = new Set(
        duplicateGroups.flatMap((group) => group.lines.map((line) => String(line.line_id))),
    );

    activeDates.forEach((storeDate) => {
        const day = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', storeDate);
        const fingerprintMatches = !!day?.cert_content_fingerprint
            && day.cert_content_fingerprint === dayContentFingerprint(db, storeDate);
        if (!day?.certified_at || !fingerprintMatches) {
            uncertifiedDays.push({
                store_date: storeDate,
                reason: !day?.certified_at ? 'not_certified' : 'fingerprint_mismatch',
            });
        }

        // Live recompute — never trust stale freight_recon_status alone
        const recon = computeDayFreightReconciliation(db, storeDate, day);
        if (freightReconBlocksClose(recon)) freightFailures.push({
            store_date: storeDate,
            status: recon.status,
            expected: recon.expected,
            entered: recon.entered,
            difference: recon.difference,
        });

        const lines = dayLines(db, storeDate);
        if (lines.length > PAGE_SIZE && !isOverflowAcknowledged(day, lines.length)) {
            overflowFailures.push({ store_date: storeDate, line_count: lines.length });
        }
        const { buildLineWarningsForDay } = require('./edmonton-receiving-report.cjs');
        const warnings = buildLineWarningsForDay(db, storeDate, lines);
        const blockingWarningLineIds = Object.entries(warnings || {})
            .filter(([lineId, entries]) => (entries || []).some((warning) =>
                warning.type !== 'duplicate_invoice' || unresolvedDuplicateLineIds.has(String(lineId)),
            ))
            .map(([lineId]) => lineId);
        if (blockingWarningLineIds.length) {
            receivingWarnings.push({ store_date: storeDate, line_ids: blockingWarningLineIds });
        }
    });

    // Sales: blank ≠ zero. Every required category must have a durable value,
    // including an explicit saved 0, unless a manager explicitly confirmed the
    // remaining blanks for that exact week.
    let salesReady = true;
    const blankSales = [];
    const zeroConfirms = (() => {
        try {
            return new Set(
                (db.all(
                    `SELECT category_key || ':' || week_number AS k
                       FROM receiving_report_sales_zero_confirm
                      WHERE period_start=? AND confirmed_zero=1`,
                    start,
                ) || []).map((r) => r.k),
            );
        } catch (_) {
            return new Set();
        }
    })();
    const savedSalesCells = new Set(
        (db.all(
            `SELECT category_key || ':' || week_num AS k
               FROM receiving_report_sales WHERE period_start=?`,
            start,
        ) || []).map((r) => r.k),
    );
    const requiredSalesKeys = SALES_CATEGORIES.map((category) => category.key);
    for (let w = 1; w <= 5; w += 1) {
        const missingCategories = requiredSalesKeys.filter(
            (key) => !savedSalesCells.has(`${key}:${w}`),
        );
        const ok = missingCategories.length === 0 || zeroConfirms.has(`__week__:${w}`);
        if (!ok) {
            salesReady = false;
            blankSales.push({ week: w, reason: 'blank', category_keys: missingCategories });
        }
    }

    const marginMeta = dashboard.margin?.meta || {};
    const marginReady = marginMeta.opening_inventory != null && marginMeta.closing_inventory != null;
    const costingResolution = resolvePeriodCostingMethod(db, start);
    const costingMethod = costingResolution.method || '';
    const costingConfirmed = costingResolution.confirmed === true;
    const financialOk = dashboard.margin?.available !== false
        && dashboard.margin?.model_status !== 'UNAVAILABLE'
        && dashboard.margin?.error == null;

    const certifiedReady = addCheck(
        'active_days_certified', uncertifiedDays.length === 0,
        uncertifiedDays.length ? `${uncertifiedDays.length} active receiving day(s) are not certified.` : 'All active receiving days are certified.',
        'Complete day certification or document an approved exception.',
        'error', { days: uncertifiedDays },
    );
    const freightReady = addCheck(
        'freight_reconciled', freightFailures.length === 0,
        freightFailures.length
            ? `${freightFailures.length} day(s) have unresolved freight reconciliation.`
            : 'Freight reconciliation passed or was overridden.',
        'Reconcile freight or enter a manager override reason.',
        'error', { days: freightFailures },
    );
    const duplicatesReady = addCheck(
        'duplicate_invoices_resolved', duplicateGroups.length === 0,
        duplicateGroups.length
            ? 'Duplicate supplier and invoice references require manager acknowledgement.'
            : 'No unresolved duplicate supplier/invoice references.',
        'Acknowledge or correct duplicate invoice references.',
        'error', { duplicates: duplicateGroups.map((g) => ({ key: g.key, count: g.count, line_ids: g.lines.map((l) => l.line_id) })) },
    );
    const overflowReady = addCheck(
        'overflow_acknowledged', overflowFailures.length === 0,
        overflowFailures.length
            ? `${overflowFailures.length} day(s) with more than ${PAGE_SIZE} lines lack overflow review acknowledgement.`
            : 'Overflow days are acknowledged or within page size.',
        'Manager must acknowledge overflow review for each high-line-count day.',
        'error', { days: overflowFailures },
    );
    const warningsReady = addCheck(
        'receiving_warnings_resolved', receivingWarnings.length === 0,
        receivingWarnings.length
            ? `${receivingWarnings.length} receiving day(s) have unresolved line warnings.`
            : 'All receiving line warnings are resolved.',
        'Correct or document receiving line warnings before closing.',
        'error', { days: receivingWarnings },
    );
    addCheck('period_final_day_complete', finalDayComplete,
        finalDayComplete ? 'Final day is complete.' : 'Final day has not passed and has no EOD completion.',
        'Complete final-day EOD before closing.', 'error');
    addCheck('sales_confirmed', salesReady && blankSales.length === 0,
        (salesReady && blankSales.length === 0)
            ? 'Sales were entered or confirmed for all five weeks.'
            : 'Sales are incomplete; blank is not a confirmed zero.',
        'Enter sales or explicitly confirm zero for each week.',
        'error', { blank: blankSales });
    addCheck('inventories_complete', marginReady,
        marginReady ? 'Opening and closing inventory are entered.' : 'Opening and closing inventory are required.',
        'Enter Total Grocery opening and closing inventory.', 'error');
    addCheck('costing_method_confirmed', costingConfirmed,
        costingConfirmed ? `Costing method confirmed: ${costingMethod}.` : 'Costing method has not been manager-confirmed.',
        'Confirm the period costing method.', 'error');
    let freightAllocProfileReady = true;
    const normalizedCloseMethod = normalizeCostingMethod(costingMethod) || costingMethod;
    if (
        normalizedCloseMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
        || costingMethod === COSTING_METHOD.LEGACY_FIXED_ALLOCATION
    ) {
        try {
            requireConfirmedAllocProfile(db, start);
        } catch (e) {
            if (
                e?.code === 'FREIGHT_ALLOC_PROFILE_MISSING'
                || e?.code === 'FREIGHT_ALLOC_PROFILE_INVALID'
            ) {
                freightAllocProfileReady = false;
            } else {
                throw e;
            }
        }
    } else if (normalizedCloseMethod === COSTING_METHOD.PERIOD_RATE) {
        // Historical period_rate close path — still requires the old rate.
        try {
            resolveAppliedFreightRatePercent(db, start);
        } catch (e) {
            if (e?.code === 'FREIGHT_RATE_MISSING') freightAllocProfileReady = false;
            else throw e;
        }
    }
    addCheck('period_freight_alloc_profile_confirmed', freightAllocProfileReady,
        freightAllocProfileReady
            ? 'Period department allocation profile is confirmed (or not required for this costing method).'
            : 'Period department allocation profile is missing or not confirmed (FREIGHT_ALLOC_PROFILE_MISSING).',
        'Confirm the period department allocation profile (totals 100%) before confirming costing or closing.',
        'error');
    addCheck('financial_calculations_available', financialOk,
        financialOk ? 'Financial calculations are available.' : 'Financial calculations are unavailable or in an error state.',
        'Resolve margin/model errors before closing.', 'error');

    const blocking = checks.filter((c) => c.status === 'fail' && c.severity === 'error');
    const warnings = checks.filter((c) => c.status === 'fail' && c.severity === 'warning');
    const modelStatus = blocking.length
        ? 'FAIL'
        : (warnings.length ? 'WARNING' : 'PASS');
    const receivingReady = !!receivingChecklist.receiving_ready;

    return {
        receiving_ready: receivingReady && certifiedReady && freightReady && duplicatesReady && overflowReady && warningsReady && finalDayComplete,
        sales_ready: salesReady && blankSales.length === 0,
        margin_ready: marginReady,
        ready_to_close: blocking.length === 0,
        model_status: modelStatus,
        receiving_checklist: receivingChecklist,
        sales_weeks_filled: [1, 2, 3, 4, 5].filter((w) => {
            const complete = requiredSalesKeys.every((key) => savedSalesCells.has(`${key}:${w}`));
            return complete || zeroConfirms.has(`__week__:${w}`);
        }).length,
        period_start: start,
        period_end: periodEnd,
        checks,
        failed_checks: blocking,
        warning_checks: warnings,
    };
}

function assertPeriodCloseReady(db, anchorDateOrPeriodStart) {
    const start = resolvePeriodStart(db, anchorDateOrPeriodStart);
    const readiness = buildPeriodCloseReadiness(db, start);
    if (readiness.ready_to_close) return readiness;

    const missing = (readiness.failed_checks || [])
        .map((c) => c.id)
        .slice(0, 8);
    const err = new Error(
        `Period ${start} is not ready to close. Failed checks: ${missing.join(', ') || 'unknown'}.`,
    );
    err.status = 400;
    err.readiness = readiness;
    throw err;
}

function formatAvailablePeriodEntry(row) {
    const start = normalizeStoreDate(row.period_start);
    const end = addDays(start, 34);
    const num = row.period_number != null ? Number(row.period_number) : null;
    return {
        period_start: start,
        period_end: end,
        period_number: Number.isFinite(num) ? num : null,
        is_count_period: Number(row.is_count_period) === 1,
        label: Number.isFinite(num)
            ? `Period ${num}`
            : `Period · ${start}`,
    };
}

function listAvailablePeriods(db) {
    const byStart = new Map();

    const add = (start, patch = {}) => {
        if (!start) return;
        let normalized;
        try {
            normalized = normalizeStoreDate(start);
        } catch (_) {
            return;
        }
        const existing = byStart.get(normalized) || {
            period_start: normalized,
            period_number: null,
            is_count_period: false,
        };
        byStart.set(normalized, {
            ...existing,
            ...patch,
            period_start: normalized,
        });
    };

    try {
        db.all(
            `SELECT period_start, period_number, is_count_period
               FROM receiving_report_margin
              WHERE period_start IS NOT NULL AND trim(period_start) != ''`,
        ).forEach((row) => add(row.period_start, {
            period_number: row.period_number,
            is_count_period: Number(row.is_count_period) === 1,
        }));
    } catch (_) {}

    try {
        db.all(
            `SELECT DISTINCT period_start
               FROM receiving_report_sales
              WHERE period_start IS NOT NULL AND trim(period_start) != ''`,
        ).forEach((row) => add(row.period_start));
    } catch (_) {}

    try {
        db.all(
            `SELECT period_start
               FROM receiving_report_period_status
              WHERE period_start IS NOT NULL AND trim(period_start) != ''`,
        ).forEach((row) => add(row.period_start));
    } catch (_) {}

    try {
        const setting = db.get(
            'SELECT setting_value FROM settings WHERE setting_name=?',
            SETTING_PERIOD_START,
        );
        if (String(setting?.setting_value || '').trim()) {
            add(setting.setting_value);
        }
    } catch (_) {}

    return [...byStart.values()]
        .map((row) => formatAvailablePeriodEntry(row))
        .sort((a, b) => {
            if (a.period_number != null && b.period_number != null) {
                return a.period_number - b.period_number;
            }
            if (a.period_number != null) return -1;
            if (b.period_number != null) return 1;
            return a.period_start.localeCompare(b.period_start);
        });
}

function activateReceivingPeriod(db, payload = {}) {
    const periods = listAvailablePeriods(db);
    let start = null;
    const rawStart = payload.period_start || payload.periodStart;
    const rawNum = payload.period_number ?? payload.periodNumber;

    if (rawStart) {
        start = normalizeStoreDate(rawStart);
    } else if (rawNum != null && rawNum !== '') {
        const match = periods.find((p) => Number(p.period_number) === Number(rawNum));
        start = match?.period_start || null;
        if (!start) {
            try {
                const row = db.get(
                    `SELECT period_start FROM receiving_report_margin
                      WHERE period_number=?
                      ORDER BY period_start DESC
                      LIMIT 1`,
                    Number(rawNum),
                );
                start = row?.period_start || null;
            } catch (_) {
                start = null;
            }
        }
    }

    if (!start) {
        const err = new Error('Choose a known period (by number or period start date).');
        err.status = 400;
        throw err;
    }

    const known = periods.find((p) => p.period_start === start);
    const meta = readMarginMeta(db, start) || {};
    upsertSetting(db, SETTING_PERIOD_START, start);
    if (meta.period_number != null) savePeriodNumber(db, meta.period_number);

    return {
        period_start: start,
        operational_period_start: start,
        period_end: known?.period_end || addDays(start, 34),
        period_number: meta.period_number ?? known?.period_number ?? null,
        is_count_period: Number(meta.is_count_period) === 1,
        available_periods: listAvailablePeriods(db),
    };
}

function buildPeriodDashboard(db, anchorDate) {
    const start = resolvePeriodStart(db, anchorDate);
    const end = addDays(start, 34);
    const dayActivity = {};

    try {
        db.all(
            `SELECT store_date, COUNT(*) AS line_count
               FROM receiving_report_lines
              WHERE store_date >= ? AND store_date <= ?
              GROUP BY store_date`,
            start,
            end,
        ).forEach((row) => {
            dayActivity[row.store_date] = Number(row.line_count || 0);
        });
    } catch (_) {
        // receiving_report_lines may not exist yet
    }

    const availablePeriods = listAvailablePeriods(db);
    const activeMeta = readMarginMeta(db, start) || {};

    let receiving_totals;
    let margin;
    let costing_comparison;
    try {
        receiving_totals = buildReceivingTotalsPayload(db, start);
    } catch (e) {
        receiving_totals = {
            period_start: start,
            costing_method: resolvePeriodCostingMethod(db, start).method,
            available: false,
            error: e.message,
            missing_rate: e.code === 'FREIGHT_RATE_MISSING',
            missing_alloc_profile: e.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
            days: [],
            purchase_totals: {},
            purchase_total: 0,
        };
    }
    margin = buildMarginPayload(db, start);
    try {
        costing_comparison = buildCostingComparisonPayload(db, start);
    } catch (e) {
        costing_comparison = {
            period_start: start,
            primary_method: resolvePeriodCostingMethod(db, start).method,
            modes: {},
            error: e.message,
            missing_rate: e.code === 'FREIGHT_RATE_MISSING',
            missing_alloc_profile: e.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
        };
    }

    return {
        period_start: start,
        period_end: end,
        period_number: activeMeta.period_number ?? null,
        is_count_period: Number(activeMeta.is_count_period) === 1,
        available_periods: availablePeriods,
        day_activity: dayActivity,
        receiving_checklist: buildReceivingChecklistSummary(db, anchorDate, dayActivity),
        sales: buildSalesGrid(db, start),
        receiving_totals,
        margin,
        costing_comparison,
        total_report: buildTotalReportPayload(db, anchorDate),
    };
}

module.exports = {
    SETTING_PERIOD_NUMBER,
    SALES_CATEGORIES,
    ROLLUP_GROUPS,
    ROLLUP_LABELS,
    CENTRE_STORE_FEE_KEYS,
    COSTING_MODE,
    COSTING_METHOD,
    FREIGHT_ALLOC_PCT,
    allocateFreight,
    PURCHASE_FIELDS,
    SHRINK_BUCKETS,
    GROCERY_MARGIN_SHRINK_BUCKETS,
    resolvePeriodContext,
    listPeriodDates,
    buildSalesGrid,
    saveSalesAmount,
    saveSalesZeroConfirm,
    savePeriodNumber,
    buildReceivingTotalsPayload,
    readMarginMeta,
    saveMarginMeta,
    buildMarginPayload,
    buildCostingComparisonPayload,
    buildTotalReportPayload,
    buildPeriodDashboard,
    listAvailablePeriods,
    activateReceivingPeriod,
    buildReceivingChecklistSummary,
    buildPeriodCloseReadiness,
    assertPeriodCloseReady,
    aggregateDailyPurchases,
    resolvePeriodCostingMethod,
    setPeriodCostingMethod,
    computeItemLandedCost,
    roundMoney,
    roundPct,
};
