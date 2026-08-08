'use strict';

/**
 * Shared receiving-day financial integrity helpers (5.4.7).
 * Authoritative freight reconciliation, certification gates, invalidation.
 */

const crypto = require('crypto');
const { roundMoney } = require('./parse-money.cjs');
const {
    reconcileDayFreight,
    freightReconBlocksClose,
    readFreightTolerance,
    FREIGHT_DEPT_KEYS,
} = require('./edmonton-receiving-costing.cjs');

const PAGE_SIZE = 50;

function normalizeInvoiceKey(value) {
    return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeSupplierKey(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/\b(FOODS?|LTD|LIMITED|INC|LLC|CORP(?:ORATION)?|CO|COMPANY)\b/g, '')
        .replace(/[^A-Z0-9]/g, '');
}

function dayLines(db, storeDate) {
    return db.all(
        `SELECT * FROM receiving_report_lines
          WHERE store_date=?
          ORDER BY sort_order ASC, created_at ASC, line_id ASC`,
        storeDate,
    ) || [];
}

function lineFreightSum(row) {
    return roundMoney(FREIGHT_DEPT_KEYS.reduce((sum, key) => sum + Number(row[`freight_${key}`] || 0), 0));
}

function computeEnteredFreight(lines) {
    return roundMoney(
        (lines || []).reduce((sum, line) => {
            const kind = String(line.line_kind || 'invoice').toLowerCase();
            if (kind !== 'invoice') return sum;
            return sum + lineFreightSum(line);
        }, 0),
    );
}

function hasValidFreightOverride(db, storeDate, dayRow) {
    if (!dayRow) return false;
    const status = String(dayRow.freight_recon_status || '').toUpperCase();
    const reason = String(dayRow.freight_override_reason || '').trim();
    const by = String(dayRow.freight_override_by || '').trim();
    const at = dayRow.freight_override_at;
    const fingerprint = String(dayRow.freight_override_fingerprint || '').trim();
    // Overrides created before 058 are intentionally stale. A close cannot accept
    // an override that was not tied to the exact reviewed financial content.
    return status === 'OVERRIDE'
        && !!reason
        && !!by
        && !!at
        && !!fingerprint
        && fingerprint === dayContentFingerprint(db, storeDate);
}

/**
 * Authoritative live reconciliation for one store day.
 */
function computeDayFreightReconciliation(db, storeDate, dayRow = null, lines = null) {
    const date = String(storeDate || '').trim();
    const row = dayRow || db.get('SELECT * FROM receiving_report_day WHERE store_date=?', date);
    const dayLinesRows = lines || dayLines(db, date);
    const entered = computeEnteredFreight(dayLinesRows);
    const expected = row?.freight_total == null ? null : roundMoney(row.freight_total);
    const tolerance = row?.freight_tolerance != null
        ? Number(row.freight_tolerance)
        : readFreightTolerance(db);
    const override = hasValidFreightOverride(db, date, row);
    const reconciliation = reconcileDayFreight({
        expected,
        entered,
        tolerance,
        override,
    });
    return {
        ...reconciliation,
        override_reason: row?.freight_override_reason || '',
        override_by: row?.freight_override_by || '',
        override_at: row?.freight_override_at || null,
        line_count: dayLinesRows.length,
    };
}

/**
 * Persist recon cache columns. Close readiness must still recompute live.
 */
