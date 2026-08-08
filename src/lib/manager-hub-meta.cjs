'use strict';

const { isCompleteOrderDay, buildOrderWeeklyScorecard } = require('./order-weekly-scorecard.cjs');
const { buildOrderDayBriefing } = require('./order-day-briefing.cjs');
const { buildRhythmLoadAdvisor } = require('./rhythm-load-advisor.cjs');
const { buildFinishArchiveHealth } = require('./finish-archive-health.cjs');
const { buildManagerExceptions } = require('./manager-exceptions.cjs');
const { buildPresenceBoard, buildPresenceExceptions } = require('./presence-engine.cjs');
const { loadPresenceConfig } = require('./presence-config.cjs');
const { buildReportActions } = require('./reports-analytics.cjs');
const { buildTaskPlanningSummary } = require('./reports-analytics.cjs');
const {
    loadActionAcks,
    filterAckedReportActions,
    enrichReportActions,
    enrichTaskPlanningSummary,
} = require('./reports-actions.cjs');
const { getHandoffForReportDate } = require('./comms-center.cjs');
const { buildDailyDirectionDraft } = require('./daily-direction.cjs');
const { HUMAN_CLOSED_TASK_FILTER } = require('./rhythm-task-expand.cjs');
const { addDaysToDateStamp } = require('./store-time.cjs');
const { getAuditWalkPayload } = require('./audit-walk-templates.cjs');
const { listQuickMissChecks } = require('./task-estimate-baselines.cjs');
const { getStoreMeta } = require('../constants/store-meta.cjs');
const { normalizeStoreTimezone } = require('./store-timezone.cjs');
const { sqliteTzOffsetModifier } = require('./store-time.cjs');

/**
 * SQLite expression that buckets a UTC timestamp column by the store's LOCAL
 * calendar day. Without this, date(col) buckets in UTC and evening work (past
 * UTC midnight) is mis-filed onto the next day. Returns plain date(col) when the
 * store is effectively UTC or the offset can't be resolved.
 */
function localStoreDateExpr(col, settings, refStamp) {
    let tzMod = '';
    try {
        const tz = normalizeStoreTimezone(getStoreMeta(settings || {}).timezone).timezone;
        const ref = /^\d{4}-\d{2}-\d{2}$/.test(refStamp) ? new Date(`${refStamp}T12:00:00Z`) : new Date();
        tzMod = sqliteTzOffsetModifier(tz, ref);
    } catch (_) { tzMod = ''; }
    if (!/^[+-]\d+ minutes$/.test(tzMod) || tzMod === '+0 minutes') return `date(${col})`;
    return `date(${col}, '${tzMod}')`;
}

