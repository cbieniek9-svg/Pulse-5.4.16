'use strict';

const fs = require('fs');
const { resolveBackupPath } = require('../paths.cjs');
const { inspectBackupDatabase } = require('../lib/backup-health.cjs');
const { getStoreMeta } = require('../constants/store-meta.cjs');
const { normalizeStoreTimezone } = require('../lib/store-timezone.cjs');
const { sqliteTzOffsetModifier, createStoreTimeAccessors, addDaysToDateStamp } = require('../lib/store-time.cjs');
const { filterPendingExpectedForStoreDate } = require('../lib/expected-orders-day.cjs');
const { HUMAN_CLOSED_TASK_FILTER } = require('../lib/rhythm-task-expand.cjs');
const { computeArchivedOrderMetrics, resolveOrderPieceCounts, computeStandardOrderHours } = require('../lib/shift-metrics.cjs');
const { buildOrderWeeklyScorecard } = require('../lib/order-weekly-scorecard.cjs');
const { buildOrderDayBriefing } = require('../lib/order-day-briefing.cjs');
const { buildRhythmLoadAdvisor } = require('../lib/rhythm-load-advisor.cjs');
const { buildManagerExceptions } = require('../lib/manager-exceptions.cjs');
const { buildDailyDirectionDraft, loadDailyDirectionReportView } = require('../lib/daily-direction.cjs');
const { enrichColdChainRows, PALLET_DEPARTMENTS } = require('../lib/receiving-pallets.cjs');
const { listInspectionRunsForReports } = require('../lib/safety-inspections.cjs');
const { getHandoffForReportDate } = require('../lib/comms-center.cjs');
const { computeOrderClockMetrics } = require('../lib/order-history-archive.cjs');
const { loadHeatMap } = require('./heatmap.cjs');
const {
    buildTaskPlanningSummary,
    buildReportsLiveContext,
    buildReportActions,
    buildReportKpiStrip,
} = require('../lib/reports-analytics.cjs');
const { buildFinishArchiveHealth } = require('../lib/finish-archive-health.cjs');
const { loadPresenceConfig } = require('../lib/presence-config.cjs');
const { buildPresenceExceptions } = require('../lib/presence-engine.cjs');
const { buildPresenceReportSummary } = require('../lib/presence-reports.cjs');
const {
    loadActionAcks,
    filterAckedReportActions,
    enrichReportActions,
    enrichTaskPlanningSummary,
} = require('../lib/reports-actions.cjs');
const { buildTrendsAndInsights, resolveTrendWindowDays } = require('../lib/history-trends.cjs');
const { ensureDailySafetyFocus, loadDailySafetyFocus } = require('../lib/safety-blurbs.cjs');
const {
    parseStaffRoster,
    buildExceptionReasonRollup,
    buildStaffCountCurve,
    buildRosterPerformanceRollup,
    buildRosterSuggestionsByWeekday,
} = require('../lib/reports-order-analytics.cjs');
const {
    buildActionAckLog,
    buildRhythmDeferLogForReports,
} = require('../lib/reports-action-logs.cjs');
const { buildLaborLedger } = require('../lib/labor-ledger.cjs');
const { analyzeFloorShrink } = require('../lib/floor-shrink.cjs');

function buildOrderMetrics({
    groceryPieces, frozenPieces, hardwarePieces, totalPieces, staffCount,
    cph, hardwareCph, standardHours, actualOrderMinutes,
}) {
    const pph = computeArchivedOrderMetrics(totalPieces, actualOrderMinutes, staffCount);
    return {
        grocery_pieces: groceryPieces,
        frozen_pieces: frozenPieces,
        hardware_pieces: hardwarePieces,
        total_pieces: totalPieces,
        staff_count: staffCount,
        cph,
        hardware_cph: hardwareCph,
        standard_pieces_per_hour: cph,
        standard_hours: Number(standardHours),
        actual_order_minutes: actualOrderMinutes,
        team_pph: pph.team_pph,
        per_person_pph: pph.per_person_pph,
        break_deduction_hours_per_person: pph.break_deduction_hours_per_person,
        adjusted_labor_hours: pph.adjusted_labor_hours,
        adjusted_per_person_pph: pph.adjusted_per_person_pph,
        /** Team order rate — matches TV ACTUAL PPH. */
        actual_pieces_per_hour: pph.team_pph,
    };
}

/**
 * Open live DB or a readonly backup as the query target for reports.
 * Fail-closed: never substitute the live DB when a backup was requested.
 * @param {object} db — main app db
 * @param {string|undefined} backupFile — filename under `backups/`
 * @returns {{ ok: boolean, code?: string, error?: string, targetDb: object|null, close: () => void, reportSource?: string, backupFile?: string }}
 */
