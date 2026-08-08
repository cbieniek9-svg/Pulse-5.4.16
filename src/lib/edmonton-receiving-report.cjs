'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { upsertSetting } = require('./settings-store.cjs');
const { parseMoneyOrNull, parseRequiredMoney, roundMoney } = require('./parse-money.cjs');
const {
    lineLandedPurchases,
    snapshotDayLinePeriodFreight,
} = require('./edmonton-receiving-costing.cjs');
const { resolveAppliedFreightRatePercent } = require('./receiving-period-freight-rates.cjs');

const SETTING_PERIOD_START = 'Receiving_Report_Period_Start';
const TEMPLATE_FILE = 'Template-Edmonton-Wholesale-Market-Receiving-Report.xlsx';
const DATA_START_ROW = 6;
const DATA_END_ROW = 55;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

function templatePath() {
    return path.join(__dirname, '..', '..', 'store-templates', 'default', TEMPLATE_FILE);
}

function normalizeStoreDate(value) {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const err = new Error('Expected date in YYYY-MM-DD format.');
        err.status = 400;
        throw err;
    }
    return s;
}

function addDays(storeDate, delta) {
    const [y, m, d] = normalizeStoreDate(storeDate).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Number(delta || 0));
    return dt.toISOString().slice(0, 10);
}

