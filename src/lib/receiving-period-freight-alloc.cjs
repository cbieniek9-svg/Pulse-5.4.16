'use strict';

/**
 * Period department freight allocation profiles — authoritative workbook model (5.4.16).
 * Department Freight = Daily Freight Allocation Total (N3) × Period Department Allocation %
 *
 * The 5.4.15 single-rate table (receiving_period_freight_rates) is preserved but non-authoritative.
 */

const { roundMoney } = require('./parse-money.cjs');

const ALLOC_DEPT_KEYS = Object.freeze([
    'grocery',
    'tobacco',
    'meat',
    'bakery',
    'bakery_in_store',
    'deli',
    'produce',
    'produce_shrink',
    'dairy',
    'pharmacy',
]);

/** Template percentages (percent points) matching FREIGHT_ALLOC_PCT / workbook row 2. */
const DEFAULT_ALLOC_PCT_POINTS = Object.freeze({
    grocery: 47.8,
    tobacco: 0,
    meat: 9.9,
    bakery: 0,
    bakery_in_store: 0,
    deli: 0,
    produce: 15.9,
    produce_shrink: 12.2,
    dairy: 14.2,
    pharmacy: 0,
});

const PROFILE_STATUS = Object.freeze({
    DRAFT: 'draft',
    CONFIRMED: 'confirmed',
});

const TOTAL_TOLERANCE = 0.0001; // percent-points tolerance around 100

function normalizePeriodStart(value) {
    const text = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        const err = new Error(`Invalid period_start: ${value}`);
        err.status = 400;
        throw err;
    }
    return text;
}

function columns(db, table) {
    try {
        return new Set((db.all(`PRAGMA table_info(${table})`) || []).map((row) => row.name));
    } catch (_) {
        return new Set();
    }
}

