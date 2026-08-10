'use strict';

const { logManagerAudit } = require('../../lib/audit-log.cjs');
const { isManagerRole } = require('../../lib/staff-permissions.cjs');
const {
    buildReportPayload,
    buildReportWorkbookBuffer,
    deleteLine,
    saveLine,
    upsertDayMeta,
    resolvePeriodStart,
    findInvoiceWarnings,
    FREIGHT_MONEY_KEYS,
} = require('../../lib/edmonton-receiving-report.cjs');
const {
    saveOverflowAcknowledgement,
    saveDuplicateInvoiceExceptionAck,
} = require('../../lib/edmonton-receiving-integrity.cjs');
const { buildFullPeriodWorkbookBuffer } = require('../../lib/edmonton-receiving-workbook-export.cjs');
const { createReceivingGuards } = require('./receiving-helpers.cjs');

function bodyHasNegativeFreight(body = {}) {
    return FREIGHT_MONEY_KEYS.some((key) => {
        const raw = body[key];
        if (raw === undefined || raw === null || raw === '') return false;
        const n = Number(raw);
        return Number.isFinite(n) && n < 0;
    });
}

/**
 * Financial Log report routes — day.
 */
function registerReceivingReportDayRoutes(server, ctx) {
    const { wrap, fail, db, getStoreDateStamp } = ctx;
    const {
        guardPeriodEditable,
        requireFinancialLogSession,
        requireManagerOnly,
        requireFinancialLogAccess,
        requireFinancialAdmin,
    } = createReceivingGuards(ctx);

    server.get('/api/receiving/report', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const storeDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            res.json({ success: true, report: buildReportPayload(db, storeDate) });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load receiving report.');
        }
    }));

    server.put('/api/receiving/report/day', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(storeDate);
            const meta = upsertDayMeta(db, storeDate, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_day_save',
                targetType: 'receiving_report_day',
                targetId: storeDate,
                summary: `Updated receiving report header for ${storeDate}`,
                metadata: {
                    receiver_name: meta.receiver_name,
                    freight_total: meta.freight_total,
                    period_start: meta.period_start,
                },
            });
            res.json({ success: true, meta });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save receiving report day.');
        }
    }));

    server.post('/api/receiving/report/day/certify', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(storeDate);
            const { saveDayCertification } = require('../../lib/edmonton-receiving-report.cjs');
            const meta = saveDayCertification(db, storeDate, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_day_certify',
                targetType: 'receiving_report_day',
                targetId: storeDate,
                summary: `Certified receiving day ${storeDate}`,
                metadata: { certified: meta.certified },
            });
            res.json({ success: true, meta });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not certify receiving day.');
        }
    }));

    server.post('/api/receiving/report/day/freight-override', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(storeDate);
            const { saveFreightOverride } = require('../../lib/edmonton-receiving-report.cjs');
            const meta = saveFreightOverride(db, storeDate, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_freight_override',
                targetType: 'receiving_report_day',
                targetId: storeDate,
                summary: `Freight override for ${storeDate}`,
                metadata: { reason: b.reason || '' },
            });
            res.json({ success: true, meta });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not override freight reconciliation.');
        }
    }));

    server.post('/api/receiving/report/day/overflow-ack', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(storeDate);
            const meta = saveOverflowAcknowledgement(db, storeDate, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_overflow_ack',
                targetType: 'receiving_report_day',
                targetId: storeDate,
                summary: `Acknowledged overflow review for ${storeDate}`,
                metadata: {
                    reason: b.reason || '',
                    overflow_ack_line_count: meta.overflow_ack_line_count,
                },
            });
            res.json({ success: true, meta });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not acknowledge overflow review.');
        }
    }));

    server.post('/api/receiving/report/day/exception-ack', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        try {
            const periodStart = String(b.period_start || b.periodStart || '').trim();
            if (!periodStart) {
                fail(res, 400, 'period_start is required.');
                return;
            }
            guardPeriodEditable(periodStart);
            const ack = saveDuplicateInvoiceExceptionAck(db, {
                periodStart,
                exceptionKey: b.exception_key || b.exceptionKey,
                reason: b.reason,
                lineIds: b.line_ids || b.lineIds || [],
            }, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_exception_ack',
                targetType: 'receiving_report_exception_acks',
                targetId: ack.ack_id,
                summary: `Acknowledged duplicate invoice exception ${ack.exception_key}`,
                metadata: {
                    period_start: ack.period_start,
                    exception_key: ack.exception_key,
                    line_ids: ack.line_ids,
                    reason: ack.reason,
                },
            });
            res.json({ success: true, ack });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not acknowledge exception.');
        }
    }));

    server.post('/api/receiving/report/lines', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(storeDate);
            let saveOpts = {};
            if (bodyHasNegativeFreight(b)) {
                if (!isManagerRole(session.role)) {
                    fail(res, 403, 'Negative freight requires a manager-authorized exception.');
                    return;
                }
                const negativeFreightReason = String(b.negative_freight_reason || '').trim();
                if (!negativeFreightReason) {
                    fail(res, 400, 'negative_freight_reason is required for negative freight.');
                    return;
                }
                saveOpts = {
                    allowNegativeFreight: true,
                    negativeFreightReason,
                };
            }
            const line = saveLine(db, storeDate, b, session.name, saveOpts);
            const periodStart = resolvePeriodStart(db, storeDate);
            const warnings = findInvoiceWarnings(db, periodStart, {
                lineId: line.line_id,
                storeDate,
                invoiceNumber: line.invoice_number,
                supplierName: line.supplier_name,
            });
            logManagerAudit(db, {
                req,
                session,
                action: b.line_id ? 'receiving_report_line_update' : 'receiving_report_line_create',
                targetType: 'receiving_report_lines',
                targetId: line.line_id,
                summary: `Saved receiving report line ${line.invoice_number || line.supplier_name || line.line_id} for ${storeDate}`,
                metadata: {
                    store_date: storeDate,
                    total_invoice: line.total_invoice,
                    warnings,
                    negative_freight: !!saveOpts.allowNegativeFreight,
                },
            });
            res.json({ success: true, line, warnings });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save receiving report line.');
        }
    }));

    server.delete('/api/receiving/report/lines/:lineId', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        try {
            const existing = db.get('SELECT store_date FROM receiving_report_lines WHERE line_id=?', req.params.lineId);
            if (existing?.store_date) guardPeriodEditable(existing.store_date);
            const result = deleteLine(db, req.params.lineId, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_line_delete',
                targetType: 'receiving_report_lines',
                targetId: req.params.lineId,
                summary: `Deleted receiving report line ${req.params.lineId}`,
            });
            res.json(result);
        } catch (e) {
            fail(res, e.status || 404, e.message || 'Could not delete receiving report line.');
        }
    }));

    server.get('/api/export/edmonton-receiving-report', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const storeDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const { buffer, filename, payload } = await buildReportWorkbookBuffer(db, storeDate);
            logManagerAudit(db, {
                req,
                session,
                action: 'export_edmonton_receiving_report',
                targetType: 'report',
                targetId: storeDate,
                summary: `Exported Edmonton receiving report for ${storeDate}`,
                metadata: {
                    filename,
                    line_count: payload.lines.length,
                    sheet_name: payload.sheet_name,
                },
            });
            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            );
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(Buffer.from(buffer));
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not export receiving report.');
        }
    }));

    server.get('/api/export/edmonton-receiving-report-period', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const { buffer, filename, period_start, daily_sheets_written, invoice_count } =
                await buildFullPeriodWorkbookBuffer(db, anchorDate);
            logManagerAudit(db, {
                req,
                session,
                action: 'export_edmonton_receiving_report_period',
                targetType: 'report',
                targetId: period_start,
                summary: `Exported full Edmonton receiving workbook for period ${period_start}`,
                metadata: {
                    filename,
                    daily_sheets_written,
                    invoice_count,
                },
            });
            res.setHeader(
                'Content-Type',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            );
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(Buffer.from(buffer));
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not export full receiving workbook.');
        }
    }));
}

module.exports = { registerReceivingReportDayRoutes };
