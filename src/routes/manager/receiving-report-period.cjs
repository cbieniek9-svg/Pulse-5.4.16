'use strict';

const { logManagerAudit } = require('../../lib/audit-log.cjs');
const {
    buildPeriodDashboard,
    activateReceivingPeriod,
    buildPeriodCloseReadiness,
} = require('../../lib/edmonton-receiving-analytics.cjs');
const {
    archivePeriodSalesToHistory,
    snapshotPeriod,
    buildExtendedPeriodPayload,
} = require('../../lib/edmonton-receiving-extended.cjs');
const {
    buildCountCyclePayload,
    saveCountCycle,
    setCountPeriodFlag,
    listCountCycles,
} = require('../../lib/edmonton-receiving-count-cycle.cjs');
const {
    getPeriodStatus,
    submitPeriod,
    approvePeriod,
    reopenPeriod,
    closeAndLockPeriod,
    listWorkbookVendors,
} = require('../../lib/edmonton-receiving-period-controls.cjs');
const { buildDockReconciliationPayload } = require('../../lib/edmonton-receiving-dock-reconcile.cjs');
const { resolvePeriodStart, resolvePeriodStartExplicit } = require('../../lib/edmonton-receiving-report.cjs');
const { setPeriodCostingMethod } = require('../../lib/edmonton-receiving-costing.cjs');
const {
    getPeriodFreightRate,
    upsertPeriodFreightRate,
    setActualFreightBillsTotal,
} = require('../../lib/receiving-period-freight-rates.cjs');
const {
    profileApiView,
    upsertDraftProfile,
    confirmProfile,
    copyPreviousProfileAsDraft,
    emptyPctMap,
    ALLOC_DEPT_KEYS,
} = require('../../lib/receiving-period-freight-alloc.cjs');
const { createReceivingGuards } = require('./receiving-helpers.cjs');

function normalizeAllocPctBody(body = {}) {
    const map = emptyPctMap();
    const src = body.departments || body.pct_map || body.pctMap || body;
    ALLOC_DEPT_KEYS.forEach((key) => {
        const raw = src?.[key] ?? src?.[`${key}_pct`];
        if (raw !== undefined && raw !== null && raw !== '') {
            const n = Number(raw);
            if (!Number.isFinite(n)) {
                const err = new Error(`Invalid allocation percentage for ${key}`);
                err.status = 400;
                err.code = 'INVALID_ALLOC_PCT';
                throw err;
            }
            map[key] = n;
        }
    });
    return map;
}

/**
 * Financial Log report routes — period.
 */
