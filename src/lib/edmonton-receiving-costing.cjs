'use strict';

/**
 * Edmonton receiving costing — Pulse 5.4.16 workbook freight model.
 *
 * Authoritative: Department Allocated Freight =
 *   Daily Freight Allocation Total (N3 / day.freight_total)
 *   × Period Department Allocation %
 *
 * Purchases never change the freight allocation total.
 * Zero-% departments get $0 regardless of purchases.
 * produce_shrink is included in allocation (template 12.2%).
 *
 * period_rate (5.4.15 purchases × rate) is superseded — kept for historical/comparison only.
 */

const { roundMoney } = require('./parse-money.cjs');
const {
    ALLOC_DEPT_KEYS,
    requireConfirmedAllocProfile,
    ensurePeriodFreightAllocSchema,
} = require('./receiving-period-freight-alloc.cjs');

function normalizeStoreDate(value) {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const err = new Error(`Invalid store date: ${value}`);
    err.status = 400;
    throw err;
}

function periodEndDate(periodStart) {
    const start = normalizeStoreDate(periodStart);
    const [y, m, d] = start.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 34);
    return dt.toISOString().slice(0, 10);
}

/** True when value is null / undefined / '' (do not coerce to 0). */
function isNullishMoney(value) {
    return value === null || value === undefined || value === '';
}

