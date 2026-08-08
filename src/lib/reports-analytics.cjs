'use strict';

const { taskDetailKey } = require('./task-estimates.cjs');
const { computeShiftMetrics } = require('./shift-metrics.cjs');
const { WEEKDAY_NAMES, weekdayFromStoreDate } = require('./order-weekly-scorecard.cjs');

function round1(v) {
    if (v == null || Number.isNaN(v)) return null;
    return Math.round(v * 10) / 10;
}

/** Match rhythm_tasks.day ("Tuesday") regardless of clock payload casing. */
function normalizeStoreWeekday(raw, reportDate) {
    if (raw) {
        const upper = String(raw).trim().toUpperCase();
        const match = WEEKDAY_NAMES.find((name) => name.toUpperCase() === upper);
        if (match) return match;
    }
    const idx = weekdayFromStoreDate(reportDate);
    return idx != null ? WEEKDAY_NAMES[idx] : '';
}

/**
 * Aggregate est vs actual from completed task rows (reports date range).
 */
function buildTaskPlanningSummary(completedTasks) {
    const rows = (completedTasks || []).filter((t) => {
        const est = Number(t.est_mins);
        const act = Number(t.actual_mins);
        return est > 0 && act > 0;
    });
    if (!rows.length) {
        return { sample_count: 0, overall: null, by_type: [] };
    }

    const groups = {};
    rows.forEach((t) => {
        const key = taskDetailKey(t.task_detail) || String(t.task_detail || '').slice(0, 48);
        if (!groups[key]) groups[key] = { est: [], act: [] };
        groups[key].est.push(Number(t.est_mins));
        groups[key].act.push(Number(t.actual_mins));
    });

    const by_type = Object.entries(groups).map(([task_type, g]) => {
        const n = g.est.length;
        const avgEst = g.est.reduce((a, b) => a + b, 0) / n;
        const avgAct = g.act.reduce((a, b) => a + b, 0) / n;
        const bias = avgAct - avgEst;
        const biasPct = avgEst > 0 ? Math.round((bias / avgEst) * 100) : 0;
        let status = 'on_track';
        if (biasPct > 15) status = 'under_estimated';
        else if (biasPct < -15) status = 'over_estimated';
        return {
            task_type,
            sample_count: n,
            avg_est_mins: round1(avgEst),
            avg_actual_mins: round1(avgAct),
            bias_mins: round1(bias),
            bias_pct: biasPct,
            status,
        };
    }).sort((a, b) => b.sample_count - a.sample_count);

    const allEst = rows.map((t) => Number(t.est_mins));
    const allAct = rows.map((t) => Number(t.actual_mins));
    const avgEst = allEst.reduce((a, b) => a + b, 0) / allEst.length;
    const avgAct = allAct.reduce((a, b) => a + b, 0) / allAct.length;

    return {
        sample_count: rows.length,
        overall: {
            avg_est_mins: round1(avgEst),
            avg_actual_mins: round1(avgAct),
            bias_mins: round1(avgAct - avgEst),
            bias_pct: avgEst > 0 ? Math.round(((avgAct - avgEst) / avgEst) * 100) : 0,
        },
        by_type: by_type.slice(0, 15),
    };
}

/**
 * Live operational context for manager exceptions on reports.
 */
function buildReportsLiveContext(targetDb, { reportDate, liveStoreDate, getStoreClockPayload }) {
    const settings = (() => {
        try { return targetDb.getSettings(); } catch (_) { return {}; }
    })();
    let counts = { grocery: 0, frozen: 0, hardware: 0, staff: 1 };
    let hwRow = { t: 0 };
    try {
        counts = targetDb.get('SELECT * FROM counts WHERE id = 1') || counts;
    } catch (_) { /* ignore */ }
    try {
        hwRow = targetDb.get(
            "SELECT SUM(pieces) as t FROM expected_orders WHERE category='hardware' AND arrived=0",
        ) || hwRow;
    } catch (_) { /* ignore legacy schema */ }
    const shift = computeShiftMetrics(settings, counts);
    const kpis = {
        g: counts.grocery || 0,
        f: counts.frozen || 0,
        h: counts.hardware || 0,
        staff: counts.staff || 1,
        pieces_on_order: hwRow?.t || 0,
        ...shift,
    };

    const isLiveToday = reportDate === liveStoreDate;
    let clock = { storeWeekday: '', storeTime: '12:00' };
    if (isLiveToday && typeof getStoreClockPayload === 'function') {
        try {
            const liveClock = getStoreClockPayload();
            clock = {
                ...liveClock,
                storeWeekday: normalizeStoreWeekday(liveClock.storeWeekday, reportDate),
            };
        } catch (_) {
            clock.storeWeekday = normalizeStoreWeekday('', reportDate);
        }
    } else {
        clock.storeWeekday = normalizeStoreWeekday('', reportDate);
    }

    return { settings, counts, kpis, clock, isLiveToday };
}