function persistDayFreightReconciliation(db, storeDate) {
    const date = String(storeDate || '').trim();
    const row = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', date);
    if (!row) return null;
    const recon = computeDayFreightReconciliation(db, date, row);
    const statusToStore = recon.status === 'OVERRIDE' && hasValidFreightOverride(db, date, row)
        ? 'OVERRIDE'
        : recon.status;
    try {
        db.run(
            `UPDATE receiving_report_day
                SET freight_recon_status=?,
                    freight_recon_entered=?,
                    freight_recon_difference=?,
                    freight_expected_entered=?,
                    overflow_line_count=?,
                    updated_at=?
              WHERE store_date=?`,
            statusToStore,
            recon.entered,
            recon.difference,
            recon.expected == null ? 0 : 1,
            Math.max(0, Number(recon.line_count || 0)),
            new Date().toISOString(),
            date,
        );
    } catch (_) {
        // Older schema before 057 — still try status-only
        try {
            db.run(
                `UPDATE receiving_report_day SET freight_recon_status=?, updated_at=? WHERE store_date=?`,
                statusToStore,
                new Date().toISOString(),
                date,
            );
        } catch (err) {
            throw err;
        }
    }
    return recon;
}

function dayContentFingerprint(db, storeDate) {
    const date = String(storeDate || '').trim();
    const row = db.get('SELECT receiver_name, freight_total FROM receiving_report_day WHERE store_date=?', date);
    const lines = dayLines(db, date).map((l) => ({
        line_id: l.line_id,
        kind: l.line_kind,
        inv: l.invoice_number,
        sup: l.supplier_name,
        grocery: l.grocery,
        tobacco: l.tobacco,
        meat: l.meat,
        bakery: l.bakery,
        bakery_in_store: l.bakery_in_store,
        deli: l.deli,
        produce: l.produce,
        produce_shrink: l.produce_shrink,
        dairy: l.dairy,
        pharmacy: l.pharmacy,
        gst: l.gst,
        freight_grocery: l.freight_grocery,
        freight_tobacco: l.freight_tobacco,
        freight_meat: l.freight_meat,
        freight_bakery: l.freight_bakery,
        freight_bakery_in_store: l.freight_bakery_in_store,
        freight_deli: l.freight_deli,
        freight_produce: l.freight_produce,
        freight_dairy: l.freight_dairy,
        freight_pharmacy: l.freight_pharmacy,
    }));
    return crypto.createHash('sha256').update(JSON.stringify({
        receiver: row?.receiver_name || '',
        freight_total: row?.freight_total == null ? null : Number(row.freight_total),
        lines,
    })).digest('hex');
}

function clearCertification(db, storeDate) {
    const date = String(storeDate || '').trim();
    try {
        db.run(
            `UPDATE receiving_report_day SET
                cert_receiving_complete=0, cert_invoices_entered=0, cert_references_verified=0,
                cert_freight_verified=0, cert_receiver_identified=0, cert_exceptions_documented=0,
                certified_at=NULL, certified_by='', cert_content_fingerprint='',
                updated_at=?
              WHERE store_date=?`,
            new Date().toISOString(),
            date,
        );
    } catch (_) {
        try {
            db.run(
                `UPDATE receiving_report_day SET
                    cert_receiving_complete=0, cert_invoices_entered=0, cert_references_verified=0,
                    cert_freight_verified=0, cert_receiver_identified=0, cert_exceptions_documented=0,
                    certified_at=NULL, certified_by='', updated_at=?
                  WHERE store_date=?`,
                new Date().toISOString(),
                date,
            );
        } catch (err) {
            /* pre-056 */
        }
    }
}

function clearFreightOverride(db, storeDate) {
    const date = String(storeDate || '').trim();
    try {
        db.run(
            `UPDATE receiving_report_day SET
                freight_override_reason='', freight_override_by='', freight_override_at=NULL,
                freight_override_fingerprint='',
                updated_at=?
              WHERE store_date=?`,
            new Date().toISOString(),
            date,
        );
    } catch (_) {
        // 5.4.7 databases do not receive the fingerprint column until migration 058.
        db.run(
            `UPDATE receiving_report_day SET
                freight_override_reason='', freight_override_by='', freight_override_at=NULL,
                updated_at=?
              WHERE store_date=?`,
            new Date().toISOString(),
            date,
        );
    }
}

/**
 * After edits that affect money/refs/freight: drop cert + override, refresh recon cache.
 */
