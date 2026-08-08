'use strict';

const { normalizeStoreDate, resolvePeriodStart, addDays } = require('./edmonton-receiving-report.cjs');

function normalizeKey(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '');
}

function vendorsMatch(a, b) {
    const left = normalizeKey(a);
    const right = normalizeKey(b);
    if (!left || !right) return false;
    if (left === right) return true;
    if (left.length >= 4 && right.length >= 4) {
        return left.includes(right) || right.includes(left);
    }
    return false;
}

function listDockVendorsForDate(db, storeDate) {
    const date = normalizeStoreDate(storeDate);
    try {
        return db.all(
            `SELECT DISTINCT vendor
               FROM expected_orders
              WHERE arrived = 1
                AND trim(vendor) != ''
                AND (
                    substr(COALESCE(arrived_at, ''), 1, 10) = ?
                    OR expected_day = ?
                )
              ORDER BY vendor COLLATE NOCASE`,
            date,
            date,
        ).map((row) => String(row.vendor || '').trim()).filter(Boolean);
    } catch (_) {
        return [];
    }
}

function listLogSuppliersForDate(db, storeDate) {
    const date = normalizeStoreDate(storeDate);
    try {
        return db.all(
            `SELECT DISTINCT supplier_name
               FROM receiving_report_lines
              WHERE store_date = ?
                AND line_kind = 'invoice'
                AND trim(supplier_name) != ''
              ORDER BY supplier_name COLLATE NOCASE`,
            date,
        ).map((row) => String(row.supplier_name || '').trim()).filter(Boolean);
    } catch (_) {
        return [];
    }
}

function reconcileDay(db, storeDate) {
    const dockVendors = listDockVendorsForDate(db, storeDate);
    const logSuppliers = listLogSuppliersForDate(db, storeDate);
    const matched = [];
    const dockOnly = [];
    const logOnly = [];

    dockVendors.forEach((vendor) => {
        const match = logSuppliers.find((supplier) => vendorsMatch(vendor, supplier));
        if (match) matched.push({ dock: vendor, log: match });
        else dockOnly.push(vendor);
    });

    logSuppliers.forEach((supplier) => {
        const match = dockVendors.find((vendor) => vendorsMatch(vendor, supplier));
        if (!match) logOnly.push(supplier);
    });

    return {
        store_date: storeDate,
        dock_count: dockVendors.length,
        log_count: logSuppliers.length,
        matched_count: matched.length,
        dock_only: dockOnly,
        log_only: logOnly,
        matched,
    };
}

function buildDockReconciliationPayload(db, anchorDate) {
    const start = resolvePeriodStart(db, anchorDate);
    const end = addDays(start, 34);
    const days = [];
    let cursor = start;
    while (cursor <= end) {
        days.push(reconcileDay(db, cursor));
        cursor = addDays(cursor, 1);
    }

    const summary = {
        period_start: start,
        period_end: end,
        days_with_dock_only: days.filter((d) => d.dock_only.length > 0).length,
        days_with_log_only: days.filter((d) => d.log_only.length > 0).length,
        days_fully_matched: days.filter((d) => d.dock_count > 0 && d.dock_only.length === 0 && d.log_only.length === 0).length,
        total_dock_arrivals: days.reduce((sum, d) => sum + d.dock_count, 0),
        total_log_suppliers: days.reduce((sum, d) => sum + d.log_count, 0),
        exception_days: days.filter((d) => d.dock_only.length > 0 || d.log_only.length > 0).length,
    };

    return { ...summary, days };
}

module.exports = {
    normalizeKey,
    vendorsMatch,
    listDockVendorsForDate,
    listLogSuppliersForDate,
    reconcileDay,
    buildDockReconciliationPayload,
};
