'use strict';

const { logManagerAudit } = require('../../lib/audit-log.cjs');
const {
    listShrinkLines,
    saveShrinkLine,
    deleteShrinkLine,
    buildShrinkSummary,
} = require('../../lib/receiving-invoice-import.cjs');
const {
    buildSalesGrid,
    saveSalesAmount,
    buildReceivingTotalsPayload,
    buildMarginPayload,
    saveMarginMeta,
    buildTotalReportPayload,
} = require('../../lib/edmonton-receiving-analytics.cjs');
const {
    saveDeptMarginMeta,
    saveRebateLine,
    deleteRebateLine,
    saveRecount,
    deleteRecount,
} = require('../../lib/edmonton-receiving-extended.cjs');
const { createReceivingGuards } = require('./receiving-helpers.cjs');

/**
 * Financial Log report routes — sheets.
 */
function registerReceivingReportSheetRoutes(server, ctx) {
    const { wrap, fail, db, getStoreDateStamp } = ctx;
    const {
        guardPeriodEditable,
        requireFinancialLogSession,
        requireFinancialAdmin,
        requireManagerOnly,
        requireFinancialLogAccess,
    } = createReceivingGuards(ctx);

    server.get('/api/receiving/report/total-report', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const total_report = buildTotalReportPayload(db, anchorDate);
            res.json({ success: true, total_report });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load total report.');
        }
    }));

    server.get('/api/receiving/report/shrink', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const storeDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const lines = listShrinkLines(db, storeDate);
            res.json({
                success: true,
                store_date: storeDate,
                shrink_lines: lines,
                shrink_summary: buildShrinkSummary(lines),
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load shrink lines.');
        }
    }));

    server.post('/api/receiving/report/shrink-lines', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(storeDate);
            const line = saveShrinkLine(db, storeDate, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: b.shrink_id ? 'receiving_report_shrink_update' : 'receiving_report_shrink_create',
                targetType: 'receiving_shrink_lines',
                targetId: line.shrink_id,
                summary: `Saved shrink line for ${storeDate}`,
                metadata: { store_date: storeDate, sku: line.sku, amount: line.amount },
            });
            res.json({ success: true, line, shrink_summary: buildShrinkSummary(listShrinkLines(db, storeDate)) });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save shrink line.');
        }
    }));

    server.delete('/api/receiving/report/shrink-lines/:shrinkId', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        try {
            const existing = db.get('SELECT store_date FROM receiving_shrink_lines WHERE shrink_id=?', req.params.shrinkId);
            if (existing?.store_date) guardPeriodEditable(existing.store_date);
            const result = deleteShrinkLine(db, req.params.shrinkId);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_shrink_delete',
                targetType: 'receiving_shrink_lines',
                targetId: req.params.shrinkId,
                summary: `Deleted shrink line ${req.params.shrinkId}`,
                metadata: { store_date: existing?.store_date || null },
            });
            res.json(result);
        } catch (e) {
            fail(res, e.status || 404, e.message || 'Could not delete shrink line.');
        }
    }));

    server.get('/api/receiving/report/sales', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const sales = buildSalesGrid(db, anchorDate);
            res.json({ success: true, sales });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load sales numbers.');
        }
    }));

    server.put('/api/receiving/report/sales', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(periodStart);
            const sales = saveSalesAmount(
                db,
                periodStart,
                b.week_num ?? b.weekNum,
                b.category_key ?? b.categoryKey,
                b.amount,
                session.name,
            );
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_sales_save',
                targetType: 'receiving_report_sales',
                targetId: `${periodStart}:${b.week_num}:${b.category_key}`,
                summary: `Updated sales ${b.category_key} week ${b.week_num} for period ${periodStart}`,
            });
            res.json({ success: true, sales });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save sales amount.');
        }
    }));

    server.post('/api/receiving/report/sales/confirm-zero', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(periodStart);
            const { saveSalesZeroConfirm } = require('../../lib/edmonton-receiving-analytics.cjs');
            const confirmation = saveSalesZeroConfirm(
                db,
                periodStart,
                b.category_key ?? b.categoryKey ?? '__week__',
                b.week_num ?? b.weekNum,
                session.name,
                b.reason,
            );
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_sales_zero_confirm',
                targetType: 'receiving_report_sales_zero_confirm',
                targetId: `${periodStart}:${confirmation.category_key}:${confirmation.week_number}`,
                summary: `Confirmed remaining sales blanks as zero for week ${confirmation.week_number}`,
                metadata: { reason: confirmation.reason },
            });
            res.json({ success: true, confirmation });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not confirm sales zero.');
        }
    }));

    server.get('/api/receiving/report/receiving-totals', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const receiving_totals = buildReceivingTotalsPayload(db, anchorDate);
            res.json({ success: true, receiving_totals });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load receiving totals.');
        }
    }));

    server.get('/api/receiving/report/margin', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const margin = buildMarginPayload(db, anchorDate);
            res.json({ success: true, margin });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load margin dashboard.');
        }
    }));

    server.put('/api/receiving/report/margin', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(periodStart);
            const margin = saveMarginMeta(db, periodStart, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_margin_save',
                targetType: 'receiving_report_margin',
                targetId: periodStart,
                summary: `Updated margin dashboard for period ${periodStart}`,
            });
            res.json({ success: true, margin });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save margin dashboard.');
        }
    }));

    server.put('/api/receiving/report/dept-margin', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        const department = String(b.department || b.dept || '').trim();
        try {
            guardPeriodEditable(periodStart);
            const margin = saveDeptMarginMeta(db, periodStart, department, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_dept_margin_save',
                targetType: 'receiving_report_dept_margin',
                targetId: `${periodStart}:${department}`,
                summary: `Updated ${department} margin for period ${periodStart}`,
            });
            res.json({ success: true, margin });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save department margin.');
        }
    }));

    server.post('/api/receiving/report/rebate-lines', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(periodStart);
            const line = saveRebateLine(db, periodStart, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: b.rebate_id ? 'receiving_report_rebate_update' : 'receiving_report_rebate_create',
                targetType: 'receiving_report_rebate_lines',
                targetId: line.rebate_id,
                summary: `Saved rebate line for period ${periodStart}`,
                metadata: { invoice_number: line.invoice_number, supplier_name: line.supplier_name },
            });
            res.json({ success: true, line });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save rebate line.');
        }
    }));

    server.delete('/api/receiving/report/rebate-lines/:rebateId', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        try {
            const existing = db.get(
                'SELECT period_start, invoice_number FROM receiving_report_rebate_lines WHERE rebate_id=?',
                req.params.rebateId,
            );
            if (existing?.period_start) guardPeriodEditable(existing.period_start);
            const result = deleteRebateLine(db, req.params.rebateId);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_rebate_delete',
                targetType: 'receiving_report_rebate_lines',
                targetId: req.params.rebateId,
                summary: `Deleted rebate line ${req.params.rebateId}`,
                metadata: { period_start: existing?.period_start || null },
            });
            res.json(result);
        } catch (e) {
            fail(res, e.status || 404, e.message || 'Could not delete rebate line.');
        }
    }));

    server.post('/api/receiving/report/recounts', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(periodStart);
            const row = saveRecount(db, periodStart, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: b.recount_id ? 'receiving_report_recount_update' : 'receiving_report_recount_create',
                targetType: 'receiving_report_recounts',
                targetId: row.recount_id,
                summary: `Saved recount ${row.location || row.recount_id} for period ${periodStart}`,
            });
            res.json({ success: true, row });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save recount.');
        }
    }));

    server.delete('/api/receiving/report/recounts/:recountId', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        try {
            const existing = db.get(
                'SELECT period_start, location FROM receiving_report_recounts WHERE recount_id=?',
                req.params.recountId,
            );
            if (existing?.period_start) guardPeriodEditable(existing.period_start);
            const result = deleteRecount(db, req.params.recountId);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_recount_delete',
                targetType: 'receiving_report_recounts',
                targetId: req.params.recountId,
                summary: `Deleted recount ${existing?.location || req.params.recountId}`,
                metadata: { period_start: existing?.period_start || null },
            });
            res.json(result);
        } catch (e) {
            fail(res, e.status || 404, e.message || 'Could not delete recount.');
        }
    }));
}

module.exports = { registerReceivingReportSheetRoutes };