function buildManagerHubMeta(db, {
    today,
    clock,
    kpis,
    settings,
    cachedHeatMap,
    presenceConfig,
    getStoreDateStamp,
}) {
    const openTasks = db.all(`
        SELECT * FROM tasks WHERE status='Open'
        ORDER BY
            CASE WHEN task_id LIKE 'AUTO-PULL-%' THEN 0 ELSE 1 END,
            CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 ELSE 3 END,
            time_submitted
    `);

    const presenceCfg = presenceConfig || loadPresenceConfig(db);
    const managerExceptions = [
        ...buildManagerExceptions({
            db,
            storeDate: today,
            storeWeekday: clock.storeWeekday,
            storeTime: clock.storeTime,
            kpis,
            tasks: openTasks,
            kill_dates: db.all("SELECT * FROM kill_dates WHERE status='Active' ORDER BY kill_date ASC"),
            settings,
            zoneHeatMap: cachedHeatMap,
            isLiveToday: true,
        }),
        ...buildPresenceExceptions(db, presenceCfg),
    ];

    const finishArchiveHealth = buildFinishArchiveHealth(db, { asOfDate: today });

    const orderHistory = db.all(`
        SELECT store_date, order_start, order_end, total_pieces, staff_count, actual_order_minutes
        FROM shift_order_history
        ORDER BY store_date DESC
        LIMIT 90
    `).filter(isCompleteOrderDay);

    const orderWeeklyScorecard = buildOrderWeeklyScorecard(orderHistory);

    const completedTasks = db.all(`
        SELECT task_detail, zone, est_mins, time_submitted, time_closed, closed_by
        FROM tasks
        WHERE status IN ('Closed','Archived')
          AND ${HUMAN_CLOSED_TASK_FILTER}
          AND ${localStoreDateExpr('time_closed', settings, today)} >= date(?, '-90 days')
        ORDER BY datetime(time_closed) DESC
        LIMIT 400
    `, today);

    const taskPlanningSummary = enrichTaskPlanningSummary(
        db,
        buildTaskPlanningSummary(completedTasks),
    );

    const shiftSummary = {
        tasks_open: Number(db.get("SELECT COUNT(*) as c FROM tasks WHERE status='Open'")?.c || 0),
        orders_open: Number(db.get("SELECT COUNT(*) as c FROM special_orders WHERE status='Open'")?.c || 0),
        kill_dates_due: Number(db.get("SELECT COUNT(*) as c FROM kill_dates WHERE status='Active' AND kill_date<=?", today)?.c || 0),
    };

    const orderToday = {
        start: settings.Order_Start || '',
        end: settings.Order_End || '',
    };

    const reportActionsRaw = buildReportActions({
        manager_exceptions: managerExceptions,
        shift: shiftSummary,
        order_weekly_scorecard: orderWeeklyScorecard,
        order_today: orderToday,
        reportDate: today,
        liveStoreDate: today,
        isLiveToday: true,
        finish_archive_health: finishArchiveHealth,
    });

    const reportActions = filterAckedReportActions(
        enrichReportActions(reportActionsRaw, today),
        loadActionAcks(db),
        today,
    );

    let commsHandoff = null;
    try {
        commsHandoff = getHandoffForReportDate(db, today);
    } catch (_) { /* optional */ }

    const orderDayBriefing = buildOrderDayBriefing(db, {
        storeDate: today,
        storeWeekday: clock.storeWeekday,
    });

    const warningDate = addDaysToDateStamp(today, 7);
    const killWarnings = db.all(`
        SELECT *, CAST(julianday(kill_date) - julianday(?) AS INTEGER) as days_until
        FROM kill_dates
        WHERE status='Active' AND kill_date>? AND kill_date<=?
        ORDER BY kill_date ASC
    `, today, today, warningDate);

    const dailyDirectionDraft = buildDailyDirectionDraft(db, {
        storeDate: today,
        clock,
        kpis,
        settings,
        managerExceptions,
        reportActions,
        orderDayBriefing,
        killWarnings,
        openTasks,
        getStoreDateStamp,
    });

    return {
        order_day_briefing: orderDayBriefing,
        rhythm_load_advisor: buildRhythmLoadAdvisor(db, {
            storeDate: today,
            storeWeekday: clock.storeWeekday,
        }),
        manager_exceptions: managerExceptions,
        finish_archive_health: finishArchiveHealth,
        report_actions: reportActions,
        order_weekly_scorecard: orderWeeklyScorecard,
        task_planning_summary: taskPlanningSummary,
        comms_handoff_preview: commsHandoff?.messages?.length
            ? {
                store_date: commsHandoff.store_date,
                message_count: commsHandoff.messages.length,
                pinned: commsHandoff.messages.filter((m) => m.lane === 'pinned').length,
                latest: commsHandoff.messages.slice(0, 3).map((m) => ({
                    lane: m.lane,
                    body: String(m.body || '').slice(0, 120),
                    posted_by: m.posted_by,
                })),
            }
            : null,
        presence_board: presenceCfg.enabled ? buildPresenceBoard(db, presenceCfg) : null,
        presence_enabled: presenceCfg.enabled,
        daily_direction: dailyDirectionDraft,
        audit_walk_templates: getAuditWalkPayload(),
        quick_miss_checks: listQuickMissChecks(),
        vendor_contacts: (() => {
            try {
                return db.all('SELECT * FROM vendor_contacts ORDER BY vendor');
            } catch (_) {
                return [];
            }
        })(),
    };
}

function buildPresenceTvSummary(db, presenceConfig) {
    const config = presenceConfig || loadPresenceConfig(db);
    if (!config.enabled) return null;
    const board = buildPresenceBoard(db, config);
    return {
        asset_mode_label: board.asset_mode_label,
        order_hint: board.order_hint,
        zone_occupancy: board.analytics?.zone_occupancy || [],
        offline_count: board.alerts?.offline_count || 0,
        live_cart_count: (board.live_assets || []).filter((a) => a.asset_type === 'cart').length,
    };
}

module.exports = { buildManagerHubMeta, buildPresenceTvSummary };
