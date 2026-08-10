'use strict';

/**
 * Period freight rate registry — superseded / non-authoritative audit table (5.4.16).
 * Historical period_rate comparison and import round-trip only; authoritative landed cost
 * uses period_department_allocation (Daily Freight Allocation Total × dept %).
 * Store-wide rate uses department '' (empty string).
 */

function normalizePeriodStart(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const err = new Error(`Invalid period_start: ${value}`);
        err.status = 400;
        throw err;
    }
    return text;
}

function normalizeDepartment(value) {
    return String(value == null ? '' : value).trim();
}

function columns(db, table) {
    return new Set((db.all(`PRAGMA table_info(${table})`) || []).map((row) => row.name));
}

function tableExists(db, table) {
    const row = db.get(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        table,
    );
    return !!row;
}

function addColumn(db, table, name, ddl) {
    // Upgrade fixtures may not have receiving tables yet — skip, do not ALTER missing tables.
    if (!tableExists(db, table)) return;
    if (!columns(db, table).has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
}

/**
 * Ensure receiving_period_freight_rates + related period_status / line columns exist.
 * Safe to call from migration and from runtime helpers.
 */
function ensurePeriodFreightRatesSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS receiving_period_freight_rates (
            id INTEGER PRIMARY KEY,
            period_start TEXT NOT NULL,
            department TEXT NOT NULL DEFAULT '',
            rate_percent REAL NOT NULL,
            effective_start TEXT,
            effective_end TEXT,
            created_at TEXT,
            updated_at TEXT,
            created_by TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT '',
            UNIQUE(period_start, department)
        );
    `);

    addColumn(db, 'receiving_report_period_status', 'actual_freight_bills_total', 'actual_freight_bills_total REAL');
    addColumn(db, 'receiving_report_period_status', 'freight_rate_percent', 'freight_rate_percent REAL');
    addColumn(db, 'receiving_report_period_status', 'freight_calc_source', "freight_calc_source TEXT DEFAULT ''");

    addColumn(db, 'receiving_report_lines', 'applied_freight_rate', 'applied_freight_rate REAL');
    addColumn(db, 'receiving_report_lines', 'allocated_freight', 'allocated_freight REAL DEFAULT 0');
    addColumn(db, 'receiving_report_lines', 'eligible_merchandise', 'eligible_merchandise REAL');
    addColumn(db, 'receiving_report_lines', 'landed_purchase_cost', 'landed_purchase_cost REAL');
    addColumn(db, 'receiving_report_lines', 'freight_calc_source', "freight_calc_source TEXT DEFAULT ''");
}

/**
 * @returns {{ period_start: string, department: string, rate_percent: number, ... } | null}
 */
function getPeriodFreightRate(db, periodStart, department = '') {
    const start = normalizePeriodStart(periodStart);
    const dept = normalizeDepartment(department);
    try {
        ensurePeriodFreightRatesSchema(db);
        const row = db.get(
            `SELECT * FROM receiving_period_freight_rates
              WHERE period_start=? AND department=?`,
            start,
            dept,
        );
        return row || null;
    } catch (_) {
        return null;
    }
}

/**
 * Upsert store-wide or department-scoped period freight rate.
 * @param {{ period_start: string, department?: string, rate_percent: number, actor?: string, effective_start?: string, effective_end?: string }} payload
 */
function upsertPeriodFreightRate(db, payload = {}) {
    ensurePeriodFreightRatesSchema(db);
    const start = normalizePeriodStart(payload.period_start || payload.periodStart);
    const dept = normalizeDepartment(payload.department);
    const rawRate = payload.rate_percent ?? payload.ratePercent;
    if (
        rawRate === null
        || rawRate === undefined
        || (typeof rawRate === 'string' && rawRate.trim() === '')
    ) {
        const err = new Error('rate_percent must be a finite number.');
        err.status = 400;
        err.code = 'INVALID_FREIGHT_RATE';
        throw err;
    }
    const rate = Number(typeof rawRate === 'string' ? rawRate.trim() : rawRate);
    if (!Number.isFinite(rate)) {
        const err = new Error('rate_percent must be a finite number.');
        err.status = 400;
        err.code = 'INVALID_FREIGHT_RATE';
        throw err;
    }
    const actor = String(payload.actor || payload.updated_by || '').trim();
    const now = new Date().toISOString();
    const effectiveStart = payload.effective_start || payload.effectiveStart || null;
    const effectiveEnd = payload.effective_end || payload.effectiveEnd || null;

    const existing = getPeriodFreightRate(db, start, dept);
    if (existing) {
        db.run(
            `UPDATE receiving_period_freight_rates
                SET rate_percent=?, effective_start=?, effective_end=?,
                    updated_at=?, updated_by=?
              WHERE period_start=? AND department=?`,
            rate,
            effectiveStart,
            effectiveEnd,
            now,
            actor,
            start,
            dept,
        );
    } else {
        db.run(
            `INSERT INTO receiving_period_freight_rates (
                period_start, department, rate_percent, effective_start, effective_end,
                created_at, updated_at, created_by, updated_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            start,
            dept,
            rate,
            effectiveStart,
            effectiveEnd,
            now,
            now,
            actor,
            actor,
        );
    }
    return getPeriodFreightRate(db, start, dept);
}