function openReportsTarget(db, backupFile) {
    if (!backupFile) {
        return { ok: true, targetDb: db, close: () => {}, reportSource: 'live' };
    }

    const safeFile = String(backupFile).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safeFile) {
        return {
            ok: false,
            code: 'BACKUP_SOURCE_UNAVAILABLE',
            error: 'Backup file not found.',
            targetDb: null,
            close: () => {},
        };
    }

    const bPath = resolveBackupPath(safeFile);
    if (!fs.existsSync(bPath) || !fs.statSync(bPath).isFile()) {
        return {
            ok: false,
            code: 'BACKUP_SOURCE_UNAVAILABLE',
            error: 'Backup file not found.',
            targetDb: null,
            close: () => {},
        };
    }

    const verified = inspectBackupDatabase(bPath, { skipIntegrityCheck: true });
    if (!verified.ok) {
        return {
            ok: false,
            code: 'BACKUP_SOURCE_UNAVAILABLE',
            error: verified.error || 'Backup verification failed.',
            targetDb: null,
            close: () => {},
        };
    }

    try {
        const Database = require('better-sqlite3');
        const tempConn = new Database(bPath, { readonly: true });
        const targetDb = {
            get: (sql, ...p) => tempConn.prepare(sql).get(...p),
            all: (sql, ...p) => tempConn.prepare(sql).all(...p),
            getSettings: () => tempConn.prepare('SELECT * FROM settings').all().reduce((acc, s) => ({ ...acc, [s.setting_name]: s.setting_value }), {}),
        };
        return {
            ok: true,
            targetDb,
            close: () => {
                try {
                    tempConn.close();
                } catch (_) { /* ignore */ }
            },
            reportSource: 'backup',
            backupFile: safeFile,
        };
    } catch (e) {
        console.error('[REPORTS] Failed to open backup:', e);
        return {
            ok: false,
            code: 'BACKUP_SOURCE_UNAVAILABLE',
            error: e.message || 'Backup verification failed.',
            targetDb: null,
            close: () => {},
        };
    }
}

/**
 * Resolve the report calendar window.
 * `reportSource: 'backup'` is applied only when the caller confirms a successful open
 * (pass `reportSource` from `openReportsTarget`). Filename alone never labels live data BACKUP.
 */
function resolveReportWindow({ liveStoreDate, backupFile, queryDate, queryStart, queryEnd, reportSource }) {
    const isValidYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const safeName = backupFile ? String(backupFile).replace(/[^a-zA-Z0-9._-]/g, '') : '';
    const usingBackup = reportSource === 'backup' && !!safeName;
    // Daily and weekly backup stamps both extract honestly when open succeeded.
    const backupDateMatch = usingBackup
        ? safeName.match(/tgp_ops_(?:backup|weekly)_(\d{4}-\d{2}-\d{2})\.db$/i)
        : null;
    if (backupDateMatch) {
        const d = backupDateMatch[1];
        return { start: d, end: d, reportDate: d, reportSource: 'backup', backupFile: safeName };
    }
    if (usingBackup) {
        if (isValidYmd(queryStart) && isValidYmd(queryEnd)) {
            const start = queryStart <= queryEnd ? queryStart : queryEnd;
            const end = queryStart <= queryEnd ? queryEnd : queryStart;
            return { start, end, reportDate: end, reportSource: 'backup', backupFile: safeName };
        }
        if (isValidYmd(queryDate)) {
            return { start: queryDate, end: queryDate, reportDate: queryDate, reportSource: 'backup', backupFile: safeName };
        }
        return { start: liveStoreDate, end: liveStoreDate, reportDate: liveStoreDate, reportSource: 'backup', backupFile: safeName };
    }
    if (isValidYmd(queryStart) && isValidYmd(queryEnd)) {
        const start = queryStart <= queryEnd ? queryStart : queryEnd;
        const end = queryStart <= queryEnd ? queryEnd : queryStart;
        return { start, end, reportDate: end, reportSource: 'live', backupFile: null };
    }
    if (isValidYmd(queryDate)) {
        return { start: queryDate, end: queryDate, reportDate: queryDate, reportSource: 'live', backupFile: null };
    }
    return { start: liveStoreDate, end: liveStoreDate, reportDate: liveStoreDate, reportSource: 'live', backupFile: null };
}

/**
 * @param {object} p
 * @param {object} p.targetDb
 * @param {string} p.APP_VERSION
 * @param {string} p.liveStoreDate — `getStoreDateStamp()` for live DB
 * @param {string|undefined} p.backupFile — raw query param (or opened.backupFile)
 * @param {string|undefined} p.reportSource — from `openReportsTarget` (`live`|`backup`); required for BACKUP chrome
 * @param {string|undefined} p.queryDate — `req.query.date`
 * @param {string|undefined} p.queryStart — `req.query.start`
 * @param {string|undefined} p.queryEnd — `req.query.end`
 * @param {function} [p.getStoreClockPayload]
 * @param {function} [p.getHeatMap]
 */