/** Parse optional money/rate; returns null when missing or non-finite. Never Number(null)→0. */
function parseOptionalNumber(value) {
    if (isNullishMoney(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/** Purchase dept keys used in invoice / rebate lines (includes produce_shrink as a base bucket). */
const PURCHASE_FIELDS = [
    ['grocery', 'Grocery Purchases'],
    ['tobacco', 'Tobacco Purchases'],
    ['meat', 'Meat Purchases'],
    ['bakery', 'Bakery Purchases'],
    ['bakery_in_store', 'Bakery In Store'],
    ['deli', 'Deli Purchases'],
    ['produce', 'Produce Purchases'],
    ['produce_shrink', 'Produce Shrink'],
    ['dairy', 'Dairy Purchases'],
    ['pharmacy', 'Pharmacy Purchases'],
];

/**
 * Departments that receive freight under the superseded period_rate method
 * (never produce_shrink — eligible for purchases but no freight under that mistaken model).
 */
const FREIGHT_DEPT_KEYS = [
    'grocery',
    'tobacco',
    'meat',
    'bakery',
    'bakery_in_store',
    'deli',
    'produce',
    'dairy',
    'pharmacy',
];

const FREIGHT_COLUMN = Object.fromEntries(
    FREIGHT_DEPT_KEYS.map((key) => [key, `freight_${key}`]),
);

/**
 * Costing methods (persisted per period).
 * - period_department_allocation: AUTHORITATIVE — N3 × period department allocation %
 * - invoice_freight: reference comparison — invoice freight_* never enters landed/COGS
 * - period_rate: superseded 5.4.15 mistaken method — historical/comparison only
 * - legacy_fixed_allocation: alias → maps to PERIOD_DEPARTMENT_ALLOCATION in normalize
 * - base_cost_only: diagnostic — freight excluded from purchases/COGS
 *
 * Legacy aliases workbook_alloc / sms_landed map to the renamed methods.
 */
const COSTING_METHOD = {
    PERIOD_DEPARTMENT_ALLOCATION: 'period_department_allocation',
    INVOICE_FREIGHT: 'invoice_freight',
    PERIOD_RATE: 'period_rate',
    LEGACY_FIXED_ALLOCATION: 'legacy_fixed_allocation',
    BASE_COST_ONLY: 'base_cost_only',
};

/** @deprecated Use COSTING_METHOD — kept for callers during transition. */
const COSTING_MODE = {
    WORKBOOK_ALLOC: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
    SMS_LANDED: COSTING_METHOD.BASE_COST_ONLY,
    PERIOD_RATE: COSTING_METHOD.PERIOD_RATE,
    PERIOD_DEPARTMENT_ALLOCATION: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
    INVOICE_FREIGHT: COSTING_METHOD.INVOICE_FREIGHT,
    LEGACY_FIXED_ALLOCATION: COSTING_METHOD.LEGACY_FIXED_ALLOCATION,
    BASE_COST_ONLY: COSTING_METHOD.BASE_COST_ONLY,
};

/**
 * Template default allocation fractions (DEFAULT_ALLOC_PCT_POINTS / 100).
 * Used when no period profile fractions are supplied. Not "legacy only".
 * Must total 100%.
 */
const FREIGHT_ALLOC_PCT = {
    grocery: 0.478,
    tobacco: 0,
    meat: 0.099,
    bakery: 0,
    bakery_in_store: 0,
    deli: 0,
    produce: 0.159,
    produce_shrink: 0.122,
    dairy: 0.142,
    pharmacy: 0,
};

function assertLegacyFreightPctValid() {
    const sum = Object.values(FREIGHT_ALLOC_PCT).reduce((s, v) => s + Number(v || 0), 0);
    if (Math.abs(sum - 1) > 0.000001) {
        throw new Error(`FREIGHT_ALLOC_PCT must total 100% (got ${(sum * 100).toFixed(4)}%)`);
    }
}
assertLegacyFreightPctValid();

const DEFAULT_FREIGHT_TOLERANCE = 0.05;

function emptyPurchaseMap() {
    return Object.fromEntries(PURCHASE_FIELDS.map(([key]) => [key, 0]));
}

function emptyFreightMap() {
    return Object.fromEntries(FREIGHT_DEPT_KEYS.map((key) => [key, 0]));
}

/** Allocation freight map including produce_shrink (workbook model). */
function emptyAllocFreightMap() {
    return Object.fromEntries(ALLOC_DEPT_KEYS.map((key) => [key, 0]));
}

/**
 * Distribute a rounded department freight total across weights so shares sum exactly.
 * Uses largest-remainder on proportional shares.
 */
function distributeRoundedAmount(weights, total) {
    const target = roundMoney(Number(total) || 0);
    const n = weights.length;
    if (n === 0) return [];
    const weightSum = weights.reduce((s, w) => s + Number(w || 0), 0);
    if (weightSum === 0 || target === 0) return weights.map(() => 0);

    const raw = weights.map((w) => (Number(w || 0) / weightSum) * target);
    const floored = raw.map((v) => Math.floor(v * 100) / 100);
    let assigned = roundMoney(floored.reduce((s, v) => s + v, 0));
    let remainderCents = Math.round((target - assigned) * 100);
    const order = raw
        .map((v, i) => ({ i, frac: v - floored[i] }))
        .sort((a, b) => b.frac - a.frac);
    const out = floored.slice();
    let idx = 0;
    while (remainderCents !== 0 && n > 0) {
        const step = remainderCents > 0 ? 0.01 : -0.01;
        out[order[idx % n].i] = roundMoney(out[order[idx % n].i] + step);
        remainderCents += remainderCents > 0 ? -1 : 1;
        idx += 1;
        if (idx > n * 200) break;
    }
    return out.map((v) => roundMoney(v));
}

/**
 * Allocate daily freight total (N3) across departments by fraction weights.
 * Exact cent reconciliation via distributeRoundedAmount (e.g. $152.07 →
 * grocery 72.69, meat 15.06, produce 24.18, produce_shrink 18.55, dairy 21.59).
 *
 * @param {number|string|null|undefined} freightTotal
 * @param {Record<string, number>} [pctFractions] defaults to FREIGHT_ALLOC_PCT
 * @returns {Record<string, number>} purchase-field map; empty/zeros when incomplete or zero
 */
function allocateFreight(freightTotal, pctFractions) {
    if (isNullishMoney(freightTotal)) {
        return emptyPurchaseMap();
    }
    const total = Number(freightTotal);
    if (!Number.isFinite(total)) {
        return emptyPurchaseMap();
    }
    if (total === 0) {
        return emptyPurchaseMap();
    }

    const fractions = pctFractions && typeof pctFractions === 'object'
        ? pctFractions
        : FREIGHT_ALLOC_PCT;
    const keys = PURCHASE_FIELDS.map(([key]) => key);
    const weights = keys.map((key) => Number(fractions[key] || 0));
    const shares = distributeRoundedAmount(weights, total);
    const parts = emptyPurchaseMap();
    keys.forEach((key, i) => {
        parts[key] = shares[i];
    });
    return parts;
}

function normalizeCostingMethod(raw) {
    const value = String(raw || '').trim();
    if (
        value === 'workbook_alloc'
        || value === COSTING_METHOD.LEGACY_FIXED_ALLOCATION
        || value === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION
    ) {
        return COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION;
    }
    if (value === 'sms_landed' || value === COSTING_METHOD.BASE_COST_ONLY) {
        return COSTING_METHOD.BASE_COST_ONLY;
    }
    if (value === COSTING_METHOD.INVOICE_FREIGHT) {
        return COSTING_METHOD.INVOICE_FREIGHT;
    }
    if (value === COSTING_METHOD.PERIOD_RATE) {
        return COSTING_METHOD.PERIOD_RATE;
    }
    return null;
}

/** Alias used by older call sites. */
function normalizeCostingMode(mode) {
    return normalizeCostingMethod(mode) || COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION;
}

function isAuthoritativeCostingMethod(method) {
    return normalizeCostingMethod(method) === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION;
}

function readFreightTolerance(db) {
    try {
        const row = db.get(
            "SELECT setting_value FROM settings WHERE setting_name='Receiving_Freight_Tolerance'",
        );
        const raw = row?.setting_value;
        if (isNullishMoney(raw)) return DEFAULT_FREIGHT_TOLERANCE;
        const n = Number(raw);
        if (Number.isFinite(n) && n >= 0) return roundMoney(n);
    } catch (_) { /* optional */ }
    return DEFAULT_FREIGHT_TOLERANCE;
}

function lineFreightTotal(line) {
    return roundMoney(
        FREIGHT_DEPT_KEYS.reduce((sum, key) => sum + Number(line[FREIGHT_COLUMN[key]] || line[`freight_${key}`] || 0), 0),
    );
}

function lineBasePayable(line) {
    const depts = PURCHASE_FIELDS.reduce((sum, [key]) => sum + Number(line[key] || 0), 0);
    return roundMoney(depts + Number(line.gst || 0));
}

/**
 * Display/landed helper: prefer persisted allocated/landed; never add invoice freight_*.
 */
function lineLandedPurchases(line) {
    if (line && !isNullishMoney(line.landed_purchase_cost)) {
        const landed = Number(line.landed_purchase_cost);
        if (Number.isFinite(landed)) return roundMoney(landed);
    }
    const base = PURCHASE_FIELDS.reduce((sum, [key]) => sum + Number(line?.[key] || 0), 0);
    if (line && !isNullishMoney(line.allocated_freight)) {
        const alloc = Number(line.allocated_freight);
        if (Number.isFinite(alloc)) return roundMoney(base + alloc);
    }
    return roundMoney(base);
}

/**
 * Resolve persisted period costing method.
 * Open / new without method → period_department_allocation (authoritative).
 * Historical submitted/approved/locked/snapshotted without method → period_department_allocation
 *   (same math as old legacy N3×%).
 * Explicit period_rate persisted → period_rate (historical comparison only).
 * Explicit legacy_fixed_allocation → normalized to period_department_allocation.
 */
function resolvePeriodCostingMethod(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    let statusRow = null;
    try {
        statusRow = db.get(
            'SELECT status, costing_method, costing_method_reason, costing_method_selected_at, costing_method_selected_by FROM receiving_report_period_status WHERE period_start=?',
            start,
        );
    } catch (_) {
        statusRow = null;
    }

    const explicit = normalizeCostingMethod(statusRow?.costing_method);
    if (explicit) {
        const reason = String(statusRow.costing_method_reason || '').trim();
        const selectedAt = statusRow.costing_method_selected_at || null;
        const selectedBy = String(statusRow.costing_method_selected_by || '').trim();
        const confirmed = !!reason && !!selectedAt && !!selectedBy;
        return {
            method: explicit,
            source: confirmed ? 'explicit' : 'incomplete_persisted_selection',
            confirmed,
            reason,
            selected_at: selectedAt,
            selected_by: selectedBy,
            status: statusRow.status || 'open',
        };
    }

    const status = String(statusRow?.status || 'open');
    let hasSnapshot = false;
    try {
        hasSnapshot = !!db.get(
            'SELECT period_start FROM receiving_report_period_snapshots WHERE period_start=?',
            start,
        );
    } catch (_) {
        hasSnapshot = false;
    }

    if (hasSnapshot || ['submitted', 'approved', 'locked'].includes(status)) {
        return {
            method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            source: 'historical_default',
            confirmed: false,
            reason: 'historical_default',
            selected_at: null,
            selected_by: '',
            status,
        };
    }

    return {
        method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        source: 'new_period_default',
        confirmed: false,
        reason: '',
        selected_at: null,
        selected_by: '',
        status,
    };
}

/**
 * Confirm authoritative costing method for an operational period.
 * Only PERIOD_DEPARTMENT_ALLOCATION may be confirmed (period_rate is not confirmable).
 * Requires a confirmed department allocation profile, then snapshots day/dept/line freight.
 */
function setPeriodCostingMethod(db, periodStart, payload = {}, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const method = normalizeCostingMethod(payload.method || payload.costing_method);
    if (!method) {
        const err = new Error('Invalid costing method.');
        err.status = 400;
        throw err;
    }
    if (method !== COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION) {
        const err = new Error(
            'Only period_department_allocation may be confirmed for an operational period.',
        );
        err.status = 400;
        err.code = 'NON_AUTHORITATIVE_COSTING_METHOD';
        throw err;
    }
    const reason = String(payload.reason || payload.costing_method_reason || '').trim();
    if (!reason) {
        const err = new Error('A manager explanation is required to confirm the costing method.');
        err.status = 400;
        throw err;
    }

    const profile = requireConfirmedAllocProfile(db, start);
    const now = new Date().toISOString();
    const actor = String(actorName || payload.actor || '').trim();
    const audit = JSON.stringify({
        previous: null,
        method,
        reason,
        actor,
        at: now,
        alloc_pct_map: profile.pctMap,
        freight_calc_source: 'period_department_allocation',
    });

    const existing = db.get(
        'SELECT * FROM receiving_report_period_status WHERE period_start=?',
        start,
    );
    if (existing) {
        db.run(
            `UPDATE receiving_report_period_status
                SET costing_method=?, costing_method_reason=?, costing_method_selected_at=?,
                    costing_method_selected_by=?, costing_method_audit_json=?,
                    freight_rate_percent=NULL, freight_calc_source=?,
                    freight_alloc_profile_status=?,
                    updated_at=?, updated_by=?
              WHERE period_start=?`,
            method,
            reason,
            now,
            actor,
            audit,
            'period_department_allocation',
            'confirmed',
            now,
            actor,
            start,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_period_status (
                period_start, status, costing_method, costing_method_reason,
                costing_method_selected_at, costing_method_selected_by, costing_method_audit_json,
                freight_rate_percent, freight_calc_source, freight_alloc_profile_status,
                updated_at, updated_by
             ) VALUES (?, 'open', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
            start,
            method,
            reason,
            now,
            actor,
            audit,
            'period_department_allocation',
            'confirmed',
            now,
            actor,
        );
    }

    try {
        snapshotPeriodDayDeptFreight(db, start);
    } catch (_) { /* best-effort; period_status confirmation is authoritative */ }

    return resolvePeriodCostingMethod(db, start);
}

function throwFreightRateMissing(detail) {
    const err = new Error(detail || 'Period freight rate is missing (FREIGHT_RATE_MISSING).');
    err.status = 409;
    err.code = 'FREIGHT_RATE_MISSING';
    throw err;
}

/**
 * Build base / freight / landed purchase maps for a set of invoice lines + day freight memo.
 * @param {string} method
 * @param {{ pctFractions?: Record<string, number>, ratePercent?: number }} [opts]
 *   pctFractions — period_department_allocation profile fractions
 *   ratePercent — period_rate only (historical)
 */
function applyCostingToDay(lines, dayFreightTotal, method, opts = {}) {
    const resolvedMethod = normalizeCostingMethod(method) || String(method || '').trim();

    const base = emptyPurchaseMap();
    const freight = emptyFreightMap();
    let gst = 0;
    let basePayable = 0;

    (lines || []).forEach((line) => {
        const kind = String(line.line_kind || 'invoice').trim().toLowerCase() || 'invoice';
        if (kind !== 'invoice') return;
        PURCHASE_FIELDS.forEach(([key]) => {
            base[key] = roundMoney(base[key] + Number(line[key] || 0));
        });
        gst = roundMoney(gst + Number(line.gst || 0));
        // Invoice freight_* columns — reference only (never land into COGS under authoritative methods).
        FREIGHT_DEPT_KEYS.forEach((key) => {
            const col = FREIGHT_COLUMN[key];
            freight[key] = roundMoney(freight[key] + Number(line[col] || line[`freight_${key}`] || 0));
        });
        basePayable = roundMoney(basePayable + lineBasePayable(line));
    });

    const enteredFreight = roundMoney(
        FREIGHT_DEPT_KEYS.reduce((sum, key) => sum + Number(freight[key] || 0), 0),
    );

    const expectedFreightRaw = parseOptionalNumber(dayFreightTotal);
    const expectedFreight = expectedFreightRaw == null ? null : roundMoney(expectedFreightRaw);

    let freightIncluded = emptyAllocFreightMap();
    let purchases = { ...base };
    let appliedRatePercent = null;
    let dailyFreightIncomplete = false;
    let freightCalcSource = '';

    if (resolvedMethod === COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION) {
        freightCalcSource = 'period_department_allocation';
        if (expectedFreight == null) {
            // Incomplete day freight — never invent allocation from purchases.
            freightIncluded = emptyAllocFreightMap();
            purchases = { ...base };
            dailyFreightIncomplete = true;
        } else {
            const alloc = allocateFreight(expectedFreight, opts.pctFractions);
            ALLOC_DEPT_KEYS.forEach((key) => {
                const amt = roundMoney(alloc[key] || 0);
                freightIncluded[key] = amt;
                purchases[key] = roundMoney(Number(base[key] || 0) + amt);
            });
        }
    } else if (resolvedMethod === COSTING_METHOD.PERIOD_RATE) {
        // Superseded 5.4.15 path — preserved for historical comparison only.
        freightCalcSource = 'period_rate';
        const ratePercent = parseOptionalNumber(opts.ratePercent);
        if (ratePercent == null) {
            throwFreightRateMissing(
                'Period freight rate percent is required for period_rate costing (FREIGHT_RATE_MISSING).',
            );
        }
        appliedRatePercent = ratePercent;
        freightIncluded = emptyFreightMap();
        FREIGHT_DEPT_KEYS.forEach((key) => {
            const allocated = roundMoney(Number(base[key] || 0) * ratePercent / 100);
            freightIncluded[key] = allocated;
            purchases[key] = roundMoney(Number(base[key] || 0) + allocated);
        });
        // produce_shrink: eligible in base purchases but does NOT get freight under period_rate.
    } else if (resolvedMethod === COSTING_METHOD.INVOICE_FREIGHT) {
        // Non-authoritative / historical comparison: invoice freight is reference-only.
        freightIncluded = emptyFreightMap();
        purchases = { ...base };
    } else {
        // base_cost_only — purchases = base; freight is memo only
        freightIncluded = emptyFreightMap();
        purchases = { ...base };
    }

    const freightIncludedTotal = roundMoney(
        Object.values(freightIncluded).reduce((s, v) => s + Number(v || 0), 0),
    );
    const landedPurchases = { ...purchases };
    const landedTotal = roundMoney(
        Object.values(landedPurchases).reduce((s, v) => s + Number(v || 0), 0),
    );
    const basePurchasesTotal = roundMoney(
        Object.values(base).reduce((s, v) => s + Number(v || 0), 0),
    );

    const result = {
        base_purchases: base,
        base_purchases_total: basePurchasesTotal,
        gst,
        base_payable: basePayable,
        entered_freight_by_dept: freight,
        entered_freight_total: enteredFreight,
        expected_freight: expectedFreight,
        freight_included: freightIncluded,
        freight_included_total: freightIncludedTotal,
        landed_purchases: landedPurchases,
        landed_purchases_total: landedTotal,
        purchases: landedPurchases,
        applied_freight_rate: appliedRatePercent,
        freight_calc_source: freightCalcSource,
    };
    if (dailyFreightIncomplete) {
        result.daily_freight_incomplete = true;
    }
    return result;
}

/**
 * Day freight reconciliation (invoice-estimated vs expected day memo / N3).
 * Reference-only under authoritative allocation — does not drive landed cost.
 */
function reconcileDayFreight({ expected, entered, tolerance = DEFAULT_FREIGHT_TOLERANCE, override = false }) {
    const exp = isNullishMoney(expected) ? null : roundMoney(Number(expected));
    const entRaw = parseOptionalNumber(entered);
    const ent = entRaw == null ? 0 : roundMoney(entRaw);
    const tol = Number.isFinite(Number(tolerance)) ? Number(tolerance) : DEFAULT_FREIGHT_TOLERANCE;

    if (exp == null) {
        return {
            status: override ? 'OVERRIDE' : 'WARNING',
            expected: null,
            entered: ent,
            difference: ent,
            tolerance: tol,
            message: 'Expected invoice freight not entered (null is incomplete, not zero).',
            blocks_close: !override,
        };
    }

    const difference = roundMoney(ent - exp);
    const absDiff = Math.abs(difference);
    if (absDiff <= tol) {
        return {
            status: 'PASS',
            expected: exp,
            entered: ent,
            difference,
            tolerance: tol,
            blocks_close: false,
        };
    }
    if (override) {
        return {
            status: 'OVERRIDE',
            expected: exp,
            entered: ent,
            difference,
            tolerance: tol,
            blocks_close: false,
        };
    }
    const status = absDiff <= tol * 10 ? 'WARNING' : 'FAIL';
    return {
        status,
        expected: exp,
        entered: ent,
        difference,
        tolerance: tol,
        blocks_close: true,
    };
}

/** True when status blocks certification / period close without a valid override. */
function freightReconBlocksClose(reconciliation) {
    if (!reconciliation) return true;
    if (reconciliation.blocks_close === false) return false;
    if (reconciliation.blocks_close === true) return true;
    const status = String(reconciliation.status || '').toUpperCase();
    return status !== 'PASS' && status !== 'OVERRIDE';
}

/** Eligible merchandise for a line (all purchase columns; excludes GST / invoice freight). */
function lineEligibleMerchandise(line) {
    return roundMoney(
        PURCHASE_FIELDS.reduce((sum, [key]) => sum + Number(line?.[key] || 0), 0),
    );
}

/** Merchandise that receives period_rate freight (excludes produce_shrink, GST, invoice freight). */
function lineFreightEligibleMerchandise(line) {
    return roundMoney(
        FREIGHT_DEPT_KEYS.reduce((sum, key) => sum + Number(line?.[key] || 0), 0),
    );
}

/**
 * Persist invoice-level period_rate freight snapshots for a day (historical / comparison).
 * Signature (db, date, ratePercent) kept for compatibility.
 * No-op when rate is missing — never invents 0%.
 */
function snapshotDayLinePeriodFreight(db, storeDate, ratePercent) {
    const date = normalizeStoreDate(storeDate);
    const rate = parseOptionalNumber(ratePercent);
    if (rate == null) return { updated: 0, missing_rate: true };

    let lines = [];
    try {
        lines = db.all(
            `SELECT * FROM receiving_report_lines
              WHERE store_date=?
                AND COALESCE(NULLIF(TRIM(line_kind), ''), 'invoice') = 'invoice'
              ORDER BY sort_order ASC, created_at ASC`,
            date,
        ) || [];
    } catch (_) {
        return { updated: 0, error: 'lines_unavailable' };
    }
    if (!lines.length) return { updated: 0 };

    const allocatedByLine = lines.map(() => 0);
    FREIGHT_DEPT_KEYS.forEach((dept) => {
        const weights = lines.map((line) => Number(line[dept] || 0));
        const eligibleDept = roundMoney(weights.reduce((s, w) => s + w, 0));
        const official = roundMoney(eligibleDept * rate / 100);
        const shares = distributeRoundedAmount(weights, official);
        shares.forEach((share, i) => {
            allocatedByLine[i] = roundMoney(allocatedByLine[i] + share);
        });
    });

    let updated = 0;
    lines.forEach((line, i) => {
        const eligible = lineEligibleMerchandise(line);
        const allocated = allocatedByLine[i];
        const landed = roundMoney(eligible + allocated);
        try {
            db.run(
                `UPDATE receiving_report_lines
                    SET applied_freight_rate=?, allocated_freight=?, eligible_merchandise=?,
                        landed_purchase_cost=?, freight_calc_source=?
                  WHERE line_id=?`,
                rate,
                allocated,
                eligible,
                landed,
                'period_rate',
                line.line_id,
            );
            updated += 1;
        } catch (_) { /* columns may be missing pre-063 */ }
    });
    return { updated, rate_percent: rate };
}

/**
 * Authoritative day snapshot: allocate N3 by department fractions, write day_freight_alloc
 * rows, and distribute dept totals onto invoice lines.
 *
 * @param {*} db
 * @param {string} storeDate
 * @param {Record<string, number>} pctFractions — fractions (e.g. 0.478), not percent points
 * @param {number|string|null} dailyFreightTotal — day.freight_total (N3)
 */
function snapshotDayDeptAllocation(db, storeDate, pctFractions, dailyFreightTotal) {
    const date = normalizeStoreDate(storeDate);
    ensurePeriodFreightAllocSchema(db);

    if (isNullishMoney(dailyFreightTotal)) {
        return { updated: 0, incomplete: true, store_date: date };
    }
    const freightTotal = parseOptionalNumber(dailyFreightTotal);
    if (freightTotal == null) {
        return { updated: 0, incomplete: true, store_date: date };
    }

    const alloc = allocateFreight(freightTotal, pctFractions);
    const now = new Date().toISOString();

    ALLOC_DEPT_KEYS.forEach((dept) => {
        const amount = roundMoney(alloc[dept] || 0);
        try {
            db.run(
                `INSERT INTO receiving_report_day_freight_alloc (
                    store_date, department, allocated_amount, daily_freight_total,
                    profile_period_start, calc_source, updated_at
                 ) VALUES (?, ?, ?, ?, NULL, ?, ?)
                 ON CONFLICT(store_date, department) DO UPDATE SET
                    allocated_amount=excluded.allocated_amount,
                    daily_freight_total=excluded.daily_freight_total,
                    calc_source=excluded.calc_source,
                    updated_at=excluded.updated_at`,
                date,
                dept,
                amount,
                freightTotal,
                'period_department_allocation',
                now,
            );
        } catch (_) {
            try {
                db.run(
                    `UPDATE receiving_report_day_freight_alloc
                        SET allocated_amount=?, daily_freight_total=?, calc_source=?, updated_at=?
                      WHERE store_date=? AND department=?`,
                    amount,
                    freightTotal,
                    'period_department_allocation',
                    now,
                    date,
                    dept,
                );
            } catch (__) { /* table may be unavailable */ }
        }
    });

    let lines = [];
    try {
        lines = db.all(
            `SELECT * FROM receiving_report_lines
              WHERE store_date=?
                AND COALESCE(NULLIF(TRIM(line_kind), ''), 'invoice') = 'invoice'
              ORDER BY sort_order ASC, created_at ASC`,
            date,
        ) || [];
    } catch (_) {
        return {
            updated: 0,
            freight_total: freightTotal,
            store_date: date,
            error: 'lines_unavailable',
        };
    }

    if (!lines.length) {
        return { updated: 0, freight_total: freightTotal, store_date: date, days_alloc_written: true };
    }

    const allocatedByLine = lines.map(() => 0);
    ALLOC_DEPT_KEYS.forEach((dept) => {
        const official = roundMoney(alloc[dept] || 0);
        const weights = lines.map((line) => Number(line[dept] || 0));
        const shares = distributeRoundedAmount(weights, official);
        shares.forEach((share, i) => {
            allocatedByLine[i] = roundMoney(allocatedByLine[i] + share);
        });
    });

    let updated = 0;
    lines.forEach((line, i) => {
        const eligible = lineEligibleMerchandise(line);
        const allocated = allocatedByLine[i];
        const landed = roundMoney(eligible + allocated);
        try {
            db.run(
                `UPDATE receiving_report_lines
                    SET applied_freight_rate=NULL, allocated_freight=?, eligible_merchandise=?,
                        landed_purchase_cost=?, freight_calc_source=?
                  WHERE line_id=?`,
                allocated,
                eligible,
                landed,
                'period_department_allocation',
                line.line_id,
            );
            updated += 1;
        } catch (_) { /* columns may be missing */ }
    });

    return {
        updated,
        freight_total: freightTotal,
        store_date: date,
        alloc,
    };
}

/**
 * Snapshot every day in an accounting period that has freight_total (N3),
 * using the confirmed department allocation profile.
 */
function snapshotPeriodDayDeptFreight(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    const profile = requireConfirmedAllocProfile(db, start);
    const pctFractions = profile.pct_fractions;
    ensurePeriodFreightAllocSchema(db);
    const end = periodEndDate(start);

    let days = [];
    try {
        days = db.all(
            `SELECT store_date, freight_total FROM receiving_report_day
              WHERE store_date >= ? AND store_date <= ?
                AND freight_total IS NOT NULL
              ORDER BY store_date`,
            start,
            end,
        ) || [];
    } catch (_) {
        days = [];
    }

    let updated = 0;
    days.forEach((day) => {
        // Stamp profile period on day alloc rows after allocation write.
        const result = snapshotDayDeptAllocation(db, day.store_date, pctFractions, day.freight_total);
        updated += Number(result.updated || 0);
        try {
            db.run(
                `UPDATE receiving_report_day_freight_alloc
                    SET profile_period_start=?
                  WHERE store_date=?`,
                start,
                day.store_date,
            );
        } catch (_) { /* optional */ }
    });

    return {
        updated,
        days: days.length,
        method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
    };
}

/**
 * Snapshot every invoice day in an accounting period using the applied period rate
 * (historical period_rate path only).
 */
function snapshotPeriodLineFreight(db, periodStart, ratePercent) {
    const start = normalizeStoreDate(periodStart);
    const end = periodEndDate(start);
    const rate = parseOptionalNumber(ratePercent);
    if (rate == null) return { updated: 0, days: 0, missing_rate: true };

    let dates = [];
    try {
        dates = (db.all(
            `SELECT DISTINCT store_date AS store_date FROM receiving_report_lines
              WHERE store_date >= ? AND store_date <= ?
              ORDER BY store_date`,
            start,
            end,
        ) || []).map((r) => r.store_date);
    } catch (_) {
        dates = [];
    }
    let updated = 0;
    dates.forEach((date) => {
        updated += Number(snapshotDayLinePeriodFreight(db, date, rate).updated || 0);
    });
    return { updated, days: dates.length, rate_percent: rate };
}

/**
 * Item landed cost via superseded period freight rate (historical / comparison).
 * estimatedFreight remains a reference field only — never added to landed.
 * @param {{ baseCost: number, estimatedFreight?: number, gst?: number, ratePercent: number }} args
 */
function computeItemLandedCost({ baseCost, estimatedFreight, gst = 0, ratePercent }) {
    const base = roundMoney(Number(baseCost) || 0);
    const freightEst = isNullishMoney(estimatedFreight)
        ? 0
        : roundMoney(Number(estimatedFreight) || 0);
    const gstAmt = roundMoney(Number(gst) || 0);
    const rate = parseOptionalNumber(ratePercent);
    if (rate == null) {
        throwFreightRateMissing(
            'ratePercent is required for computeItemLandedCost (FREIGHT_RATE_MISSING).',
        );
    }
    const allocated = roundMoney(base * rate / 100);
    return {
        base_cost: base,
        estimated_freight: freightEst,
        allocated_freight: allocated,
        applied_freight_rate: rate,
        landed_cost: roundMoney(base + allocated),
        invoice_payable: roundMoney(base + gstAmt),
    };
}

/**
 * Validation-only variance: actual freight bills vs sum of daily freight allocation totals (N3s).
 * Parameter `allocatedTotal` is the sum of day.freight_total values for the period —
 * NOT purchases × rate. SMS / freight bills never replace allocation.
 */
function buildFreightValidationVariance({ allocatedTotal, actualBillsTotal }) {
    // allocatedTotal = sum of allocated daily N3 totals (allocatedDailyTotalsSum)
    const allocatedRaw = parseOptionalNumber(allocatedTotal);
    const allocated = allocatedRaw == null ? 0 : roundMoney(allocatedRaw);
    const actualRaw = parseOptionalNumber(actualBillsTotal);
    const incomplete = actualRaw == null;
    const actual = incomplete ? null : roundMoney(actualRaw);
    const variance = incomplete ? null : roundMoney(actual - allocated);
    const pctVariance = incomplete || allocated === 0
        ? null
        : roundMoney((variance / allocated) * 100);
    return {
        allocated,
        actual,
        variance,
        pct_variance: pctVariance,
        incomplete_coverage: incomplete,
    };
}

module.exports = {
    PURCHASE_FIELDS,
    FREIGHT_DEPT_KEYS,
    ALLOC_DEPT_KEYS,
    FREIGHT_COLUMN,
    COSTING_METHOD,
    COSTING_MODE,
    FREIGHT_ALLOC_PCT,
    DEFAULT_FREIGHT_TOLERANCE,
    assertLegacyFreightPctValid,
    allocateFreight,
    normalizeCostingMethod,
    normalizeCostingMode,
    isAuthoritativeCostingMethod,
    emptyPurchaseMap,
    emptyFreightMap,
    emptyAllocFreightMap,
    readFreightTolerance,
    lineFreightTotal,
    lineBasePayable,
    lineLandedPurchases,
    lineEligibleMerchandise,
    lineFreightEligibleMerchandise,
    distributeRoundedAmount,
    snapshotDayLinePeriodFreight,
    snapshotDayDeptAllocation,
    snapshotPeriodDayDeptFreight,
    snapshotPeriodLineFreight,
    resolvePeriodCostingMethod,
    setPeriodCostingMethod,
    applyCostingToDay,
    reconcileDayFreight,
    freightReconBlocksClose,
    computeItemLandedCost,
    buildFreightValidationVariance,
};