/**
 * Require a store-wide period freight rate. Throws 409 FREIGHT_RATE_MISSING if none.
 */
function requirePeriodFreightRate(db, periodStart) {
    const row = getPeriodFreightRate(db, periodStart, '');
    if (!row || !Number.isFinite(Number(row.rate_percent))) {
        const err = new Error(
            `Period freight rate is missing for ${normalizePeriodStart(periodStart)}. Configure the period rate before landing costs.`,
        );
        err.status = 409;
        err.code = 'FREIGHT_RATE_MISSING';
        throw err;
    }
    return row;
}

/**
 * Resolve the rate percent to apply for a period.
 * Prefer snapshotted freight_rate_percent on period_status (immutable for prior periods).
 * Fall back to the live rates table via requirePeriodFreightRate.
 */
function resolveAppliedFreightRatePercent(db, periodStart) {
    const start = normalizePeriodStart(periodStart);
    try {
        const status = db.get(
            `SELECT freight_rate_percent, freight_calc_source, costing_method
               FROM receiving_report_period_status WHERE period_start=?`,
            start,
        );
        const raw = status?.freight_rate_percent;
        if (raw === null || raw === undefined || raw === '') {
            // fall through to requirePeriodFreightRate
        } else {
            const snap = Number(raw);
            if (Number.isFinite(snap)) return snap;
        }
    } catch (_) { /* optional columns */ }
    return Number(requirePeriodFreightRate(db, start).rate_percent);
}

/**
 * Persist optional actual freight bills total for validation variance only.
 */
function setActualFreightBillsTotal(db, periodStart, actualTotal, actor = '') {
    ensurePeriodFreightRatesSchema(db);
    const start = normalizePeriodStart(periodStart);
    const actual = actualTotal == null || actualTotal === ''
        ? null
        : Number(actualTotal);
    if (actual != null && !Number.isFinite(actual)) {
        const err = new Error('actual_freight_bills_total must be a finite number or null.');
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    const by = String(actor || '').trim();
    const existing = db.get(
        'SELECT period_start FROM receiving_report_period_status WHERE period_start=?',
        start,
    );
    if (existing) {
        db.run(
            `UPDATE receiving_report_period_status
                SET actual_freight_bills_total=?, updated_at=?, updated_by=?
              WHERE period_start=?`,
            actual,
            now,
            by,
            start,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_period_status (
                period_start, status, actual_freight_bills_total, updated_at, updated_by
             ) VALUES (?, 'open', ?, ?, ?)`,
            start,
            actual,
            now,
            by,
        );
    }
    return db.get(
        `SELECT period_start, actual_freight_bills_total, freight_rate_percent, freight_calc_source
           FROM receiving_report_period_status WHERE period_start=?`,
        start,
    );
}

module.exports = {
    ensurePeriodFreightRatesSchema,
    getPeriodFreightRate,
    upsertPeriodFreightRate,
    requirePeriodFreightRate,
    resolveAppliedFreightRatePercent,
    setActualFreightBillsTotal,
};