function invalidateDayFinancialState(db, storeDate, { clearOverride = true } = {}) {
    const date = String(storeDate || '').trim();
    const existing = db.get('SELECT store_date FROM receiving_report_day WHERE store_date=?', date);
    if (!existing) return null;
    // A partial certification is still a financial review in progress. Never retain
    // any self-declared flag after an invoice, reference, or amount changes.
    clearCertification(db, date);
    if (clearOverride) clearFreightOverride(db, date);
    try {
        db.run(
            `UPDATE receiving_report_day SET
                overflow_acknowledged_at=NULL,
                overflow_acknowledged_by='',
                overflow_ack_reason='',
                overflow_ack_line_count=NULL
              WHERE store_date=?`,
            date,
        );
    } catch (_) { /* overflow controls were added after the original report schema */ }
    return persistDayFreightReconciliation(db, date);
}

function listDuplicateInvoiceGroups(db, periodStart, periodEnd) {
    const rows = db.all(
        `SELECT store_date, line_id, supplier_name, invoice_number
           FROM receiving_report_lines
          WHERE store_date>=? AND store_date<=?
            AND COALESCE(NULLIF(TRIM(line_kind), ''), 'invoice')='invoice'
            AND TRIM(invoice_number)!='' AND TRIM(supplier_name)!=''`,
        periodStart,
        periodEnd,
    ) || [];
    const groups = new Map();
    rows.forEach((row) => {
        const key = `${normalizeSupplierKey(row.supplier_name)}|${normalizeInvoiceKey(row.invoice_number)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
    });
    return [...groups.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([key, list]) => {
            const lineIds = list.map((row) => row.line_id).sort();
            const [supplierKey, invoiceKey] = key.split('|');
            return {
                key,
                supplier_key: supplierKey,
                invoice_key: invoiceKey,
                lines: list,
                line_ids: lineIds,
                count: list.length,
                group_fingerprint: crypto.createHash('sha256')
                    .update(JSON.stringify({ supplierKey, invoiceKey, lineIds }))
                    .digest('hex'),
            };
        });
}

function listAcknowledgedExceptionGroups(db, periodStart) {
    try {
        return new Map(
            (db.all(
                `SELECT exception_key, group_fingerprint, line_ids_json, line_count
                   FROM receiving_report_exception_acks
                  WHERE period_start=? AND exception_type='duplicate_invoice'`,
                periodStart,
            ) || []).map((r) => [String(r.exception_key || ''), r]),
        );
    } catch (_) {
        return new Map();
    }
}

function unresolvedDuplicateGroups(db, periodStart, periodEnd) {
    const acks = listAcknowledgedExceptionGroups(db, periodStart);
    return listDuplicateInvoiceGroups(db, periodStart, periodEnd)
        .filter((g) => {
            const ack = acks.get(g.key);
            if (!ack) return true;
            const ackIds = (() => {
                try { return JSON.parse(ack.line_ids_json || '[]').map(String).sort(); } catch (_) { return []; }
            })();
            return String(ack.group_fingerprint || '') !== g.group_fingerprint
                || Number(ack.line_count || 0) !== g.count
                || JSON.stringify(ackIds) !== JSON.stringify(g.line_ids);
        });
}

function isOverflowAcknowledged(dayRow, lineCount) {
    if (!dayRow) return lineCount <= PAGE_SIZE;
    if (lineCount <= PAGE_SIZE) return true;
    const ackAt = dayRow.overflow_acknowledged_at;
    const ackCount = dayRow.overflow_ack_line_count;
    const reason = String(dayRow.overflow_ack_reason || '').trim();
    const by = String(dayRow.overflow_acknowledged_by || '').trim();
    if (!ackAt || !reason || !by) return false;
    return Number(ackCount) === Number(lineCount);
}

function evaluateCertificationEligibility(db, storeDate, opts = {}) {
    const date = String(storeDate || '').trim();
    const row = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', date);
    const lines = dayLines(db, date);
    const invoiceLines = lines.filter((l) => String(l.line_kind || 'invoice') === 'invoice');
    const recon = computeDayFreightReconciliation(db, date, row, lines);
    const problems = [];

    if (!String(row?.receiver_name || '').trim()) {
        problems.push({ code: 'receiver_missing', message: 'Receiver name is required.' });
    }
    if (row?.freight_total == null) {
        problems.push({ code: 'freight_expected_missing', message: 'Expected invoice freight must be entered (use 0 if none).' });
    }
    if (freightReconBlocksClose(recon)) {
        problems.push({
            code: 'freight_unreconciled',
            message: `Freight reconciliation is ${recon.status} (expected ${recon.expected}, entered ${recon.entered}, diff ${recon.difference}).`,
        });
    }
    invoiceLines.forEach((line) => {
        if (!String(line.supplier_name || '').trim() || !String(line.invoice_number || '').trim()) {
            problems.push({
                code: 'reference_missing',
                message: `Line ${line.line_id} is missing supplier or invoice reference.`,
                line_id: line.line_id,
            });
        }
    });
    if (lines.length > PAGE_SIZE && !isOverflowAcknowledged(row, lines.length)) {
        problems.push({
            code: 'overflow_unacknowledged',
            message: `Day has ${lines.length} lines — manager overflow review acknowledgement required.`,
        });
    }

    const periodStart = String(opts.periodStart || '').trim();
    const periodEnd = String(opts.periodEnd || '').trim();
    if (periodStart && periodEnd) {
        const dups = unresolvedDuplicateGroups(db, periodStart, periodEnd)
            .filter((g) => g.lines.some((l) => l.store_date === date));
        if (dups.length) {
            problems.push({
                code: 'duplicate_unresolved',
                message: `${dups.length} duplicate supplier/invoice group(s) need manager acknowledgement.`,
                duplicates: dups,
            });
        }
    }

    return {
        ok: problems.length === 0,
        problems,
        reconciliation: recon,
        line_count: lines.length,
        fingerprint: dayContentFingerprint(db, date),
    };
}

function writeFinancialAudit(db, {
    periodStart = '',
    storeDate = '',
    eventType,
    actorName = '',
    reason = '',
    detail = {},
}) {
    const now = new Date().toISOString();
    db.run(
        `INSERT INTO receiving_report_financial_audit (
            audit_id, period_start, store_date, event_type, actor_name, reason, detail_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        periodStart || '',
        storeDate || '',
        eventType,
        actorName || '',
        reason || '',
        JSON.stringify(detail || {}),
        now,
    );
}

function writeCloseOutbox(db, {
    periodStart, eventType, eventId = '', payload = {},
}) {
    const now = new Date().toISOString();
    const stableEventId = String(eventId || `${periodStart}:${eventType}`).trim();
    db.run(
        `INSERT INTO receiving_report_close_audit_outbox (
            outbox_id, period_start, event_type, event_id, payload_json, created_at, flushed_at
         ) VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(event_id) WHERE event_id != '' DO NOTHING`,
        crypto.randomUUID(),
        periodStart,
        eventType,
        stableEventId,
        JSON.stringify(payload),
        now,
    );
    return stableEventId;
}

function flushCloseAuditOutbox(db, periodStart, { req, session, logManagerAudit: auditFn } = {}) {
    const start = String(periodStart || '').trim();
    if (!start) return { flushed: 0, failed: 0, pending: 0 };
    const flush = () => {
        const rows = db.all(
            `SELECT * FROM receiving_report_close_audit_outbox
              WHERE period_start=? AND flushed_at IS NULL
              ORDER BY created_at ASC`,
            start,
        ) || [];
        const logger = typeof auditFn === 'function'
            ? auditFn
            : require('./audit-log.cjs').logManagerAudit;
        const now = new Date().toISOString();
        let flushed = 0;
        let failed = 0;
        rows.forEach((row) => {
            let payload = {};
            try {
                payload = JSON.parse(row.payload_json || '{}') || {};
            } catch (_) {
                payload = {};
            }
            let ok = false;
            try {
                ok = logger(db, {
                    req,
                    session,
                    actorName: payload.actor || '',
                    action: row.event_type,
                    targetType: 'receiving_report_period_status',
                    targetId: start,
                    summary: payload.summary || `Close outbox: ${row.event_type} for ${start}`,
                    metadata: { ...payload, close_event_id: row.event_id || row.outbox_id },
                    eventId: row.event_id || row.outbox_id,
                }) === true;
            } catch (_) {
                ok = false;
            }
            if (!ok) {
                failed += 1;
                return;
            }
            const durable = db.get(
                'SELECT id FROM manager_audit_log WHERE source_event_id=?',
                row.event_id || row.outbox_id,
            );
            if (!durable) {
                failed += 1;
                return;
            }
            db.run(
                `UPDATE receiving_report_close_audit_outbox
                    SET flushed_at=?
                  WHERE outbox_id=? AND flushed_at IS NULL`,
                now,
                row.outbox_id,
            );
            flushed += 1;
        });
        return { flushed, failed, pending: failed };
    };
    return typeof db.transaction === 'function' ? db.transaction(flush)() : flush();
}

function flushAllCloseAuditOutbox(db, opts = {}) {
    const periods = db.all(
        `SELECT DISTINCT period_start
           FROM receiving_report_close_audit_outbox
          WHERE flushed_at IS NULL
          ORDER BY period_start`,
    ) || [];
    return periods.reduce((total, row) => {
        const result = flushCloseAuditOutbox(db, row.period_start, opts);
        total.flushed += result.flushed;
        total.failed += result.failed;
        total.pending += result.pending;
        return total;
    }, { flushed: 0, failed: 0, pending: 0 });
}

function saveOverflowAcknowledgement(db, storeDate, payload = {}, actorName = '') {
    const date = String(storeDate || '').trim();
    if (!date) {
        const err = new Error('store_date is required.');
        err.status = 400;
        throw err;
    }
    const reason = String(payload.reason || '').trim();
    if (!reason) {
        const err = new Error('A manager reason is required to acknowledge overflow review.');
        err.status = 400;
        throw err;
    }
    const lines = dayLines(db, date);
    const lineCount = lines.length;
    if (lineCount <= PAGE_SIZE) {
        const err = new Error(`Day ${date} has ${lineCount} lines and does not require overflow acknowledgement.`);
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    const existing = db.get('SELECT store_date FROM receiving_report_day WHERE store_date=?', date);
    if (!existing) {
        db.run(
            `INSERT INTO receiving_report_day (store_date, receiver_name, freight_total, updated_at, updated_by)
             VALUES (?, '', NULL, ?, ?)`,
            date, now, actorName || '',
        );
    }
    db.run(
        `UPDATE receiving_report_day
            SET overflow_acknowledged_at=?,
                overflow_acknowledged_by=?,
                overflow_ack_reason=?,
                overflow_ack_line_count=?,
                overflow_line_count=?,
                updated_at=?, updated_by=?
          WHERE store_date=?`,
        now,
        actorName || '',
        reason,
        lineCount,
        lineCount,
        now,
        actorName || '',
        date,
    );
    try {
        writeFinancialAudit(db, {
            periodStart: require('./edmonton-receiving-report.cjs').resolvePeriodStart(db, date),
            storeDate: date,
            eventType: 'overflow_acknowledged',
            actorName,
            reason,
            detail: { line_count: lineCount },
        });
    } catch (_) { /* audit optional */ }
    const row = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', date);
    return {
        store_date: date,
        overflow_acknowledged_at: row.overflow_acknowledged_at,
        overflow_acknowledged_by: row.overflow_acknowledged_by || '',
        overflow_ack_reason: row.overflow_ack_reason || '',
        overflow_ack_line_count: row.overflow_ack_line_count,
        line_count: lineCount,
    };
}

function saveDuplicateInvoiceExceptionAck(db, payload = {}, actorName = '') {
    const periodStart = String(payload.periodStart || payload.period_start || '').trim();
    const exceptionKey = String(payload.exceptionKey || payload.exception_key || '').trim();
    const reason = String(payload.reason || '').trim();
    const lineIds = Array.isArray(payload.lineIds || payload.line_ids)
        ? [...new Set((payload.lineIds || payload.line_ids).map((id) => String(id || '').trim()).filter(Boolean))]
        : [];
    if (!periodStart) {
        const err = new Error('period_start is required.');
        err.status = 400;
        throw err;
    }
    if (!exceptionKey) {
        const err = new Error('exception_key is required.');
        err.status = 400;
        throw err;
    }
    if (!reason) {
        const err = new Error('A manager reason is required to acknowledge a duplicate invoice exception.');
        err.status = 400;
        throw err;
    }
    if (!lineIds.length) {
        const err = new Error('line_ids must identify every affected line.');
        err.status = 400;
        throw err;
    }
    const { addDays } = require('./edmonton-receiving-report.cjs');
    const group = listDuplicateInvoiceGroups(db, periodStart, addDays(periodStart, 34))
        .find((candidate) => candidate.key === exceptionKey);
    if (!group) {
        const err = new Error('Duplicate invoice group no longer exists or exception_key is incorrect.');
        err.status = 400;
        throw err;
    }
    const submittedIds = [...lineIds].sort();
    if (JSON.stringify(submittedIds) !== JSON.stringify(group.line_ids)) {
        const err = new Error('line_ids must exactly match every current line in the duplicate group.');
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    const ackId = crypto.randomUUID();
    const storeDate = (() => {
        try {
            const row = db.get(
                'SELECT store_date FROM receiving_report_lines WHERE line_id=?',
                lineIds[0],
            );
            return row?.store_date || '';
        } catch (_) {
            return '';
        }
    })();
    db.run(
        `INSERT INTO receiving_report_exception_acks (
            ack_id, period_start, store_date, exception_type, exception_key,
            group_fingerprint, supplier_key, invoice_key, line_ids_json, line_count,
            actor_name, reason, created_at
         ) VALUES (?, ?, ?, 'duplicate_invoice', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ackId,
        periodStart,
        storeDate,
        exceptionKey,
        group.group_fingerprint,
        group.supplier_key,
        group.invoice_key,
        JSON.stringify(group.line_ids),
        group.count,
        actorName || '',
        reason,
        now,
    );
    try {
        writeFinancialAudit(db, {
            periodStart,
            storeDate,
            eventType: 'duplicate_invoice_acknowledged',
            actorName,
            reason,
            detail: {
                exception_key: exceptionKey,
                group_fingerprint: group.group_fingerprint,
                line_ids: group.line_ids,
                ack_id: ackId,
            },
        });
    } catch (_) { /* audit optional */ }
    return {
        ack_id: ackId,
        period_start: periodStart,
        store_date: storeDate,
        exception_type: 'duplicate_invoice',
        exception_key: exceptionKey,
        line_ids: group.line_ids,
        reason,
        actor_name: actorName || '',
        created_at: now,
    };
}

module.exports = {
    PAGE_SIZE,
    normalizeInvoiceKey,
    normalizeSupplierKey,
    dayLines,
    lineFreightSum,
    computeEnteredFreight,
    hasValidFreightOverride,
    computeDayFreightReconciliation,
    persistDayFreightReconciliation,
    dayContentFingerprint,
    clearCertification,
    clearFreightOverride,
    invalidateDayFinancialState,
    listDuplicateInvoiceGroups,
    unresolvedDuplicateGroups,
    isOverflowAcknowledged,
    evaluateCertificationEligibility,
    writeFinancialAudit,
    writeCloseOutbox,
    flushCloseAuditOutbox,
    flushAllCloseAuditOutbox,
    saveOverflowAcknowledgement,
    saveDuplicateInvoiceExceptionAck,
    freightReconBlocksClose,
};
