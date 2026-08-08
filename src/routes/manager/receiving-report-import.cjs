'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { logManagerAudit } = require('../../lib/audit-log.cjs');
const {
    scanReceivingDocument,
    commitReceivingImport,
} = require('../../lib/receiving-invoice-import.cjs');
const { importWorkbookToDb } = require('../../lib/edmonton-receiving-workbook-import.cjs');
const { buildReportPayload } = require('../../lib/edmonton-receiving-report.cjs');
const { createReceivingGuards } = require('./receiving-helpers.cjs');

/**
 * Financial Log report routes — import.
 */
function registerReceivingReportImportRoutes(server, ctx) {
    const { wrap, fail, db, getStoreDateStamp, broadcastUpdate } = ctx;
    const { guardPeriodEditable, requireFinancialAdmin } = createReceivingGuards(ctx);

    server.post('/api/receiving/report/import-workbook', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const contentBase64 = String(b.contentBase64 || b.content_base64 || '').trim();
        if (!contentBase64) {
            fail(res, 400, 'contentBase64 is required.');
            return;
        }
        const replacePeriod = !!(b.replace_period ?? b.replacePeriod);
        const fillSales = b.fill_sales ?? b.fillSales;
        const dryRun = !!(b.dry_run ?? b.dryRun);
        const ratePercent = b.rate_percent ?? b.ratePercent ?? b.period_freight_rate_percent;
        const tmpPath = path.join(os.tmpdir(), `ewm-import-${Date.now()}.xlsx`);
        try {
            fs.writeFileSync(tmpPath, Buffer.from(contentBase64, 'base64'));
            if (!dryRun) {
                const preview = await importWorkbookToDb(db, tmpPath, {
                    replacePeriod,
                    fillSales: fillSales === true,
                    dryRun: true,
                    actor: session.name,
                    rate_percent: ratePercent,
                });
                if (replacePeriod && preview.period_start) {
                    guardPeriodEditable(preview.period_start);
                }
            }
            const summary = await importWorkbookToDb(db, tmpPath, {
                replacePeriod,
                fillSales: fillSales === true,
                dryRun,
                actor: session.name,
                rate_percent: ratePercent,
            });
            if (!dryRun) {
                logManagerAudit(db, {
                    req,
                    session,
                    action: 'import_edmonton_receiving_workbook',
                    targetType: 'report',
                    targetId: summary.period_start,
                    summary: `Imported Edmonton workbook for period ${summary.period_start}`,
                    metadata: summary,
                });
                if (typeof broadcastUpdate === 'function') {
                    broadcastUpdate({ table: 'receiving_report', action: 'import', data: summary });
                }
            }
            res.json({ success: true, summary });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not import workbook.');
        } finally {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
        }
    }));

    server.post('/api/receiving/report/import-scan', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        try {
            const result = await scanReceivingDocument(b.filename, b.contentBase64, {
                doc_type: b.doc_type || 'auto',
            });
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not scan receiving document.');
        }
    }));

    server.post('/api/receiving/report/import-commit', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(storeDate);
            const result = commitReceivingImport(db, storeDate, {
                ...b,
                filename: b.filename,
                doc_type: b.doc_type,
                invoice: b.invoice || b.invoice_candidate,
                shrink_lines: b.shrink_lines || b.shrink_candidates,
                ocr_chars: String(b.ocrText || b.ocr_text || '').length,
            }, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_import_commit',
                targetType: 'receiving_report_lines',
                targetId: result.line?.line_id || storeDate,
                summary: `Imported receiving PDF for ${storeDate}`,
                metadata: {
                    filename: b.filename,
                    shrink_count: result.shrink_lines?.length || 0,
                    invoice_number: result.line?.invoice_number || '',
                },
            });
            res.json({
                success: true,
                report: buildReportPayload(db, storeDate),
                ...result,
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not import receiving document.');
        }
    }));
}

module.exports = { registerReceivingReportImportRoutes };