function parseUtcDate(storeDate) {
    const [y, m, d] = normalizeStoreDate(storeDate).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function sundayOnOrBefore(storeDate) {
    const dt = parseUtcDate(storeDate);
    dt.setUTCDate(dt.getUTCDate() - dt.getUTCDay());
    return dt.toISOString().slice(0, 10);
}

function readPeriodStartSetting(db) {
    const row = db.get(
        'SELECT setting_value FROM settings WHERE setting_name=?',
        SETTING_PERIOD_START,
    );
    const val = String(row?.setting_value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : '';
}

function resolvePeriodStart(db, storeDate) {
    const date = normalizeStoreDate(storeDate);
    const configured = readPeriodStartSetting(db);
    if (configured) {
        const end = addDays(configured, 34);
        if (date >= configured && date <= end) return configured;
    }
    let start = sundayOnOrBefore(date);
    while (date < start) start = addDays(start, -7);
    while (date > addDays(start, 34)) start = addDays(start, 7);
    return start;
}

// Viewing a historical period must never mutate the operational period setting.
function resolvePeriodStartExplicit(db, { date, period_start: periodStart } = {}) {
    const explicit = String(periodStart || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return normalizeStoreDate(explicit);
    return resolvePeriodStart(db, date);
}

function resolveSheetMeta(storeDate, periodStart) {
    const start = parseUtcDate(periodStart);
    const date = parseUtcDate(storeDate);
    const diffDays = Math.round((date - start) / 86400000);
    if (diffDays < 0 || diffDays > 34) {
        const err = new Error(
            `Date ${storeDate} is outside the 35-day report period starting ${periodStart}. Update Receiving Report Period Start in /financial.`,
        );
        err.status = 400;
        throw err;
    }
    const weekNum = Math.floor(diffDays / 7) + 1;
    const dayOfWeek = date.getUTCDay();
    const sheetIndex = (weekNum - 1) * 7 + dayOfWeek + 1;
    const sheetName = `${DAY_NAMES[dayOfWeek]} WK${weekNum} (${sheetIndex})`;
    return { sheetName, sheetIndex, weekNum, dayOfWeek, periodStart, diffDays };
}

function calcLineTotal(line) {
    return roundMoney(
        Number(line.grocery || 0)
        + Number(line.tobacco || 0)
        + Number(line.meat || 0)
        + Number(line.bakery || 0)
        + Number(line.bakery_in_store || 0)
        + Number(line.deli || 0)
        + Number(line.produce || 0)
        + Number(line.produce_shrink || 0)
        + Number(line.dairy || 0)
        + Number(line.pharmacy || 0)
        + Number(line.gst || 0),
    );
}

const DEPT_MONEY_LABELS = {
    grocery: 'Grocery',
    tobacco: 'Tobacco',
    meat: 'Meat',
    bakery: 'Bakery',
    bakery_in_store: 'Bake Off',
    deli: 'Deli',
    produce: 'Produce',
    produce_shrink: 'Produce Shrink',
    dairy: 'Dairy',
    pharmacy: 'Pharmacy',
    gst: 'GST',
    freight_grocery: 'Freight Grocery',
    freight_tobacco: 'Freight Tobacco',
    freight_meat: 'Freight Meat',
    freight_bakery: 'Freight Bakery',
    freight_bakery_in_store: 'Freight Bake Off',
    freight_deli: 'Freight Deli',
    freight_produce: 'Freight Produce',
    freight_dairy: 'Freight Dairy',
    freight_pharmacy: 'Freight Pharmacy',
};

const FREIGHT_MONEY_KEYS = [
    'freight_grocery',
    'freight_tobacco',
    'freight_meat',
    'freight_bakery',
    'freight_bakery_in_store',
    'freight_deli',
    'freight_produce',
    'freight_dairy',
    'freight_pharmacy',
];

function moneyFieldOrThrow(raw, key) {
    const result = parseRequiredMoney(raw[key], DEPT_MONEY_LABELS[key] || key);
    if (!result.ok) {
        const err = new Error(`Not a number: ${result.label}`);
        err.status = 400;
        throw err;
    }
    return result.value;
}

function optionalFreightField(raw, key, { allowNegative = false } = {}) {
    if (raw[key] === undefined || raw[key] === null || raw[key] === '') return 0;
    const value = moneyFieldOrThrow(raw, key);
    if (value < 0 && !allowNegative) {
        const err = new Error(
            `Negative ${DEPT_MONEY_LABELS[key] || key} requires a manager-authorized freight credit exception.`,
        );
        err.status = 403;
        err.code = 'NEGATIVE_FREIGHT_FORBIDDEN';
        throw err;
    }
    return value;
}

function normalizeLineInput(raw = {}, opts = {}) {
    const kind = String(raw.line_kind || raw.kind || 'invoice').trim().toLowerCase() || 'invoice';
    const freight = {};
    FREIGHT_MONEY_KEYS.forEach((key) => {
        freight[key] = optionalFreightField(raw, key, opts);
    });
    return {
        line_kind: ['invoice', 'write_off', 'spacer'].includes(kind) ? kind : 'invoice',
        invoice_number: String(raw.invoice_number || '').trim(),
        supplier_name: String(raw.supplier_name || '').trim(),
        grocery: moneyFieldOrThrow(raw, 'grocery'),
        tobacco: moneyFieldOrThrow(raw, 'tobacco'),
        meat: moneyFieldOrThrow(raw, 'meat'),
        bakery: moneyFieldOrThrow(raw, 'bakery'),
        bakery_in_store: moneyFieldOrThrow(raw, 'bakery_in_store'),
        deli: moneyFieldOrThrow(raw, 'deli'),
        produce: moneyFieldOrThrow(raw, 'produce'),
        produce_shrink: moneyFieldOrThrow(raw, 'produce_shrink'),
        dairy: moneyFieldOrThrow(raw, 'dairy'),
        pharmacy: moneyFieldOrThrow(raw, 'pharmacy'),
        gst: moneyFieldOrThrow(raw, 'gst'),
        ...freight,
        notes: String(raw.notes || '').trim(),
    };
}

function mapLineRow(row) {
    const line = {
        line_id: row.line_id,
        store_date: row.store_date,
        sort_order: Number(row.sort_order || 0),
        line_kind: row.line_kind || 'invoice',
        invoice_number: row.invoice_number || '',
        supplier_name: row.supplier_name || '',
        grocery: roundMoney(row.grocery),
        tobacco: roundMoney(row.tobacco),
        meat: roundMoney(row.meat),
        bakery: roundMoney(row.bakery),
        bakery_in_store: roundMoney(row.bakery_in_store),
        deli: roundMoney(row.deli),
        produce: roundMoney(row.produce),
        produce_shrink: roundMoney(row.produce_shrink),
        dairy: roundMoney(row.dairy),
        pharmacy: roundMoney(row.pharmacy),
        gst: roundMoney(row.gst),
        freight_grocery: roundMoney(row.freight_grocery || 0),
        freight_tobacco: roundMoney(row.freight_tobacco || 0),
        freight_meat: roundMoney(row.freight_meat || 0),
        freight_bakery: roundMoney(row.freight_bakery || 0),
        freight_bakery_in_store: roundMoney(row.freight_bakery_in_store || 0),
        freight_deli: roundMoney(row.freight_deli || 0),
        freight_produce: roundMoney(row.freight_produce || 0),
        freight_dairy: roundMoney(row.freight_dairy || 0),
        freight_pharmacy: roundMoney(row.freight_pharmacy || 0),
        applied_freight_rate: row.applied_freight_rate == null ? null : Number(row.applied_freight_rate),
        allocated_freight: row.allocated_freight == null ? null : roundMoney(row.allocated_freight),
        eligible_merchandise: row.eligible_merchandise == null ? null : roundMoney(row.eligible_merchandise),
        landed_purchase_cost: row.landed_purchase_cost == null ? null : roundMoney(row.landed_purchase_cost),
        freight_calc_source: row.freight_calc_source || '',
        notes: row.notes || '',
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by || '',
        updated_by: row.updated_by || '',
    };
    line.freight_total = roundMoney(
        FREIGHT_MONEY_KEYS.reduce((sum, key) => sum + Number(line[key] || 0), 0),
    );
    line.has_freight = line.freight_total !== 0;
    line.total_invoice = calcLineTotal(line);
    // Invoice freight_* is reference-only; prefer allocated/landed_purchase_cost when present.
    line.landed_purchases = lineLandedPurchases(line);
    return line;
}

function getDayMeta(db, storeDate) {
    const date = normalizeStoreDate(storeDate);
    const row = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', date);
    const periodStart = resolvePeriodStart(db, date);
    const sheet = resolveSheetMeta(date, periodStart);
    const {
        computeDayFreightReconciliation,
        dayContentFingerprint,
        isOverflowAcknowledged,
        PAGE_SIZE,
    } = require('./edmonton-receiving-integrity.cjs');
    const lines = listLines(db, date);
    const reconciliation = computeDayFreightReconciliation(db, date, row, lines);
    const cert = {
        receiving_complete: Number(row?.cert_receiving_complete) === 1,
        invoices_entered: Number(row?.cert_invoices_entered) === 1,
        references_verified: Number(row?.cert_references_verified) === 1,
        freight_verified: Number(row?.cert_freight_verified) === 1,
        receiver_identified: Number(row?.cert_receiver_identified) === 1,
        exceptions_documented: Number(row?.cert_exceptions_documented) === 1,
        certified_at: row?.certified_at || null,
        certified_by: row?.certified_by || '',
        content_fingerprint: row?.cert_content_fingerprint || '',
    };
    const certificationFingerprintMatches = !!row?.cert_content_fingerprint
        && row.cert_content_fingerprint === dayContentFingerprint(db, date);
    const certified = certificationFingerprintMatches && !!row?.certified_at && Object.keys(cert)
        .filter((k) => !['certified_at', 'certified_by', 'content_fingerprint'].includes(k))
        .every((k) => cert[k]);
    const lineCount = lines.length;
    return {
        store_date: date,
        receiver_name: row?.receiver_name || '',
        freight_total: reconciliation.expected,
        expected_freight: reconciliation.expected,
        entered_freight_total: reconciliation.entered,
        freight_reconciliation: reconciliation,
        freight_override_reason: row?.freight_override_reason || '',
        freight_override_by: row?.freight_override_by || '',
        freight_override_at: row?.freight_override_at || null,
        certification: cert,
        certified,
        certification_fingerprint_matches: certificationFingerprintMatches,
        line_count: lineCount,
        line_overflow: lineCount > PAGE_SIZE,
        overflow_acknowledged: isOverflowAcknowledged(row, lineCount),
        overflow_acknowledged_at: row?.overflow_acknowledged_at || null,
        overflow_acknowledged_by: row?.overflow_acknowledged_by || '',
        overflow_ack_reason: row?.overflow_ack_reason || '',
        updated_at: row?.updated_at || null,
        updated_by: row?.updated_by || '',
        period_start: periodStart,
        configured_period_start: readPeriodStartSetting(db),
        sheet_name: sheet.sheetName,
        sheet_index: sheet.sheetIndex,
    };
}

function listLines(db, storeDate) {
    const date = normalizeStoreDate(storeDate);
    return db.all(
        `SELECT * FROM receiving_report_lines
          WHERE store_date=?
          ORDER BY sort_order ASC, created_at ASC, line_id ASC`,
        date,
    ).map(mapLineRow);
}

function buildReportPayload(db, storeDate) {
    const meta = getDayMeta(db, storeDate);
    const lines = listLines(db, storeDate);
    const deptTotals = {
        grocery: 0, tobacco: 0, meat: 0, bakery: 0, bakery_in_store: 0,
        deli: 0, produce: 0, produce_shrink: 0, dairy: 0, pharmacy: 0, gst: 0,
    };
    let invoiceTotal = 0;
    lines.forEach((line) => {
        Object.keys(deptTotals).forEach((k) => { deptTotals[k] += Number(line[k] || 0); });
        invoiceTotal += Number(line.total_invoice || 0);
    });
    Object.keys(deptTotals).forEach((k) => { deptTotals[k] = roundMoney(deptTotals[k]); });

    let shrinkLines = [];
    let shrinkSummary = {
        total: 0,
        line_count: 0,
        sku_count: 0,
        by_department: {},
        by_sku: [],
    };
    try {
        const { listShrinkLines, buildShrinkSummary } = require('./receiving-invoice-import.cjs');
        shrinkLines = listShrinkLines(db, storeDate);
        shrinkSummary = buildShrinkSummary(shrinkLines);
    } catch (_) {
        /* migration may not be applied yet */
    }

    return {
        ...meta,
        lines,
        line_warnings: buildLineWarningsForDay(db, storeDate, lines),
        shrink_lines: shrinkLines,
        shrink_summary: shrinkSummary,
        totals: {
            ...deptTotals,
            invoice_total: roundMoney(invoiceTotal),
            shrink_total: shrinkSummary.total,
        },
    };
}

function savePeriodStart(db, storeDate, actorName = '') {
    const periodStart = resolvePeriodStart(db, storeDate);
    upsertSetting(db, SETTING_PERIOD_START, periodStart);
    return periodStart;
}

function upsertDayMeta(db, storeDate, payload = {}, actorName = '') {
    const date = normalizeStoreDate(storeDate);
    const now = new Date().toISOString();
    const existing = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', date);
    const receiver = payload.receiver_name !== undefined || payload.receiver !== undefined
        ? String(payload.receiver_name ?? payload.receiver ?? '').trim()
        : (existing?.receiver_name || '');
    const freightRaw = payload.freight_total ?? payload.freightTotal;
    let freight = existing?.freight_total == null ? null : Number(existing.freight_total);
    let freightChanged = false;
    if (freightRaw !== undefined) {
        if (freightRaw === '' || freightRaw == null) {
            freightChanged = freight !== null;
            freight = null;
        } else {
            const parsed = parseMoneyOrNull(freightRaw);
            if (parsed == null) {
                const err = new Error('Not a number: Freight');
                err.status = 400;
                throw err;
            }
            const next = roundMoney(parsed);
            freightChanged = freight !== next;
            freight = next;
        }
    }
    const receiverChanged = existing && receiver !== String(existing.receiver_name || '');

    if (existing) {
        db.run(
            `UPDATE receiving_report_day
                SET receiver_name=?, freight_total=?, updated_at=?, updated_by=?
              WHERE store_date=?`,
            receiver,
            freight,
            now,
            actorName || '',
            date,
        );
    } else {
        db.run(
            `INSERT INTO receiving_report_day
                (store_date, receiver_name, freight_total, updated_at, updated_by)
             VALUES (?, ?, ?, ?, ?)`,
            date,
            receiver,
            freight,
            now,
            actorName || '',
        );
    }

    const {
        invalidateDayFinancialState,
        persistDayFreightReconciliation,
    } = require('./edmonton-receiving-integrity.cjs');
    if (existing && (freightChanged || receiverChanged)) {
        invalidateDayFinancialState(db, date, { clearOverride: freightChanged });
    } else {
        persistDayFreightReconciliation(db, date);
    }
    // Never silently change global operational period from day saves.
    return getDayMeta(db, date);
}

function saveDayCertification(db, storeDate, payload = {}, actorName = '') {
    const date = normalizeStoreDate(storeDate);
    const now = new Date().toISOString();
    const periodStart = resolvePeriodStart(db, date);
    const periodEnd = addDays(periodStart, 34);
    const {
        evaluateCertificationEligibility,
        writeFinancialAudit,
    } = require('./edmonton-receiving-integrity.cjs');

    // Allow header updates that accompany certification payload
    if (payload.receiver_name !== undefined || payload.freight_total !== undefined) {
        upsertDayMeta(db, date, {
            receiver_name: payload.receiver_name,
            freight_total: payload.freight_total,
        }, actorName);
    }

    const eligibility = evaluateCertificationEligibility(db, date, { periodStart, periodEnd });
    const flags = {
        cert_receiving_complete: payload.receiving_complete || payload.cert_receiving_complete ? 1 : 0,
        cert_invoices_entered: payload.invoices_entered || payload.cert_invoices_entered ? 1 : 0,
        cert_references_verified: payload.references_verified || payload.cert_references_verified ? 1 : 0,
        cert_freight_verified: payload.freight_verified || payload.cert_freight_verified ? 1 : 0,
        cert_receiver_identified: payload.receiver_identified || payload.cert_receiver_identified ? 1 : 0,
        cert_exceptions_documented: payload.exceptions_documented || payload.cert_exceptions_documented ? 1 : 0,
    };

    // Cannot check freight verified while recon unresolved
    if (flags.cert_freight_verified && eligibility.problems.some((p) => p.code === 'freight_unreconciled' || p.code === 'freight_expected_missing')) {
        const err = new Error('Cannot certify freight verified while freight reconciliation is unresolved.');
        err.status = 400;
        err.eligibility = eligibility;
        throw err;
    }
    if (flags.cert_receiver_identified && eligibility.problems.some((p) => p.code === 'receiver_missing')) {
        const err = new Error('Cannot certify receiver identified without a receiver name.');
        err.status = 400;
        throw err;
    }
    if (flags.cert_references_verified && eligibility.problems.some((p) => p.code === 'reference_missing')) {
        const err = new Error('Cannot certify references verified while invoice/supplier references are missing.');
        err.status = 400;
        err.eligibility = eligibility;
        throw err;
    }

    const complete = Object.values(flags).every((v) => v === 1);
    if (complete && !eligibility.ok) {
        const err = new Error(
            `Day certification blocked: ${eligibility.problems.map((p) => p.message).join(' ')}`,
        );
        err.status = 400;
        err.eligibility = eligibility;
        throw err;
    }

    db.run(
        `UPDATE receiving_report_day SET
            cert_receiving_complete=?, cert_invoices_entered=?, cert_references_verified=?,
            cert_freight_verified=?, cert_receiver_identified=?, cert_exceptions_documented=?,
            certified_at=?, certified_by=?, cert_content_fingerprint=?, updated_at=?, updated_by=?
          WHERE store_date=?`,
        flags.cert_receiving_complete,
        flags.cert_invoices_entered,
        flags.cert_references_verified,
        flags.cert_freight_verified,
        flags.cert_receiver_identified,
        flags.cert_exceptions_documented,
        complete ? now : null,
        complete ? (actorName || '') : '',
        complete ? eligibility.fingerprint : '',
        now,
        actorName || '',
        date,
    );

    if (complete) {
        try {
            writeFinancialAudit(db, {
                periodStart,
                storeDate: date,
                eventType: 'day_certified',
                actorName,
                reason: 'day_certification',
                detail: { fingerprint: eligibility.fingerprint, reconciliation: eligibility.reconciliation },
            });
        } catch (_) { /* audit optional until migration */ }
    }
    return getDayMeta(db, date);
}

function saveFreightOverride(db, storeDate, payload = {}, actorName = '') {
    const date = normalizeStoreDate(storeDate);
    const reason = String(payload.reason || '').trim();
    if (!reason) {
        const err = new Error('A manager reason is required to override freight reconciliation.');
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    const {
        computeDayFreightReconciliation,
        dayContentFingerprint,
        writeFinancialAudit,
        clearCertification,
    } = require('./edmonton-receiving-integrity.cjs');

    // Ensure day row exists
    upsertDayMeta(db, date, {
        receiver_name: payload.receiver_name,
        freight_total: payload.freight_total,
    }, actorName);

    const recon = computeDayFreightReconciliation(db, date);
    const fingerprint = dayContentFingerprint(db, date);
    try {
        db.run(
            `UPDATE receiving_report_day
                SET freight_recon_status='OVERRIDE',
                    freight_override_reason=?,
                    freight_override_by=?,
                    freight_override_at=?,
                    freight_override_fingerprint=?,
                    freight_recon_entered=?,
                    freight_recon_difference=?,
                    updated_at=?, updated_by=?
              WHERE store_date=?`,
            reason,
            actorName || '',
            now,
            fingerprint,
            recon.entered,
            recon.difference,
            now,
            actorName || '',
            date,
        );
    } catch (_) {
        // Pre-057 DBs lack freight_recon_entered/difference — status-only fallback
        db.run(
            `UPDATE receiving_report_day
                SET freight_recon_status='OVERRIDE',
                    freight_override_reason=?,
                    freight_override_by=?,
                    freight_override_at=?,
                    updated_at=?, updated_by=?
              WHERE store_date=?`,
            reason,
            actorName || '',
            now,
            now,
            actorName || '',
            date,
        );
    }
    // Override does not auto-certify; clear stale cert so freight-verified must be re-checked
    clearCertification(db, date);
    try {
        writeFinancialAudit(db, {
            periodStart: resolvePeriodStart(db, date),
            storeDate: date,
            eventType: 'freight_override',
            actorName,
            reason,
            detail: {
                expected: recon.expected,
                entered: recon.entered,
                difference: recon.difference,
                tolerance: recon.tolerance,
                prior_status: recon.status,
                fingerprint,
            },
        });
    } catch (_) { /* audit table optional */ }
    return getDayMeta(db, date);
}

function nextSortOrder(db, storeDate) {
    const row = db.get(
        'SELECT MAX(sort_order) AS max_sort FROM receiving_report_lines WHERE store_date=?',
        normalizeStoreDate(storeDate),
    );
    return Number(row?.max_sort || 0) + 1;
}

function normalizeInvoiceKey(value) {
    return require('./edmonton-receiving-integrity.cjs').normalizeInvoiceKey(value);
}

function normalizeSupplierKey(value) {
    return require('./edmonton-receiving-integrity.cjs').normalizeSupplierKey(value);
}

function findInvoiceWarnings(db, periodStart, {
    lineId, storeDate, invoiceNumber, supplierName,
} = {}) {
    const inv = normalizeInvoiceKey(invoiceNumber);
    const supplier = normalizeSupplierKey(supplierName);
    if (!inv || !supplier) {
        return [{
            type: 'missing_invoice_reference',
            severity: 'warning',
            message: !inv ? 'Invoice number is required for duplicate validation.' : 'Supplier is required for duplicate validation.',
            exception: true,
        }];
    }
    const start = normalizeStoreDate(periodStart);
    const end = addDays(start, 34);
    const date = storeDate ? normalizeStoreDate(storeDate) : null;
    const rows = db.all(
        `SELECT line_id, store_date, invoice_number, supplier_name
           FROM receiving_report_lines
          WHERE store_date >= ? AND store_date <= ?
            AND line_kind = 'invoice'
            AND trim(invoice_number) != ''`,
        start,
        end,
    );
    return rows
        .filter((row) => {
            if (lineId && row.line_id === lineId) return false;
            return normalizeInvoiceKey(row.invoice_number) === inv
                && normalizeSupplierKey(row.supplier_name) === supplier;
        })
        .map((row) => ({
            type: 'duplicate_invoice',
            severity: row.store_date === date ? 'error' : 'warning',
            message: `Invoice ${row.invoice_number} already used on ${row.store_date}${row.supplier_name ? ` (${row.supplier_name})` : ''}`,
            store_date: row.store_date,
            line_id: row.line_id,
            invoice_number: row.invoice_number,
            supplier_name: row.supplier_name || '',
        }));
}

function lineHasData(line) {
    if (!line) return false;
    if (String(line.invoice_number || '').trim()) return true;
    if (String(line.supplier_name || '').trim()) return true;
    if (String(line.notes || '').trim()) return true;
    return DEPT_COLS.some(([key]) => Number(line[key] || 0) !== 0);
}

function buildLineWarningsForDay(db, storeDate, lines) {
    const periodStart = resolvePeriodStart(db, storeDate);
    const warningsByIndex = {};
    lines.forEach((line, idx) => {
        if (!lineHasData(line)) return;
        const warnings = [];
        if (line.line_kind !== 'write_off') {
            warnings.push(...findInvoiceWarnings(db, periodStart, {
                lineId: line.line_id,
                storeDate,
                invoiceNumber: line.invoice_number,
                supplierName: line.supplier_name,
            }));
        }
        if (idx > 0) {
            const prev = lines[idx - 1];
            if (lineHasData(prev)
                && line.total_invoice
                && prev.total_invoice
                && line.total_invoice === prev.total_invoice
                && normalizeInvoiceKey(line.invoice_number) !== normalizeInvoiceKey(prev.invoice_number)) {
                warnings.push({
                    type: 'duplicate_total',
                    severity: 'warning',
                    message: `Total ${line.total_invoice} matches row above — check for Excel copy-down error`,
                });
            }
        }
        if (warnings.length) warningsByIndex[idx] = warnings;
    });
    return warningsByIndex;
}

function saveLine(db, storeDate, rawLine = {}, actorName = '', opts = {}) {
    const date = normalizeStoreDate(storeDate);
    const allowNegative = !!opts.allowNegativeFreight
        && !!String(opts.negativeFreightReason || rawLine.negative_freight_reason || '').trim();
    const line = normalizeLineInput(rawLine, { allowNegative });
    const lineId = String(rawLine.line_id || '').trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = db.get('SELECT * FROM receiving_report_lines WHERE line_id=?', lineId);

    if (line.line_kind === 'write_off' && !line.supplier_name) {
        line.supplier_name = 'WRITE OFF BOOK';
    }

    // Persist negative freight exceptions when authorized
    if (allowNegative) {
        const {
            writeFinancialAudit,
        } = require('./edmonton-receiving-integrity.cjs');
        const reason = String(opts.negativeFreightReason || rawLine.negative_freight_reason || '').trim();
        FREIGHT_MONEY_KEYS.forEach((key) => {
            if (Number(line[key] || 0) >= 0) return;
            const original = existing ? Number(existing[key] || 0) : 0;
            try {
                db.run(
                    `INSERT INTO receiving_report_negative_freight_acks (
                        ack_id, store_date, line_id, freight_field, original_value, new_value,
                        actor_name, reason, created_at
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    crypto.randomUUID(), date, lineId, key, original, line[key],
                    actorName || '', reason, now,
                );
            } catch (_) { /* table from 057 */ }
            try {
                writeFinancialAudit(db, {
                    periodStart: resolvePeriodStart(db, date),
                    storeDate: date,
                    eventType: 'negative_freight_exception',
                    actorName,
                    reason,
                    detail: {
                        line_id: lineId,
                        freight_field: key,
                        original_value: original,
                        new_value: line[key],
                    },
                });
            } catch (_) { /* optional */ }
        });
    }

    if (existing) {
        db.run(
            `UPDATE receiving_report_lines SET
                line_kind=?, invoice_number=?, supplier_name=?,
                grocery=?, tobacco=?, meat=?, bakery=?, bakery_in_store=?,
                deli=?, produce=?, produce_shrink=?, dairy=?, pharmacy=?, gst=?,
                freight_grocery=?, freight_tobacco=?, freight_meat=?, freight_bakery=?,
                freight_bakery_in_store=?, freight_deli=?, freight_produce=?,
                freight_dairy=?, freight_pharmacy=?,
                notes=?, updated_at=?, updated_by=?
              WHERE line_id=?`,
            line.line_kind, line.invoice_number, line.supplier_name,
            line.grocery, line.tobacco, line.meat, line.bakery, line.bakery_in_store,
            line.deli, line.produce, line.produce_shrink, line.dairy, line.pharmacy, line.gst,
            line.freight_grocery, line.freight_tobacco, line.freight_meat, line.freight_bakery,
            line.freight_bakery_in_store, line.freight_deli, line.freight_produce,
            line.freight_dairy, line.freight_pharmacy,
            line.notes, now, actorName || '', lineId,
        );
    } else {
        const sortOrder = Number.isFinite(Number(rawLine.sort_order))
            ? Number(rawLine.sort_order)
            : nextSortOrder(db, date);
        db.run(
            `INSERT INTO receiving_report_lines (
                line_id, store_date, sort_order, line_kind, invoice_number, supplier_name,
                grocery, tobacco, meat, bakery, bakery_in_store, deli, produce, produce_shrink,
                dairy, pharmacy, gst,
                freight_grocery, freight_tobacco, freight_meat, freight_bakery,
                freight_bakery_in_store, freight_deli, freight_produce, freight_dairy, freight_pharmacy,
                notes, created_at, updated_at, created_by, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            lineId, date, sortOrder, line.line_kind, line.invoice_number, line.supplier_name,
            line.grocery, line.tobacco, line.meat, line.bakery, line.bakery_in_store,
            line.deli, line.produce, line.produce_shrink, line.dairy, line.pharmacy, line.gst,
            line.freight_grocery, line.freight_tobacco, line.freight_meat, line.freight_bakery,
            line.freight_bakery_in_store, line.freight_deli, line.freight_produce,
            line.freight_dairy, line.freight_pharmacy,
            line.notes, now, now, actorName || '', actorName || '',
        );
    }

    // Ensure day row exists then invalidate cert/override + refresh recon
    const day = db.get('SELECT store_date FROM receiving_report_day WHERE store_date=?', date);
    if (!day) {
        db.run(
            `INSERT INTO receiving_report_day (store_date, receiver_name, freight_total, updated_at, updated_by)
             VALUES (?, '', NULL, ?, ?)`,
            date, now, actorName || '',
        );
    }
    const { invalidateDayFinancialState } = require('./edmonton-receiving-integrity.cjs');
    invalidateDayFinancialState(db, date, { clearOverride: true });

    // Snapshot period-rate freight on invoice lines when a rate is configured.
    // Missing rate leaves snapshots unset — never invents 0% on save.
    if (line.line_kind === 'invoice' || !line.line_kind) {
        try {
            const periodStart = resolvePeriodStart(db, date);
            const ratePercent = resolveAppliedFreightRatePercent(db, periodStart);
            snapshotDayLinePeriodFreight(db, date, ratePercent);
        } catch (e) {
            if (e?.code !== 'FREIGHT_RATE_MISSING') throw e;
        }
    }

    return mapLineRow(db.get('SELECT * FROM receiving_report_lines WHERE line_id=?', lineId));
}

function deleteLine(db, lineId, actorName = '') {
    const id = String(lineId || '').trim();
    if (!id) {
        const err = new Error('line_id is required.');
        err.status = 400;
        throw err;
    }
    const row = db.get('SELECT * FROM receiving_report_lines WHERE line_id=?', id);
    if (!row) {
        const err = new Error('Receiving report line not found.');
        err.status = 404;
        throw err;
    }
    const remove = () => {
        db.run('DELETE FROM receiving_report_lines WHERE line_id=?', id);
        const {
            invalidateDayFinancialState,
            writeFinancialAudit,
        } = require('./edmonton-receiving-integrity.cjs');
        invalidateDayFinancialState(db, row.store_date, { clearOverride: true });
        writeFinancialAudit(db, {
            periodStart: resolvePeriodStart(db, row.store_date),
            storeDate: row.store_date,
            eventType: 'receiving_line_delete',
            actorName,
            reason: 'line_deleted',
            detail: {
                line_id: id,
                prior_values: row,
                new_values: null,
            },
        });
        return { success: true, line_id: id, store_date: row.store_date };
    };
    return typeof db.transaction === 'function' ? db.transaction(remove)() : remove();
}

function setCellNumber(sheet, addr, value) {
    const n = roundMoney(value);
    sheet.getCell(addr).value = n;
}

function setCellText(sheet, addr, value) {
    sheet.getCell(addr).value = String(value ?? '');
}

function clearDataRows(sheet) {
    for (let row = DATA_START_ROW; row <= DATA_END_ROW; row += 1) {
        setCellText(sheet, `A${row}`, ' ');
        setCellText(sheet, `B${row}`, ' ');
        DEPT_COLS.forEach(([key, col]) => setCellNumber(sheet, `${col}${row}`, 0));
        setCellNumber(sheet, `N${row}`, 0);
        setCellText(sheet, `O${row}`, ' ');
    }
}

function writeLineToSheet(sheet, rowNum, line) {
    if (line.line_kind === 'spacer') {
        setCellText(sheet, `A${rowNum}`, ' ');
        setCellText(sheet, `B${rowNum}`, ' ');
        DEPT_COLS.forEach(([key, col]) => setCellNumber(sheet, `${col}${rowNum}`, 0));
        setCellNumber(sheet, `N${rowNum}`, 0);
        setCellText(sheet, `O${rowNum}`, ' ');
        return;
    }
    setCellText(sheet, `A${rowNum}`, line.invoice_number || ' ');
    setCellText(sheet, `B${rowNum}`, line.supplier_name || ' ');
    DEPT_COLS.forEach(([key, col]) => setCellNumber(sheet, `${col}${rowNum}`, line[key]));
    setCellNumber(sheet, `N${rowNum}`, calcLineTotal(line));
    setCellText(sheet, `O${rowNum}`, line.notes || ' ');
}

function formatReportFilename(storeDate) {
    const [y, m, d] = normalizeStoreDate(storeDate).split('-');
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `Edmonton Wholesale Market Receiving Report ${y}${months[Number(m) - 1]}${d}.xlsx`;
}

async function buildReportWorkbookBuffer(db, storeDate) {
    const file = templatePath();
    if (!fs.existsSync(file)) {
        const err = new Error('Edmonton receiving report template is missing.');
        err.status = 500;
        throw err;
    }
    const payload = buildReportPayload(db, storeDate);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    // Lazy require avoids circular load with workbook-export
    const { writeDailySheet } = require('./edmonton-receiving-workbook-export.cjs');
    let written;
    try {
        written = writeDailySheet(wb, db, storeDate);
    } catch (error) {
        const err = new Error(error.message || 'Could not write receiving report daily sheet.');
        err.status = error.status || 500;
        err.code = error.code || 'DAILY_SHEET_WRITE_FAILED';
        err.cause = error;
        throw err;
    }

    return {
        buffer: await wb.xlsx.writeBuffer(),
        filename: formatReportFilename(payload.store_date),
        payload: {
            ...payload,
            continuation_sheets: written?.continuation_sheets || 0,
            lines_written: payload.lines.length,
        },
    };
}

module.exports = {
    SETTING_PERIOD_START,
    TEMPLATE_FILE,
    templatePath,
    normalizeStoreDate,
    addDays,
    parseUtcDate,
    resolvePeriodStart,
    resolvePeriodStartExplicit,
    resolveSheetMeta,
    calcLineTotal,
    normalizeLineInput,
    normalizeInvoiceKey,
    normalizeSupplierKey,
    findInvoiceWarnings,
    buildLineWarningsForDay,
    lineHasData,
    getDayMeta,
    listLines,
    buildReportPayload,
    saveDayCertification,
    saveFreightOverride,
    savePeriodStart,
    upsertDayMeta,
    saveLine,
    deleteLine,
    formatReportFilename,
    buildReportWorkbookBuffer,
    DATA_START_ROW,
    DATA_END_ROW,
    DEPT_COLS,
    FREIGHT_MONEY_KEYS,
    setCellNumber,
    setCellText,
    clearDataRows,
    writeLineToSheet,
};