function registerReceivingReportPeriodRoutes(server, ctx) {
    const { wrap, fail, db, getStoreDateStamp } = ctx;
    const {
        requireFinancialLogSession,
        requireManagerOnly,
        requireFinancialAdmin,
        guardPeriodEditable,
        requireFinancialLogAccess,
    } = createReceivingGuards(ctx);

    server.get('/api/receiving/report/period', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        const explicitStart = String(req.query?.period_start || '').trim();
        try {
            const periodStart = resolvePeriodStartExplicit(db, {
                date: anchorDate,
                period_start: explicitStart || undefined,
            });
            const viewAnchor = explicitStart || periodStart;
            res.json({
                success: true,
                ...buildPeriodDashboard(db, viewAnchor),
                ...buildExtendedPeriodPayload(db, viewAnchor),
                period_status: getPeriodStatus(db, periodStart),
                dock_reconciliation: buildDockReconciliationPayload(db, viewAnchor),
                close_readiness: buildPeriodCloseReadiness(db, viewAnchor),
                operational_period_start: resolvePeriodStart(db, getStoreDateStamp()),
                viewing_period_start: periodStart,
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load report period.');
        }
    }));

    server.post('/api/receiving/report/period/costing-method', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        if (!requireManagerOnly(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            guardPeriodEditable(periodStart);
            const method = setPeriodCostingMethod(db, periodStart, b, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_costing_method',
                targetType: 'receiving_report_period',
                targetId: periodStart,
                summary: `Set costing method ${method.method} for ${periodStart}`,
                metadata: method,
            });
            res.json({ success: true, costing: method });
        } catch (e) {
            res.status(e.status || 400).json({
                success: false,
                code: e.code || 'COSTING_METHOD_FAILED',
                error: e.message || 'Could not set costing method.',
            });
        }
    }));

    server.get('/api/receiving/report/period/freight-rate', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const periodStart = String(req.query?.period_start || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            const rate = getPeriodFreightRate(db, periodStart, String(req.query?.department || ''));
            let status = null;
            try {
                status = db.get(
                    `SELECT freight_rate_percent, freight_calc_source, actual_freight_bills_total, costing_method
                       FROM receiving_report_period_status WHERE period_start=?`,
                    periodStart,
                );
            } catch (_) { /* optional */ }
            res.json({
                success: true,
                deprecated: true,
                deprecation_note: 'period_rate / freight-rate is superseded by period_department_allocation / freight-alloc-profile (5.4.16). Audit access only.',
                period_start: periodStart,
                rate,
                snapshot_rate_percent: status?.freight_rate_percent ?? null,
                freight_calc_source: status?.freight_calc_source || '',
                actual_freight_bills_total: status?.actual_freight_bills_total ?? null,
                costing_method: status?.costing_method || '',
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load period freight rate.');
        }
    }));

    server.put('/api/receiving/report/period/freight-rate', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        if (!requireManagerOnly(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            guardPeriodEditable(periodStart);
            const rate = upsertPeriodFreightRate(db, {
                period_start: periodStart,
                department: b.department,
                rate_percent: b.rate_percent ?? b.ratePercent,
                effective_start: b.effective_start,
                effective_end: b.effective_end,
                actor: session.name,
            });
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_period_freight_rate',
                targetType: 'receiving_period_freight_rates',
                targetId: periodStart,
                summary: `Set period freight rate ${rate.rate_percent}% for ${periodStart}`,
                metadata: rate,
            });
            res.json({
                success: true,
                deprecated: true,
                deprecation_note: 'period_rate / freight-rate is superseded by period_department_allocation / freight-alloc-profile (5.4.16). Audit access only.',
                rate,
            });
        } catch (e) {
            res.status(e.status || 400).json({
                success: false,
                code: e.code || 'FREIGHT_RATE_FAILED',
                error: e.message || 'Could not save period freight rate.',
            });
        }
    }));

    server.get('/api/receiving/report/period/freight-alloc-profile', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const periodStart = String(req.query?.period_start || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            const profile = profileApiView(db, periodStart);
            let actualBills = null;
            try {
                actualBills = db.get(
                    'SELECT actual_freight_bills_total FROM receiving_report_period_status WHERE period_start=?',
                    periodStart,
                )?.actual_freight_bills_total;
            } catch (_) { /* optional */ }
            res.json({
                success: true,
                profile,
                actual_freight_bills_total: actualBills ?? null,
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load freight allocation profile.');
        }
    }));

    server.put('/api/receiving/report/period/freight-alloc-profile', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        if (!requireManagerOnly(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            guardPeriodEditable(periodStart);
            const pctMap = normalizeAllocPctBody(b);
            upsertDraftProfile(db, periodStart, pctMap, session.name);
            const profile = profileApiView(db, periodStart);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_freight_alloc_profile_save',
                targetType: 'receiving_period_freight_alloc_profiles',
                targetId: periodStart,
                summary: `Saved draft freight allocation profile for ${periodStart} (total ${profile.total_pct}%)`,
                metadata: { pct_map: profile.pct_map, total_pct: profile.total_pct },
            });
            res.json({ success: true, profile });
        } catch (e) {
            res.status(e.status || 400).json({
                success: false,
                code: e.code || 'FREIGHT_ALLOC_PROFILE_FAILED',
                error: e.message || 'Could not save freight allocation profile.',
                details: e.details || undefined,
            });
        }
    }));

    server.post('/api/receiving/report/period/freight-alloc-profile/confirm', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        if (!requireManagerOnly(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            guardPeriodEditable(periodStart);
            const confirmed = confirmProfile(
                db,
                periodStart,
                session.name,
                String(b.reason || '').trim(),
            );
            try {
                const { snapshotPeriodDayDeptFreight } = require('../../lib/edmonton-receiving-costing.cjs');
                snapshotPeriodDayDeptFreight(db, periodStart);
            } catch (_) { /* best-effort after confirm */ }
            const profile = profileApiView(db, periodStart);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_freight_alloc_profile_confirm',
                targetType: 'receiving_period_freight_alloc_profiles',
                targetId: periodStart,
                summary: `Confirmed freight allocation profile for ${periodStart}`,
                metadata: { pct_map: confirmed.pctMap, reason: String(b.reason || '').trim() },
            });
            res.json({ success: true, profile });
        } catch (e) {
            res.status(e.status || 400).json({
                success: false,
                code: e.code || 'FREIGHT_ALLOC_PROFILE_CONFIRM_FAILED',
                error: e.message || 'Could not confirm freight allocation profile.',
                details: e.details || undefined,
            });
        }
    }));

    server.post('/api/receiving/report/period/freight-alloc-profile/copy', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        if (!requireManagerOnly(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || '').trim();
        let fromPeriodStart = String(b.from_period_start || b.fromPeriodStart || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            guardPeriodEditable(periodStart);
            if (!fromPeriodStart) {
                // Default: previous 35-day accounting period.
                const { addDays } = require('../../lib/edmonton-receiving-report.cjs');
                fromPeriodStart = addDays(periodStart, -35);
            }
            copyPreviousProfileAsDraft(db, periodStart, fromPeriodStart, session.name);
            const profile = profileApiView(db, periodStart);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_freight_alloc_profile_copy',
                targetType: 'receiving_period_freight_alloc_profiles',
                targetId: periodStart,
                summary: `Copied freight allocation profile from ${fromPeriodStart} to ${periodStart}`,
                metadata: { from_period_start: fromPeriodStart, pct_map: profile.pct_map },
            });
            res.json({ success: true, profile, from_period_start: fromPeriodStart });
        } catch (e) {
            res.status(e.status || 400).json({
                success: false,
                code: e.code || 'FREIGHT_ALLOC_PROFILE_COPY_FAILED',
                error: e.message || 'Could not copy freight allocation profile.',
            });
        }
    }));

    server.put('/api/receiving/report/period/actual-freight-bills', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        if (!requireManagerOnly(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || '').trim();
        if (!periodStart) {
            fail(res, 400, 'period_start is required.');
            return;
        }
        try {
            guardPeriodEditable(periodStart);
            const row = setActualFreightBillsTotal(
                db,
                periodStart,
                b.actual_freight_bills_total ?? b.actualFreightBillsTotal,
                session.name,
            );
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_actual_freight_bills',
                targetType: 'receiving_report_period',
                targetId: periodStart,
                summary: `Set actual freight bills total for ${periodStart}`,
                metadata: row,
            });
            res.json({ success: true, period_status: row });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save actual freight bills total.');
        }
    }));

    server.post('/api/receiving/report/period/activate', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const confirmed = b.confirm_operational_change === true || b.confirm === true;
        if (!confirmed) {
            fail(res, 400, 'Operational period change requires confirm_operational_change: true (historical viewing must not use this endpoint).');
            return;
        }
        try {
            const activated = activateReceivingPeriod(db, b);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_period_activate',
                targetType: 'receiving_report_period',
                targetId: activated.period_start,
                summary: `Switched financial log to Period ${activated.period_number || activated.period_start}`,
                metadata: {
                    period_number: activated.period_number,
                    period_start: activated.period_start,
                    confirm_operational_change: true,
                },
            });
            res.json({
                success: true,
                ...activated,
                ...buildPeriodDashboard(db, activated.period_start),
                ...buildExtendedPeriodPayload(db, activated.period_start),
                period_status: getPeriodStatus(db, activated.period_start),
                dock_reconciliation: buildDockReconciliationPayload(db, activated.period_start),
                operational_period_start: activated.period_start,
                viewing_period_start: activated.period_start,
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not switch period.');
        }
    }));

    server.post('/api/receiving/report/sales-history/archive', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(periodStart);
            const result = archivePeriodSalesToHistory(db, periodStart, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_sales_history_archive',
                targetType: 'receiving_report_sales_history',
                targetId: periodStart,
                summary: `Archived sales history for period ${periodStart}`,
                metadata: result,
            });
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not archive sales history.');
        }
    }));

    server.post('/api/receiving/report/period/snapshot', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            guardPeriodEditable(periodStart);
            const snapshot = db.transaction(() => {
                const created = snapshotPeriod(db, periodStart, session.name, {
                    reason: String(b.reason || 'manual_snapshot').trim(),
                });
                archivePeriodSalesToHistory(db, periodStart, session.name);
                return created;
            })();
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_period_snapshot',
                targetType: 'receiving_report_period_snapshots',
                targetId: periodStart,
                summary: `Snapshotted margin YTD for period ${periodStart}`,
                metadata: {
                    period_number: snapshot?.period_number || null,
                    snapshot_revision: snapshot?.snapshot_revision || null,
                },
            });
            res.json({ success: true, snapshot });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not snapshot period.');
        }
    }));

    server.get('/api/receiving/report/count-cycle', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const count_cycle = buildCountCyclePayload(db, anchorDate);
            res.json({
                success: true,
                count_cycle,
                cycles: listCountCycles(db),
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load count cycle.');
        }
    }));

    server.post('/api/receiving/report/count-cycle', wrap(async (req, res) => {
        const session = requireFinancialAdmin(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const periodStart = String(
            b.cycle_end_period_start || b.count_period_start || b.period_start || b.periodStart || b.date || getStoreDateStamp(),
        ).trim();
        try {
            guardPeriodEditable(periodStart);

            if (b.is_count_period === false || b.is_count_period === 0 || b.is_count_period === '0') {
                const count_cycle = setCountPeriodFlag(db, periodStart, false, session.name);
                logManagerAudit(db, {
                    req,
                    session,
                    action: 'receiving_report_count_period_clear',
                    targetType: 'receiving_report_count_cycles',
                    targetId: periodStart,
                    summary: `Cleared count-period flag for ${periodStart}`,
                });
                res.json({ success: true, count_cycle });
                return;
            }

            if (b.is_count_period === true || b.is_count_period === 1 || b.is_count_period === '1') {
                setCountPeriodFlag(db, periodStart, true, session.name);
            }

            const count_cycle = saveCountCycle(db, {
                ...b,
                cycle_end_period_start: periodStart,
            }, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_count_cycle_save',
                targetType: 'receiving_report_count_cycles',
                targetId: periodStart,
                summary: `Saved count cycle ending ${periodStart}`,
                metadata: {
                    period_number_end: count_cycle?.period_number_end || null,
                },
            });
            res.json({ success: true, count_cycle });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not save count cycle.');
        }
    }));

    server.get('/api/receiving/report/vendors', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        res.json({ success: true, vendors: listWorkbookVendors(db) });
    }));

    server.get('/api/receiving/report/dock-reconciliation', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            res.json({
                success: true,
                reconciliation: buildDockReconciliationPayload(db, anchorDate),
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load dock reconciliation.');
        }
    }));

    server.get('/api/receiving/report/period-status', wrap(async (req, res) => {
        const session = requireFinancialLogSession(req, res);
        if (!session) return;
        const anchorDate = String(req.query?.date || getStoreDateStamp()).trim();
        try {
            const periodStart = resolvePeriodStart(db, anchorDate);
            res.json({ success: true, period_status: getPeriodStatus(db, periodStart) });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not load period status.');
        }
    }));

    server.post('/api/receiving/report/period/submit', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            const period_status = submitPeriod(db, periodStart, session);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_period_submit',
                targetType: 'receiving_report_period_status',
                targetId: periodStart,
                summary: `Submitted period ${periodStart} for approval`,
            });
            res.json({ success: true, period_status });
        } catch (e) {
            if (e.readiness) {
                res.status(e.status || 400).json({
                    success: false,
                    code: e.code || 'PERIOD_NOT_READY',
                    error: e.message || 'Period is not ready to submit.',
                    failed_checks: e.readiness.failed_checks || [],
                    close_readiness: e.readiness,
                });
                return;
            }
            fail(res, e.status || 400, e.message || 'Could not submit period.');
        }
    }));

    server.post('/api/receiving/report/period/approve', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            const period_status = approvePeriod(db, periodStart, session);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_period_approve',
                targetType: 'receiving_report_period_status',
                targetId: periodStart,
                summary: `Approved period ${periodStart}`,
            });
            res.json({ success: true, period_status });
        } catch (e) {
            res.status(e.status || 400).json({
                success: false,
                code: e.code || 'PERIOD_APPROVAL_FAILED',
                error: e.message || 'Could not approve period.',
            });
        }
    }));

    server.post('/api/receiving/report/period/close', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        try {
            const { writeCloseOutbox, flushCloseAuditOutbox } = require('../../lib/edmonton-receiving-integrity.cjs');
            const period_status = closeAndLockPeriod(db, periodStart, session, {
                archivePeriodSalesToHistory,
                snapshotPeriod: (txnDb, start, actor) => snapshotPeriod(txnDb, start, actor, {
                    reason: 'period_close',
                }),
                auditOutbox: (txnDb, { event, period_start, actor }) => {
                    writeCloseOutbox(txnDb, {
                        periodStart: period_start,
                        eventType: event || 'receiving_period_locked',
                        eventId: `${period_start}:${event || 'receiving_period_locked'}:${
                            txnDb.get(
                                'SELECT snapshot_revision FROM receiving_report_period_snapshots WHERE period_start=?',
                                period_start,
                            )?.snapshot_revision || 0
                        }`,
                        payload: {
                            actor,
                            period_start,
                            summary: `Closed and locked period ${period_start}`,
                        },
                    });
                },
            });
            const audit_flush = flushCloseAuditOutbox(db, periodStart, { req, session, logManagerAudit });
            res.json({
                success: true,
                period_status,
                audit_flush,
                operational_warning: audit_flush.pending > 0
                    ? `${audit_flush.pending} close audit event(s) remain pending.`
                    : null,
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not close period.');
        }
    }));

    server.post('/api/receiving/report/period/lock', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        res.status(410).json({
            success: false,
            code: 'PERIOD_LOCK_ENDPOINT_RETIRED',
            error: 'Direct period locking is retired. Use /api/receiving/report/period/close.',
        });
    }));

    server.post('/api/receiving/report/period/audit-outbox/retry', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const { flushAllCloseAuditOutbox } = require('../../lib/edmonton-receiving-integrity.cjs');
        const result = flushAllCloseAuditOutbox(db, { req, session, logManagerAudit });
        res.status(result.pending > 0 ? 503 : 200).json({
            success: result.pending === 0,
            ...result,
            operational_warning: result.pending > 0
                ? `${result.pending} close audit event(s) remain pending.`
                : null,
        });
    }));

    server.post('/api/receiving/report/period/reopen', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        if (!requireFinancialLogAccess(req, res, session)) return;
        const b = req.body ?? {};
        const periodStart = String(b.period_start || b.periodStart || b.date || getStoreDateStamp()).trim();
        const note = String(b.note || b.reason || '').trim();
        if (!note) {
            fail(res, 400, 'A reopen note is required.');
            return;
        }
        try {
            const period_status = reopenPeriod(db, periodStart, session, note);
            logManagerAudit(db, {
                req,
                session,
                action: 'receiving_report_period_reopen',
                targetType: 'receiving_report_period_status',
                targetId: periodStart,
                summary: `Reopened period ${periodStart}`,
                metadata: { note },
            });
            res.json({ success: true, period_status });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not reopen period.');
        }
    }));
}

module.exports = { registerReceivingReportPeriodRoutes };