/**
 * Actionable items for the reports inbox (exceptions + operational gaps).
 */
function buildReportActions({
    manager_exceptions,
    shift,
    order_weekly_scorecard,
    order_today,
    reportDate,
    liveStoreDate,
    isLiveToday,
    finish_archive_health,
}) {
    const actions = [];

    (manager_exceptions || []).forEach((ex) => {
        const urgentKinds = new Set(['missing_finish', 'pull', 'task']);
        actions.push({
            priority: urgentKinds.has(ex.kind) ? 'urgent' : 'warn',
            title: ex.title,
            detail: ex.detail,
            meta: ex.meta || '',
            kind: ex.kind,
            item_key: ex.item_key || '',
        });
    });

    const fah = finish_archive_health || {};
    if (isLiveToday && fah.complete_order_days != null && !fah.phase0_ready) {
        actions.push({
            priority: fah.complete_order_days === 0 ? 'urgent' : 'warn',
            title: 'FINISH ARCHIVE BUILDING',
            detail: fah.message || 'Run FINISH on every order day to unlock scorecard trends.',
            meta: `${fah.complete_order_days || 0} complete days · ${(fah.missing_finish_days || []).length} recent gaps`,
            kind: 'finish_archive',
        });
    }

    if (isLiveToday && fah.incomplete_rows?.length) {
        actions.push({
            priority: 'warn',
            title: 'INCOMPLETE ORDER ARCHIVES',
            detail: `${fah.incomplete_rows.length} row(s) missing end time or duration — fix in Reports history`,
            meta: 'Shift Order Clock → SAVE',
            kind: 'incomplete_archive',
        });
    }

    if (isLiveToday && order_today?.start && !order_today?.end) {
        actions.push({
            priority: 'warn',
            title: 'ORDER CLOCK RUNNING',
            detail: 'Run FINISH when order completes — confirm staff count and hardware flag',
            meta: 'Mobile → FINISH',
            kind: 'order_running',
        });
    }

    if (isLiveToday && Number(shift?.tasks_open || 0) > 0) {
        actions.push({
            priority: Number(shift.tasks_open) >= 8 ? 'warn' : 'info',
            title: 'OPEN TASKS ON BOARD',
            detail: `${shift.tasks_open} task(s) still open`,
            meta: 'Clear or carry Urgent/High before EOD',
            kind: 'tasks_open',
        });
    }

    if (isLiveToday && Number(shift?.orders_open || 0) > 0) {
        actions.push({
            priority: 'info',
            title: 'OPEN CUSTOMER ORDERS',
            detail: `${shift.orders_open} special order(s) pending`,
            meta: 'Customer orders panel',
            kind: 'orders_open',
        });
    }

    if (isLiveToday && Number(shift?.kill_dates_due || 0) > 0) {
        actions.push({
            priority: 'urgent',
            title: 'EXPIRY PULLS DUE',
            detail: `${shift.kill_dates_due} active kill date(s) at or before today`,
            meta: 'Print pull list / close pull tasks',
            kind: 'pulls_due',
        });
    }

    if (reportDate === liveStoreDate && !(order_weekly_scorecard?.order_days > 0)) {
        actions.push({
            priority: 'info',
            title: 'SCORECARD BUILDING',
            detail: 'Need archived FINISH rows on order days to unlock weekday trends',
            meta: 'Phase 0 — 4–8 weeks of clean history',
            kind: 'scorecard_empty',
        });
    }

    return actions;
}

/**
 * Executive KPI chips for the reports header strip.
 */
function buildReportKpiStrip({
    shift,
    order_metrics,
    order_weekly_scorecard,
    manager_exceptions,
    report_actions,
    isLiveToday,
}) {
    const urgent = (report_actions || []).filter((a) => a.priority === 'urgent').length;
    const warns = (report_actions || []).filter((a) => a.priority === 'warn').length;
    const ows = order_weekly_scorecard || {};

    return {
        actions_urgent: urgent,
        actions_warn: warns,
        exceptions_count: (manager_exceptions || []).length,
        tasks_completed: shift?.tasks_completed ?? 0,
        tasks_open: isLiveToday ? (shift?.tasks_open ?? 0) : null,
        oos_logged: shift?.oos_logged ?? 0,
        order_pieces: order_metrics?.total_pieces ?? 0,
        order_adj_pph: order_metrics?.adjusted_per_person_pph ?? null,
        scorecard_days: ows.order_days ?? 0,
        scorecard_adj_pph: ows.overall?.avg_adj_pph ?? null,
    };
}

module.exports = {
    buildTaskPlanningSummary,
    buildReportsLiveContext,
    buildReportActions,
    buildReportKpiStrip,
    normalizeStoreWeekday,
};