function tableExists(db, table) {
    try {
        const row = db.get(
            `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
            table,
        );
        return !!row;
    } catch (_) {
        return columns(db, table).size > 0;
    }
}

function addColumn(db, table, name, ddl) {
    // Upgrade fixtures may not have receiving tables yet — skip, do not ALTER missing tables.
    if (!tableExists(db, table)) return;
    if (!columns(db, table).has(name)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
}

function ensurePeriodFreightAllocSchema(db) {
    // Lightweight / mock DBs used in unit tests may omit exec — skip DDL there.
    if (!db || typeof db.exec !== 'function') return;
    db.exec(`
        CREATE TABLE IF NOT EXISTS receiving_period_freight_alloc_profiles (
            period_start TEXT NOT NULL PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            grocery_pct REAL NOT NULL DEFAULT 0,
            tobacco_pct REAL NOT NULL DEFAULT 0,
            meat_pct REAL NOT NULL DEFAULT 0,
            bakery_pct REAL NOT NULL DEFAULT 0,
            bakery_in_store_pct REAL NOT NULL DEFAULT 0,
            deli_pct REAL NOT NULL DEFAULT 0,
            produce_pct REAL NOT NULL DEFAULT 0,
            produce_shrink_pct REAL NOT NULL DEFAULT 0,
            dairy_pct REAL NOT NULL DEFAULT 0,
            pharmacy_pct REAL NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT,
            created_by TEXT NOT NULL DEFAULT '',
            updated_by TEXT NOT NULL DEFAULT '',
            confirmed_at TEXT,
            confirmed_by TEXT NOT NULL DEFAULT '',
            confirmation_reason TEXT NOT NULL DEFAULT '',
            audit_json TEXT
        );

        CREATE TABLE IF NOT EXISTS receiving_period_freight_alloc_snapshots (
            period_start TEXT NOT NULL,
            department TEXT NOT NULL,
            pct_percent REAL NOT NULL,
            snapshotted_at TEXT NOT NULL,
            snapshotted_by TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (period_start, department)
        );

        CREATE TABLE IF NOT EXISTS receiving_report_day_freight_alloc (
            store_date TEXT NOT NULL,
            department TEXT NOT NULL,
            allocated_amount REAL NOT NULL DEFAULT 0,
            daily_freight_total REAL,
            profile_period_start TEXT,
            calc_source TEXT NOT NULL DEFAULT '',
            updated_at TEXT,
            PRIMARY KEY (store_date, department)
        );
    `);

    addColumn(db, 'receiving_report_period_status', 'freight_alloc_profile_status', "freight_alloc_profile_status TEXT DEFAULT ''");
    addColumn(db, 'receiving_report_period_status', 'freight_calc_source', "freight_calc_source TEXT DEFAULT ''");
    addColumn(db, 'receiving_report_day', 'daily_freight_allocation_total', 'daily_freight_allocation_total REAL');
}

function emptyPctMap() {
    return Object.fromEntries(ALLOC_DEPT_KEYS.map((k) => [k, 0]));
}

function rowToPctMap(row) {
    if (!row) return emptyPctMap();
    const map = emptyPctMap();
    ALLOC_DEPT_KEYS.forEach((key) => {
        const col = `${key}_pct`;
        if (row[col] != null && row[col] !== '') {
            map[key] = Number(row[col]);
        }
    });
    return map;
}

function pctMapTotal(pctMap) {
    return ALLOC_DEPT_KEYS.reduce((s, k) => s + Number(pctMap?.[k] || 0), 0);
}

/**
 * Validate department allocation percentages (percent points 0–100, total ≈ 100).
 * @returns {{ ok: boolean, errors: string[], total: number, pctMap: object }}
 */
function validateAllocProfile(pctMap, { requireComplete = true } = {}) {
    const errors = [];
    const map = emptyPctMap();
    ALLOC_DEPT_KEYS.forEach((key) => {
        const raw = pctMap?.[key];
        if (raw === null || raw === undefined || raw === '') {
            if (requireComplete) errors.push(`Missing percentage for ${key}`);
            map[key] = 0;
            return;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || Number.isNaN(n)) {
            errors.push(`Invalid percentage for ${key}`);
            map[key] = 0;
            return;
        }
        if (n < 0) errors.push(`${key} cannot be negative`);
        if (n > 100) errors.push(`${key} cannot exceed 100%`);
        map[key] = n;
    });
    const total = pctMapTotal(map);
    if (Math.abs(total - 100) > TOTAL_TOLERANCE) {
        errors.push(`Profile total must equal 100% (got ${roundMoney(total)}%)`);
    }
    return { ok: errors.length === 0, errors, total, pctMap: map };
}

function getProfileRow(db, periodStart) {
    ensurePeriodFreightAllocSchema(db);
    const start = normalizePeriodStart(periodStart);
    return db.get(
        'SELECT * FROM receiving_period_freight_alloc_profiles WHERE period_start=?',
        start,
    ) || null;
}

function getSnapshotPctMap(db, periodStart) {
    ensurePeriodFreightAllocSchema(db);
    const start = normalizePeriodStart(periodStart);
    const rows = db.all(
        'SELECT department, pct_percent FROM receiving_period_freight_alloc_snapshots WHERE period_start=?',
        start,
    ) || [];
    if (!rows.length) return null;
    const map = emptyPctMap();
    rows.forEach((r) => {
        const key = String(r.department || '').trim();
        if (ALLOC_DEPT_KEYS.includes(key)) map[key] = Number(r.pct_percent);
    });
    return map;
}

/**
 * Resolve allocation profile for costing.
 * Confirmed snapshot wins; else live confirmed profile; else null (missing).
 * Never converts null/missing into zeros silently for confirmation paths.
 */
function resolveAllocProfile(db, periodStart) {
    const start = normalizePeriodStart(periodStart);
    const snap = getSnapshotPctMap(db, start);
    if (snap) {
        return {
            period_start: start,
            status: PROFILE_STATUS.CONFIRMED,
            source: 'snapshot',
            pctMap: snap,
            pct_fractions: Object.fromEntries(
                ALLOC_DEPT_KEYS.map((k) => [k, Number(snap[k] || 0) / 100]),
            ),
        };
    }
    const row = getProfileRow(db, start);
    if (!row) {
        return {
            period_start: start,
            status: 'missing',
            source: 'missing',
            pctMap: null,
            pct_fractions: null,
        };
    }
    const pctMap = rowToPctMap(row);
    const status = String(row.status || PROFILE_STATUS.DRAFT);
    if (status !== PROFILE_STATUS.CONFIRMED) {
        return {
            period_start: start,
            status,
            source: 'draft',
            pctMap,
            pct_fractions: Object.fromEntries(
                ALLOC_DEPT_KEYS.map((k) => [k, Number(pctMap[k] || 0) / 100]),
            ),
            row,
        };
    }
    return {
        period_start: start,
        status: PROFILE_STATUS.CONFIRMED,
        source: 'profile',
        pctMap,
        pct_fractions: Object.fromEntries(
            ALLOC_DEPT_KEYS.map((k) => [k, Number(pctMap[k] || 0) / 100]),
        ),
        row,
    };
}

function requireConfirmedAllocProfile(db, periodStart) {
    const resolved = resolveAllocProfile(db, periodStart);
    if (resolved.status !== PROFILE_STATUS.CONFIRMED || !resolved.pctMap) {
        const err = new Error(
            `Period department freight allocation profile is missing or not confirmed for ${normalizePeriodStart(periodStart)} (FREIGHT_ALLOC_PROFILE_MISSING).`,
        );
        err.status = 409;
        err.code = 'FREIGHT_ALLOC_PROFILE_MISSING';
        throw err;
    }
    const v = validateAllocProfile(resolved.pctMap, { requireComplete: true });
    if (!v.ok) {
        const err = new Error(v.errors.join('; '));
        err.status = 409;
        err.code = 'FREIGHT_ALLOC_PROFILE_INVALID';
        err.details = v.errors;
        throw err;
    }
    return resolved;
}

function upsertDraftProfile(db, periodStart, pctMap, actor = '') {
    ensurePeriodFreightAllocSchema(db);
    const start = normalizePeriodStart(periodStart);
    const existing = getProfileRow(db, start);
    if (existing && String(existing.status) === PROFILE_STATUS.CONFIRMED) {
        const err = new Error(
            'Confirmed allocation profile cannot be edited as a draft. Use reopen/correction workflow.',
        );
        err.status = 409;
        err.code = 'FREIGHT_ALLOC_PROFILE_LOCKED';
        throw err;
    }
    // Soft validate for draft save (allow incomplete while editing); still reject negatives/>100/NaN.
    const map = emptyPctMap();
    const errors = [];
    ALLOC_DEPT_KEYS.forEach((key) => {
        const raw = pctMap?.[key];
        if (raw === null || raw === undefined || raw === '') {
            map[key] = 0;
            return;
        }
        const n = Number(raw);
        if (!Number.isFinite(n) || Number.isNaN(n)) {
            errors.push(`Invalid percentage for ${key}`);
            return;
        }
        if (n < 0) errors.push(`${key} cannot be negative`);
        if (n > 100) errors.push(`${key} cannot exceed 100%`);
        map[key] = n;
    });
    if (errors.length) {
        const err = new Error(errors.join('; '));
        err.status = 400;
        err.code = 'FREIGHT_ALLOC_PROFILE_INVALID';
        err.details = errors;
        throw err;
    }
    const now = new Date().toISOString();
    const by = String(actor || '').trim();
    if (existing) {
        db.run(
            `UPDATE receiving_period_freight_alloc_profiles SET
                status='draft',
                grocery_pct=?, tobacco_pct=?, meat_pct=?, bakery_pct=?, bakery_in_store_pct=?,
                deli_pct=?, produce_pct=?, produce_shrink_pct=?, dairy_pct=?, pharmacy_pct=?,
                updated_at=?, updated_by=?,
                confirmed_at=NULL, confirmed_by='', confirmation_reason=''
              WHERE period_start=?`,
            map.grocery, map.tobacco, map.meat, map.bakery, map.bakery_in_store,
            map.deli, map.produce, map.produce_shrink, map.dairy, map.pharmacy,
            now, by, start,
        );
    } else {
        db.run(
            `INSERT INTO receiving_period_freight_alloc_profiles (
                period_start, status,
                grocery_pct, tobacco_pct, meat_pct, bakery_pct, bakery_in_store_pct,
                deli_pct, produce_pct, produce_shrink_pct, dairy_pct, pharmacy_pct,
                created_at, updated_at, created_by, updated_by
             ) VALUES (?, 'draft', ?,?,?,?,?,?,?,?,?,?, ?,?,?,?)`,
            start,
            map.grocery, map.tobacco, map.meat, map.bakery, map.bakery_in_store,
            map.deli, map.produce, map.produce_shrink, map.dairy, map.pharmacy,
            now, now, by, by,
        );
    }
    return getProfileRow(db, start);
}

function copyPreviousProfileAsDraft(db, periodStart, fromPeriodStart, actor = '') {
    const from = resolveAllocProfile(db, fromPeriodStart);
    if (!from.pctMap) {
        const err = new Error('Source period has no allocation profile to copy.');
        err.status = 404;
        throw err;
    }
    return upsertDraftProfile(db, periodStart, from.pctMap, actor);
}

function confirmProfile(db, periodStart, actor = '', reason = '') {
    ensurePeriodFreightAllocSchema(db);
    const start = normalizePeriodStart(periodStart);
    const row = getProfileRow(db, start);
    if (!row) {
        const err = new Error('No draft allocation profile to confirm.');
        err.status = 404;
        err.code = 'FREIGHT_ALLOC_PROFILE_MISSING';
        throw err;
    }
    const pctMap = rowToPctMap(row);
    const v = validateAllocProfile(pctMap, { requireComplete: true });
    if (!v.ok) {
        const err = new Error(v.errors.join('; '));
        err.status = 400;
        err.code = 'FREIGHT_ALLOC_PROFILE_INVALID';
        err.details = v.errors;
        throw err;
    }
    const why = String(reason || '').trim();
    if (!why) {
        const err = new Error('A manager confirmation reason is required.');
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    const by = String(actor || '').trim();
    const audit = JSON.stringify({ action: 'confirm', at: now, by, reason: why, pctMap: v.pctMap });

    db.transaction(() => {
        db.run(
            `UPDATE receiving_period_freight_alloc_profiles SET
                status='confirmed', confirmed_at=?, confirmed_by=?, confirmation_reason=?,
                updated_at=?, updated_by=?, audit_json=?
              WHERE period_start=?`,
            now, by, why, now, by, audit, start,
        );
        db.run('DELETE FROM receiving_period_freight_alloc_snapshots WHERE period_start=?', start);
        ALLOC_DEPT_KEYS.forEach((key) => {
            db.run(
                `INSERT INTO receiving_period_freight_alloc_snapshots
                    (period_start, department, pct_percent, snapshotted_at, snapshotted_by)
                 VALUES (?, ?, ?, ?, ?)`,
                start, key, v.pctMap[key], now, by,
            );
        });
        const existing = db.get(
            'SELECT period_start FROM receiving_report_period_status WHERE period_start=?',
            start,
        );
        if (existing) {
            db.run(
                `UPDATE receiving_report_period_status
                    SET freight_alloc_profile_status='confirmed',
                        freight_calc_source='period_department_allocation',
                        updated_at=?, updated_by=?
                  WHERE period_start=?`,
                now, by, start,
            );
        } else {
            db.run(
                `INSERT INTO receiving_report_period_status (
                    period_start, status, freight_alloc_profile_status, freight_calc_source,
                    updated_at, updated_by
                 ) VALUES (?, 'open', 'confirmed', 'period_department_allocation', ?, ?)`,
                start, now, by,
            );
        }
    })();

    return resolveAllocProfile(db, start);
}

/**
 * Seed a draft from DEFAULT_ALLOC_PCT_POINTS if none exists (never auto-confirm).
 */
function ensureDraftFromTemplate(db, periodStart, actor = '') {
    const start = normalizePeriodStart(periodStart);
    if (getProfileRow(db, start)) return getProfileRow(db, start);
    return upsertDraftProfile(db, start, { ...DEFAULT_ALLOC_PCT_POINTS }, actor);
}

function profileApiView(db, periodStart) {
    const resolved = resolveAllocProfile(db, periodStart);
    const row = getProfileRow(db, periodStart);
    const pctMap = resolved.pctMap || (row ? rowToPctMap(row) : emptyPctMap());
    const total = pctMapTotal(pctMap);
    const validation = validateAllocProfile(pctMap, { requireComplete: true });
    return {
        period_start: normalizePeriodStart(periodStart),
        status: resolved.status,
        source: resolved.source,
        departments: ALLOC_DEPT_KEYS.map((key) => ({
            key,
            pct_percent: pctMap[key],
        })),
        pct_map: pctMap,
        total_pct: roundMoney(total),
        can_confirm: validation.ok && resolved.status !== PROFILE_STATUS.CONFIRMED,
        validation,
        confirmed_at: row?.confirmed_at || null,
        confirmed_by: row?.confirmed_by || '',
        updated_at: row?.updated_at || null,
        updated_by: row?.updated_by || '',
        template_defaults: { ...DEFAULT_ALLOC_PCT_POINTS },
    };
}

module.exports = {
    ALLOC_DEPT_KEYS,
    DEFAULT_ALLOC_PCT_POINTS,
    PROFILE_STATUS,
    ensurePeriodFreightAllocSchema,
    emptyPctMap,
    rowToPctMap,
    pctMapTotal,
    validateAllocProfile,
    getProfileRow,
    getSnapshotPctMap,
    resolveAllocProfile,
    requireConfirmedAllocProfile,
    upsertDraftProfile,
    copyPreviousProfileAsDraft,
    confirmProfile,
    ensureDraftFromTemplate,
    profileApiView,
    normalizePeriodStart,
};