function assembleReportsPayload({
    targetDb, APP_VERSION, liveStoreDate, backupFile, reportSource: openedReportSource,
    queryDate, queryStart, queryEnd,
    getStoreClockPayload, getHeatMap,
}) {
    const win = resolveReportWindow({
        liveStoreDate,
        backupFile,
        queryDate,
        queryStart,
        queryEnd,
        reportSource: openedReportSource,
    });
    const { start: reportStart, end: reportEnd, reportDate, reportSource } = win;
    const safeName = win.backupFile || '';

    // Timestamps are stored as UTC ISO, but the report window (reportStart/End,
    // reportDate) is the store's LOCAL calendar day. SQLite date()/datetime()
    // bucket by UTC, so a task closed in the evening (past UTC midnight) would
    // land on the next UTC day and silently fall outside "today". We shift the
    // UTC timestamp into store-local time before bucketing so the day matches.
    let tzMod = '';
    try {
        const tz = normalizeStoreTimezone(getStoreMeta(targetDb.getSettings?.() || {}).timezone).timezone;
        const ref = /^\d{4}-\d{2}-\d{2}$/.test(reportEnd) ? new Date(`${reportEnd}T12:00:00Z`) : new Date();
        tzMod = sqliteTzOffsetModifier(tz, ref);
    } catch (_) { tzMod = ''; }
    if (!/^[+-]\d+ minutes$/.test(tzMod) || tzMod === '+0 minutes') tzMod = '';
    const TZ_DATE_COLS = 'time_closed|time_logged|time_submitted|arrived_at|departed_at|arrival_time|timestamp';
    const TZ_RE = new RegExp(`\\b(date|datetime)\\(\\s*(${TZ_DATE_COLS})\\s*\\)`, 'gi');
    const localizeUtcDates = (sql) => (tzMod ? sql.replace(TZ_RE, (_m, fn, col) => `${fn}(${col}, '${tzMod}')`) : sql);

    const safeCount = (sql, ...p) => { try { return targetDb.get(localizeUtcDates(sql), ...p)?.c ?? 0; } catch (_) { return 0; } };
    const safeSum = (sql, ...p) => { try { return parseFloat(targetDb.get(localizeUtcDates(sql), ...p)?.t ?? 0).toFixed(2); } catch (_) { return '0.00'; } };
    const safeAll = (sql, ...p) => { try { return targetDb.all(localizeUtcDates(sql), ...p); } catch (_) { return []; } };
    const safeGet = (sql, ...p) => { try { return targetDb.get(localizeUtcDates(sql), ...p) || {}; } catch (_) { return {}; } };
    const settings = (() => { try { return targetDb.getSettings(); } catch (_) { return {}; } })();
    const { getStoreDateStamp: reportStoreDateStamp } = createStoreTimeAccessors(() => settings);
    const counts = safeGet('SELECT * FROM counts WHERE id = 1');
    const cph = parseFloat(settings.Cases_Per_Hour) || 55;
    const hardwareCph = parseFloat(settings.Hardware_CPH) || 50;
    const groceryPieces = Number(counts.grocery || 0);
    const frozenPieces = Number(counts.frozen || 0);
    const hardwareRaw = Number(counts.hardware || 0);
    const hardwareArrived = settings.Hardware_Arrived === '1';
    const livePieces = resolveOrderPieceCounts({
        grocery: groceryPieces,
        frozen: frozenPieces,
        hardware: hardwareRaw,
        hardwareArrived,
    });
    const staffCount = Math.max(1, Number(counts.staff || 1));
    const totalPieces = livePieces.total_pieces;
    const standardHours = computeStandardOrderHours(
        groceryPieces, frozenPieces, hardwareRaw, cph, hardwareCph, hardwareArrived,
    );
    const activeOrderStart = settings.Order_Start || '';
    const activeOrderEnd = settings.Order_End || '';
    const liveClock = (activeOrderStart && activeOrderEnd && Date.parse(activeOrderEnd) >= Date.parse(activeOrderStart))
        ? computeOrderClockMetrics(activeOrderStart, activeOrderEnd, settings)
        : { rawClockMinutes: 0, actualOrderMinutes: 0, spansCalendarDay: 0 };
    const actualOrderMinutes = liveClock.actualOrderMinutes;
    const archivedOrder = safeGet(`
                    SELECT store_date, order_start, order_end, recorded_at,
                        grocery_pieces, frozen_pieces, hardware_pieces, total_pieces, staff_count,
                        standard_hours, actual_order_minutes, actual_pieces_per_hour,
                        raw_clock_minutes, spans_calendar_day
                    FROM shift_order_history
                    WHERE store_date=?
                `, reportDate);
    const hasArchivedOrder = Boolean(archivedOrder.store_date);
    const archivedStaffCount = Math.max(1, Number(archivedOrder.staff_count || 1));
    const archivedMinutes = Number(archivedOrder.actual_order_minutes || 0);
    const archivedTotalPieces = Number(archivedOrder.total_pieces || 0);

    const completedTasks = safeAll(`
                    SELECT task_id, task_detail, priority, zone, assigned_to, closed_by,
                        est_mins, time_submitted, start_time, time_closed,
                        date(time_closed) as closed_date,
                        CASE WHEN start_time IS NOT NULL AND start_time != ''
                            THEN ROUND((julianday(time_closed) - julianday(start_time)) * 24 * 60, 1)
                            ELSE NULL END as actual_mins
                    FROM tasks
                    WHERE (status='Closed' OR status='Archived')
                      AND ${HUMAN_CLOSED_TASK_FILTER}
                      AND date(time_closed) BETWEEN ? AND ?
                    ORDER BY datetime(time_closed) DESC LIMIT 500
                `, reportStart, reportEnd);

    const liveCtx = buildReportsLiveContext(targetDb, {
        reportDate,
        liveStoreDate,
        getStoreClockPayload,
    });
    const heatMap = (liveCtx.isLiveToday && typeof getHeatMap === 'function')
        ? getHeatMap()
        : (() => { try { return loadHeatMap(targetDb); } catch (_) { return {}; } })();

    const openTasks = liveCtx.isLiveToday
        ? safeAll(`
                    SELECT * FROM tasks WHERE status='Open'
                    ORDER BY
                        CASE WHEN task_id LIKE 'AUTO-PULL-%' THEN 0 ELSE 1 END,
                        CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 ELSE 3 END,
                        time_submitted
                `)
        : [];

    const activeKillDates = liveCtx.isLiveToday
        ? safeAll("SELECT * FROM kill_dates WHERE status='Active' ORDER BY kill_date ASC")
        : [];

    const orderDayBriefing = (() => {
        try {
            return buildOrderDayBriefing(targetDb, {
                storeDate: reportDate,
                storeWeekday: liveCtx.clock.storeWeekday,
            });
        } catch (e) {
            console.error('[REPORTS] order day briefing failed:', e.message);
            return {
                store_date: reportDate,
                weekday: liveCtx.clock.storeWeekday,
                is_order_day: false,
                sample_count: 0,
                expected_pieces: null,
                expected_duration_minutes: null,
                expected_staff: null,
                expected_team_pph: null,
                recent_same_weekday: [],
                scorecard_window_days: 90,
            };
        }
    })();

    const rhythmLoadAdvisor = (() => {
        try {
            return buildRhythmLoadAdvisor(targetDb, {
                storeDate: reportDate,
                storeWeekday: liveCtx.clock.storeWeekday,
            });
        } catch (e) {
            console.error('[REPORTS] rhythm load advisor failed:', e.message);
            return {
                store_date: reportDate,
                weekday: liveCtx.clock.storeWeekday,
                piece_band: { key: 'unknown', label: 'Unknown order size' },
                expected_pieces_avg: null,
                message: 'Rhythm load guidance unavailable for this report.',
                defer_non_critical_suggested: false,
                defer_candidates: [],
                manual_confirm_required: true,
            };
        }
    })();

    const presenceConfig = loadPresenceConfig(targetDb);
    const managerExceptions = [
        ...buildManagerExceptions({
            db: targetDb,
            storeDate: liveCtx.isLiveToday ? liveStoreDate : reportDate,
            storeWeekday: liveCtx.clock.storeWeekday,
            storeTime: liveCtx.clock.storeTime,
            kpis: liveCtx.isLiveToday ? liveCtx.kpis : { pieces_on_order: 0, shift_active: false },
            tasks: openTasks,
            kill_dates: activeKillDates,
            settings: liveCtx.settings,
            zoneHeatMap: liveCtx.isLiveToday ? heatMap : {},
            isLiveToday: liveCtx.isLiveToday,
        }),
        ...buildPresenceExceptions(targetDb, presenceConfig),
    ];
    const presence_summary = buildPresenceReportSummary(targetDb, presenceConfig, {
        reportDate,
        isLiveToday: liveCtx.isLiveToday,
    });

    const taskPlanningSummary = enrichTaskPlanningSummary(
        targetDb,
        buildTaskPlanningSummary(completedTasks),
    );

    const floorShrink = analyzeFloorShrink(targetDb, { start: reportStart, end: reportEnd });
    const floorShrinkToday = analyzeFloorShrink(targetDb, {
        start: reportDate,
        end: reportDate,
    });
    const shrinkCostStr = Number(floorShrinkToday.totals?.financial_loss_cost || 0).toFixed(2);
    const shrinkRetailStr = Number(floorShrinkToday.totals?.potential_loss_retail || 0).toFixed(2);

    const shiftSummary = liveCtx.isLiveToday
        ? {
            tasks_completed: safeCount("SELECT COUNT(*) as c FROM tasks WHERE status='Closed' AND date(time_closed) BETWEEN ? AND ?", reportStart, reportEnd),
            tasks_open: safeCount("SELECT COUNT(*) as c FROM tasks WHERE status='Open'"),
            oos_logged: safeCount("SELECT COUNT(*) as c FROM oos WHERE date(time_logged) BETWEEN ? AND ?", reportStart, reportEnd),
            oos_cleared: safeCount("SELECT COUNT(*) as c FROM oos WHERE status='Closed' AND date(time_closed) BETWEEN ? AND ?", reportStart, reportEnd),
            shrink_open_cost: shrinkCostStr,
            shrink_today: shrinkRetailStr,
            orders_filled: safeCount("SELECT COUNT(*) as c FROM special_orders WHERE status='Closed' AND date(time_closed) BETWEEN ? AND ?", reportStart, reportEnd),
            orders_open: safeCount("SELECT COUNT(*) as c FROM special_orders WHERE status='Open'"),
            vendors_received: safeCount("SELECT COUNT(*) as c FROM expected_orders WHERE date(arrived_at) BETWEEN ? AND ?", reportStart, reportEnd),
            vendors_pending: (() => {
                try {
                    const rows = safeAll("SELECT * FROM expected_orders WHERE status='Pending' AND category!='hardware'");
                    return filterPendingExpectedForStoreDate(
                        rows,
                        liveStoreDate,
                        liveCtx.clock.storeWeekday,
                        reportStoreDateStamp,
                    ).length;
                } catch (_) {
                    return 0;
                }
            })(),
            kill_dates_due: safeCount("SELECT COUNT(*) as c FROM kill_dates WHERE status='Active' AND kill_date<=?", reportEnd),
        }
        : {
            tasks_completed: safeCount("SELECT COUNT(*) as c FROM tasks WHERE status='Closed' AND date(time_closed) BETWEEN ? AND ?", reportStart, reportEnd),
            tasks_open: null,
            oos_logged: safeCount("SELECT COUNT(*) as c FROM oos WHERE date(time_logged) BETWEEN ? AND ?", reportStart, reportEnd),
            oos_cleared: safeCount("SELECT COUNT(*) as c FROM oos WHERE status='Closed' AND date(time_closed) BETWEEN ? AND ?", reportStart, reportEnd),
            shrink_open_cost: shrinkCostStr,
            shrink_today: shrinkRetailStr,
            orders_filled: safeCount("SELECT COUNT(*) as c FROM special_orders WHERE status='Closed' AND date(time_closed) BETWEEN ? AND ?", reportStart, reportEnd),
            orders_open: null,
            vendors_received: safeCount("SELECT COUNT(*) as c FROM expected_orders WHERE date(arrived_at) BETWEEN ? AND ?", reportStart, reportEnd),
            vendors_pending: null,
            kill_dates_due: safeCount(
                `SELECT COUNT(*) as c FROM kill_dates
                 WHERE kill_date<=?
                   AND (time_closed IS NULL OR time_closed='' OR date(time_closed) > ?)`,
                reportEnd,
                reportEnd,
            ),
        };

    const emptyOrderMetrics = {
        archive_missing: true,
        grocery_pieces: null,
        frozen_pieces: null,
        hardware_pieces: null,
        total_pieces: null,
        staff_count: null,
        cph,
        hardware_cph: hardwareCph,
        standard_pieces_per_hour: cph,
        standard_hours: null,
        actual_order_minutes: null,
        team_pph: null,
        per_person_pph: null,
        break_deduction_hours_per_person: null,
        adjusted_labor_hours: null,
        adjusted_per_person_pph: null,
        actual_pieces_per_hour: null,
    };

    const orderMetricsBuilt = hasArchivedOrder
        ? buildOrderMetrics({
            groceryPieces: Number(archivedOrder.grocery_pieces || 0),
            frozenPieces: Number(archivedOrder.frozen_pieces || 0),
            hardwarePieces: Number(archivedOrder.hardware_pieces || 0),
            totalPieces: archivedTotalPieces,
            staffCount: archivedStaffCount,
            cph,
            hardwareCph,
            standardHours: Number(archivedOrder.standard_hours || 0),
            actualOrderMinutes: archivedMinutes,
        })
        : (liveCtx.isLiveToday
            ? buildOrderMetrics({
                groceryPieces: livePieces.grocery_pieces,
                frozenPieces: livePieces.frozen_pieces,
                hardwarePieces: livePieces.hardware_pieces,
                totalPieces,
                staffCount,
                cph,
                hardwareCph,
                standardHours: Number(standardHours.toFixed(2)),
                actualOrderMinutes,
            })
            : emptyOrderMetrics);

    const orderWeeklyScorecard = buildOrderWeeklyScorecard(
        safeAll(`
                    SELECT store_date, order_start, order_end,
                        total_pieces, staff_count, actual_order_minutes,
                        actual_pieces_per_hour, adjusted_per_person_pph
                    FROM shift_order_history
                    ORDER BY store_date DESC
                    LIMIT 90
                `).map((r) => {
            const rowStaff = Math.max(1, Number(r.staff_count || 1));
            const rowMinutes = Number(r.actual_order_minutes || 0);
            const rowPieces = Number(r.total_pieces || 0);
            const pph = computeArchivedOrderMetrics(rowPieces, rowMinutes, rowStaff);
            return {
                ...r,
                team_pph: pph.team_pph,
                adjusted_per_person_pph: Number(r.adjusted_per_person_pph ?? pph.adjusted_per_person_pph),
            };
        }),
        { windowDays: 90 },
    );

    const orderToday = (() => {
        try {
            if (hasArchivedOrder) return { start: archivedOrder.order_start || '', end: archivedOrder.order_end || '' };
            if (!liveCtx.isLiveToday) return { start: '', end: '', archive_missing: true };
            return { start: activeOrderStart, end: activeOrderEnd };
        } catch (_) {
            return { start: '', end: '' };
        }
    })();

    const finishArchiveHealth = buildFinishArchiveHealth(targetDb, { asOfDate: reportEnd });

    const reportActionsRaw = buildReportActions({
        manager_exceptions: managerExceptions,
        shift: shiftSummary,
        order_weekly_scorecard: orderWeeklyScorecard,
        order_today: orderToday,
        reportDate,
        liveStoreDate,
        isLiveToday: liveCtx.isLiveToday,
        finish_archive_health: finishArchiveHealth,
    });

    const actionAcks = loadActionAcks(targetDb);
    const reportActions = filterAckedReportActions(
        enrichReportActions(reportActionsRaw, reportDate),
        actionAcks,
        reportDate,
    );

    const reportKpiStrip = buildReportKpiStrip({
        shift: shiftSummary,
        order_metrics: orderMetricsBuilt,
        order_weekly_scorecard: orderWeeklyScorecard,
        manager_exceptions: managerExceptions,
        report_actions: reportActions,
        isLiveToday: liveCtx.isLiveToday,
    });

    const dailyDirection = (() => {
        try {
            if (!liveCtx.isLiveToday) {
                return loadDailyDirectionReportView(targetDb, reportDate);
            }
            const warningDate = addDaysToDateStamp(reportDate, 7);
            const killWarnings = targetDb.all(`
                SELECT *, CAST(julianday(kill_date) - julianday(?) AS INTEGER) as days_until
                FROM kill_dates
                WHERE status='Active' AND kill_date>? AND kill_date<=?
                ORDER BY kill_date ASC
            `, reportDate, reportDate, warningDate);
            return buildDailyDirectionDraft(targetDb, {
                storeDate: reportDate,
                clock: liveCtx.clock,
                kpis: liveCtx.kpis,
                settings: liveCtx.settings,
                managerExceptions,
                reportActions,
                orderDayBriefing,
                killWarnings,
                openTasks,
                getStoreDateStamp: reportStoreDateStamp,
            });
        } catch (e) {
            console.error('[REPORTS] daily direction failed:', e.message);
            return null;
        }
    })();


    const trendsAndInsights = (() => {
        try {
            const requestedWindow = resolveTrendWindowDays(settings, settings.Report_Trend_Window_Days);
            return buildTrendsAndInsights(targetDb, {
                endDate: reportEnd,
                windowDays: requestedWindow,
                settings,
                // Do not persist a same-day snapshot from the live Reports view.
                // The EOD sweep owns the final daily_report_snapshots row for today.
                persist: typeof targetDb.run === 'function' && reportEnd !== liveStoreDate,
            });
        } catch (e) {
            console.error('[REPORTS] trends failed:', e.message);
            return {
                window_days: 90,
                start_date: reportStart,
                end_date: reportEnd,
                current: {},
                previous: {},
                cards: [],
                insights: [{ severity: 'info', title: 'Trend history not ready', detail: 'Daily snapshots will fill in after EOD runs.', metric: 'baseline' }],
                daily_rows: [],
                labels: { outdated_item_logs: 'Outdated Items' },
            };
        }
    })();

    const dailySafetyFocus = (() => {
        try {
            if (liveCtx.isLiveToday) return ensureDailySafetyFocus(targetDb, reportDate);
            return loadDailySafetyFocus(targetDb, reportDate);
        } catch (e) {
            console.warn('[REPORTS] safety focus failed:', e.message);
            return null;
        }
    })();

    const orderShiftHistoryRaw = safeAll(`
                    SELECT store_date, order_start, order_end, recorded_at,
                        grocery_pieces, frozen_pieces, hardware_pieces, total_pieces, staff_count,
                        standard_hours, actual_order_minutes, actual_pieces_per_hour,
                        break_deduction_hours_per_person, adjusted_labor_hours, adjusted_per_person_pph,
                        raw_clock_minutes, spans_calendar_day, exception_reason, staff_roster
                    FROM shift_order_history
                    ORDER BY store_date DESC
                    LIMIT 90
                `);

    const orderShiftHistory = orderShiftHistoryRaw.map((r) => {
        const rowStaff = Math.max(1, Number(r.staff_count || 1));
        const rowMinutes = Number(r.actual_order_minutes || 0);
        const rowPieces = Number(r.grocery_pieces || 0) + Number(r.frozen_pieces || 0) + Number(r.hardware_pieces || 0);
        const pph = computeArchivedOrderMetrics(rowPieces, rowMinutes, rowStaff);
        return {
            ...r,
            staff_count: rowStaff,
            staff_roster: parseStaffRoster(r.staff_roster),
            standard_pieces_per_hour: cph,
            team_pph: pph.team_pph,
            per_person_pph: pph.per_person_pph,
            break_deduction_hours_per_person: Number(r.break_deduction_hours_per_person ?? pph.break_deduction_hours_per_person),
            adjusted_labor_hours: Number(r.adjusted_labor_hours ?? pph.adjusted_labor_hours),
            adjusted_per_person_pph: Number(r.adjusted_per_person_pph ?? pph.adjusted_per_person_pph),
            actual_pieces_per_hour: pph.team_pph,
        };
    });

    const exceptionReasonRollup = buildExceptionReasonRollup(orderShiftHistoryRaw, { windowDays: 90 });
    const staffCountCurve = buildStaffCountCurve(orderShiftHistoryRaw, {
        weekdayName: orderDayBriefing?.weekday || liveCtx.clock?.storeWeekday || '',
    });
    const rosterPerformanceRollup = buildRosterPerformanceRollup(orderShiftHistory, { limit: 12 });
    const rosterSuggestionsByWeekday = buildRosterSuggestionsByWeekday(orderShiftHistory, { limitPerDay: 3 });

    const laborLedger = (() => {
        try {
            return buildLaborLedger(targetDb, {
                storeDate: liveCtx.isLiveToday ? liveStoreDate : reportDate,
                storeWeekday: liveCtx.clock?.storeWeekday || orderDayBriefing?.weekday || '',
                orderDayBriefing,
                settings,
                shiftSummary,
                orderMetrics: orderMetricsBuilt,
                isOrderDay: !!orderDayBriefing?.is_order_day
                    || !!(orderToday?.start)
                    || hasArchivedOrder,
            });
        } catch (e) {
            console.error('[REPORTS] labor ledger failed:', e.message);
            return null;
        }
    })();

    const actionAckLog = buildActionAckLog(targetDb, { limit: 50 });
    const rhythmDeferLog = buildRhythmDeferLogForReports(targetDb, { limit: 50 });

    const snapshotLead = safeGet(
        'SELECT manager_on_duty FROM daily_report_snapshots WHERE store_date=?',
        reportDate,
    ).manager_on_duty || '';
    const shiftLead = liveCtx.isLiveToday
        ? String(settings.Active_Manager || '').trim()
        : String(snapshotLead || settings.Active_Manager || '').trim();

    const orderFinishRoster = (() => {
        const row = orderShiftHistoryRaw.find((r) => r.store_date === reportDate);
        return row ? parseStaffRoster(row.staff_roster) : [];
    })();


    return {
        appVersion: APP_VERSION,
        store: getStoreMeta(settings),
        generated: new Date().toISOString(),
        /** @deprecated use meta.reportDate */
        today: reportDate,
        meta: {
            reportDate,
            reportStart,
            reportEnd,
            liveStoreDate,
            reportSource,
            backupFile: reportSource === 'backup' ? safeName || null : null,
            isLiveToday: liveCtx.isLiveToday,
            hasArchivedOrder,
        },

        shift: shiftSummary,

        order_today: orderToday,

        order_metrics: orderMetricsBuilt,

        order_shift_history: orderShiftHistory,

        exception_reason_rollup: exceptionReasonRollup,

        staff_count_curve: staffCountCurve,
        roster_performance_rollup: rosterPerformanceRollup,
        roster_suggestions_by_weekday: rosterSuggestionsByWeekday,

        labor_ledger: laborLedger,

        action_ack_log: actionAckLog,

        rhythm_defer_log: rhythmDeferLog,

        shift_lead: shiftLead,

        order_finish_roster: orderFinishRoster,

        order_weekly_scorecard: orderWeeklyScorecard,

        order_day_briefing: orderDayBriefing,

        rhythm_load_advisor: rhythmLoadAdvisor,

        manager_exceptions: managerExceptions,

        report_actions: reportActions,

        daily_direction: dailyDirection,

        daily_safety_focus: dailySafetyFocus,

        trends: trendsAndInsights,

        report_kpi_strip: reportKpiStrip,

        finish_archive_health: finishArchiveHealth,

        presence_summary,

        task_planning_summary: taskPlanningSummary,

        comms_handoff: (() => {
            try { return getHandoffForReportDate(targetDb, reportDate); } catch (_) { return null; }
        })(),

        oos_hotspots_30d: safeAll(`
                    SELECT zone, SUM(hole_count) as total_holes, COUNT(*) as incidents
                    FROM oos
                    WHERE date(time_logged) BETWEEN date(?, '-30 days') AND ?
                       OR date(time_closed) BETWEEN date(?, '-30 days') AND ?
                    GROUP BY zone ORDER BY total_holes DESC LIMIT 10
                `, reportEnd, reportEnd, reportEnd, reportEnd),

        completed_tasks: completedTasks,

        customer_orders: safeAll(`
                    SELECT order_id, customer, item, contact, location, status, logged_by,
                        time_logged, closed_by, time_closed,
                        ROUND((julianday(COALESCE(time_closed, ? || 'T23:59:59.999Z')) - julianday(time_logged)) * 24 * 60, 1) as age_mins
                    FROM special_orders
                    WHERE date(time_logged) BETWEEN ? AND ? OR date(time_closed) BETWEEN ? AND ? OR status='Open'
                    ORDER BY CASE status WHEN 'Open' THEN 0 ELSE 1 END, datetime(COALESCE(time_closed,time_logged)) DESC
                    LIMIT 200
                `, reportEnd, reportStart, reportEnd, reportStart, reportEnd),

        deliveries: safeAll(`
                    SELECT exp_id, vendor, expected_day, status, logged_by, closed_by, time_closed,
                        category, pieces, arrived, arrived_at, arrived_by, departed_at, departed_by, item, invoice_ref
                    FROM expected_orders
                    WHERE expected_day BETWEEN ? AND ? OR date(arrived_at) BETWEEN ? AND ? OR date(time_closed) BETWEEN ? AND ?
                    ORDER BY datetime(COALESCE(arrived_at,time_closed,expected_day)) DESC LIMIT 200
                `, reportStart, reportEnd, reportStart, reportEnd, reportStart, reportEnd),

        oos_daily_comparison: (() => {
            const prev = safeGet("SELECT date(?, '-1 day') as d", reportDate).d;
            return {
                previous_date: prev,
                today_incidents: safeCount("SELECT COUNT(*) as c FROM oos WHERE date(time_logged)=?", reportDate),
                today_holes: safeCount("SELECT COALESCE(SUM(hole_count),0) as c FROM oos WHERE date(time_logged)=?", reportDate),
                previous_incidents: safeCount("SELECT COUNT(*) as c FROM oos WHERE date(time_logged)=?", prev),
                previous_holes: safeCount("SELECT COALESCE(SUM(hole_count),0) as c FROM oos WHERE date(time_logged)=?", prev),
            };
        })(),

        staff_shifts: safeAll(`
                    SELECT staff_name, shift_date, start_time, end_time, role, department, notes
                    FROM staff_shifts WHERE shift_date BETWEEN ? AND ?
                    ORDER BY shift_date DESC, start_time, staff_name
                `, reportStart, reportEnd),

        markdown_records: safeAll(`
                    SELECT id, item, item_code, kill_date, zone, status, logged_by, closed_by, time_closed,
                        CAST(julianday(kill_date) - julianday(?) AS INTEGER) as days_until
                    FROM kill_dates
                    WHERE kill_date BETWEEN date(?, '-14 day') AND date(?, '+7 day')
                       OR date(time_closed) BETWEEN ? AND ?
                    ORDER BY kill_date ASC, item ASC
                `, reportEnd, reportEnd, reportEnd, reportStart, reportEnd),

        receiving_by_vendor: safeAll(`
                    SELECT vendor,
                        COUNT(*) as runs,
                        ROUND(AVG(duration_mins),1) as avg_mins,
                        ROUND(MIN(duration_mins),1) as best_mins,
                        ROUND(MAX(duration_mins),1) as worst_mins,
                        MAX(arrival_time) as last_arrival
                    FROM receiving_stats WHERE date(arrival_time) BETWEEN ? AND ?
                    GROUP BY vendor ORDER BY runs DESC
                `, reportStart, reportEnd),

        receiving_by_person: safeAll(`
                    SELECT processed_by,
                        COUNT(*) as runs,
                        ROUND(AVG(duration_mins),1) as avg_mins,
                        ROUND(MIN(duration_mins),1) as best_mins
                    FROM receiving_stats WHERE date(arrival_time) BETWEEN ? AND ?
                    GROUP BY processed_by ORDER BY runs DESC LIMIT 10
                `, reportStart, reportEnd),

        receiving_recent: safeAll(`
                    SELECT vendor, processed_by,
                        ROUND(duration_mins,1) as duration_mins,
                        arrival_time, completion_time
                    FROM receiving_stats WHERE date(arrival_time) BETWEEN ? AND ?
                    ORDER BY arrival_time DESC LIMIT 30
                `, reportStart, reportEnd),

        tgp_cold_chain: enrichColdChainRows(safeAll(`
                    SELECT p.pallet_id, p.exp_id, p.store_date, p.seq_num, p.license_plate, p.department,
                           p.temp_c, p.in_range, p.notes, p.captured_at, p.captured_by,
                           o.vendor, o.invoice_ref, o.arrived_at, o.departed_at
                    FROM receiving_pallets p
                    JOIN expected_orders o ON o.exp_id = p.exp_id
                    WHERE p.store_date BETWEEN ? AND ?
                    ORDER BY p.store_date DESC, datetime(COALESCE(o.arrived_at, p.captured_at)) DESC, p.seq_num ASC
                `, reportStart, reportEnd)),

        receiving_pallet_departments: PALLET_DEPARTMENTS,

        safety_inspections: (() => {
            try {
                return listInspectionRunsForReports(targetDb, reportStart, reportEnd);
            } catch (_) {
                return [];
            }
        })(),

        task_leaderboard: safeAll(`
                    SELECT s.name,
                           COALESCE(t.count, 0) as count
                    FROM staff s
                    LEFT JOIN (
                        SELECT closed_by as name, COUNT(*) as count
                        FROM tasks
                        WHERE (status='Closed' OR status='Archived')
                          AND closed_by NOT IN ('AUTO','','Unassigned')
                          AND date(time_closed) BETWEEN ? AND ?
                        GROUP BY closed_by
                    ) t ON t.name = s.name
                    WHERE s.active = 1
                      AND s.app_access = 1
                      AND s.name NOT IN ('Unassigned')
                    ORDER BY count DESC, s.name ASC
                `, reportStart, reportEnd),

        task_closed_by_zone: safeAll(`
                    SELECT zone, COUNT(*) as cnt
                    FROM tasks
                    WHERE (status='Closed' OR status='Archived')
                      AND ${HUMAN_CLOSED_TASK_FILTER}
                      AND date(time_closed) BETWEEN ? AND ?
                    GROUP BY zone ORDER BY cnt DESC LIMIT 20
                `, reportStart, reportEnd),

        task_closed_by_priority: safeAll(`
                    SELECT priority, COUNT(*) as cnt
                    FROM tasks
                    WHERE (status='Closed' OR status='Archived')
                      AND ${HUMAN_CLOSED_TASK_FILTER}
                      AND date(time_closed) BETWEEN ? AND ?
                    GROUP BY priority ORDER BY cnt DESC
                `, reportStart, reportEnd),

        tasks_open_by_zone: safeAll(`
                    SELECT zone, COUNT(*) as cnt
                    FROM tasks WHERE status = 'Open'
                    GROUP BY zone ORDER BY cnt DESC LIMIT 20
                `),

        oos_hotspots: safeAll(`
                    SELECT zone, SUM(hole_count) as total_holes, COUNT(*) as incidents
                    FROM oos WHERE date(time_logged) BETWEEN ? AND ? OR date(time_closed) BETWEEN ? AND ?
                    GROUP BY zone ORDER BY total_holes DESC LIMIT 10
                `, reportStart, reportEnd, reportStart, reportEnd),

        audit_scores: safeAll(`
                    SELECT zone_name, COUNT(*) as total_audits,
                        ROUND(AVG(json_extract(audit_data,'$.front_edge_pass'))*100,0)    as front_edge,
                        ROUND(AVG(json_extract(audit_data,'$.tag_integrity_pass'))*100,0) as tag_integrity,
                        ROUND(AVG(json_extract(audit_data,'$.hole_strategy_pass'))*100,0) as hole_strategy,
                        ROUND(AVG(json_extract(audit_data,'$.clearances_pass'))*100,0)    as clearances
                    FROM homebase_audits WHERE audit_data IS NOT NULL AND date(timestamp) BETWEEN ? AND ?
                    GROUP BY zone_name ORDER BY zone_name
                `, reportStart, reportEnd),

        /* Legacy stub kept empty; floor SKU analytics live on floor_shrink. */
        shrink_breakdown: [],
        floor_shrink: floorShrink,

        settings,
    };
}

module.exports = { openReportsTarget, assembleReportsPayload, resolveReportWindow };
