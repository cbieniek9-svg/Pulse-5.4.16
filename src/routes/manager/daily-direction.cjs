'use strict';

const {
    buildDailyDirectionDraft,
    saveDailyDirectionEdits,
    approveDailyDirection,
    dismissDailyDirectionCheckpoint,
    ignoreAmendmentSuggestion,
    dismissAmendmentSuggestion,
    saveShiftUpdateDraft,
    postShiftUpdate,
    updatePostedDailyDirection,
} = require('../../lib/daily-direction.cjs');
const { buildManagerExceptions } = require('../../lib/manager-exceptions.cjs');
const { buildReportActions } = require('../../lib/reports-analytics.cjs');
const { buildOrderDayBriefing } = require('../../lib/order-day-briefing.cjs');
const { buildFinishArchiveHealth } = require('../../lib/finish-archive-health.cjs');
const { buildOrderWeeklyScorecard } = require('../../lib/order-weekly-scorecard.cjs');
const { isCompleteOrderDay } = require('../../lib/order-weekly-scorecard.cjs');
const { addDaysToDateStamp } = require('../../lib/store-time.cjs');

function buildDailyDirectionContext(db, { storeDate, clock, kpis, settings, cachedHeatMap, getStoreDateStamp }) {
    const openTasks = db.all(`
        SELECT * FROM tasks WHERE status='Open'
        ORDER BY
            CASE WHEN task_id LIKE 'AUTO-PULL-%' THEN 0 ELSE 1 END,
            CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 ELSE 3 END,
            time_submitted
    `);

    const managerExceptions = buildManagerExceptions({
        db,
        storeDate,
        storeWeekday: clock.storeWeekday,
        storeTime: clock.storeTime,
        kpis,
        tasks: openTasks,
        kill_dates: db.all("SELECT * FROM kill_dates WHERE status='Active' ORDER BY kill_date ASC"),
        settings,
        zoneHeatMap: cachedHeatMap,
        isLiveToday: true,
    });

    const finishArchiveHealth = buildFinishArchiveHealth(db, { asOfDate: storeDate });
    const orderHistory = db.all(`
        SELECT store_date, order_start, order_end, total_pieces, staff_count, actual_order_minutes
        FROM shift_order_history ORDER BY store_date DESC LIMIT 90
    `).filter(isCompleteOrderDay);
    const orderWeeklyScorecard = buildOrderWeeklyScorecard(orderHistory);

    const shiftSummary = {
        tasks_open: Number(db.get("SELECT COUNT(*) as c FROM tasks WHERE status='Open'")?.c || 0),
        orders_open: Number(db.get("SELECT COUNT(*) as c FROM special_orders WHERE status='Open'")?.c || 0),
        kill_dates_due: Number(db.get("SELECT COUNT(*) as c FROM kill_dates WHERE status='Active' AND kill_date<=?", storeDate)?.c || 0),
    };

    const reportActions = buildReportActions({
        manager_exceptions: managerExceptions,
        shift: shiftSummary,
        order_weekly_scorecard: orderWeeklyScorecard,
        order_today: { start: settings.Order_Start || '', end: settings.Order_End || '' },
        reportDate: storeDate,
        liveStoreDate: storeDate,
        isLiveToday: true,
        finish_archive_health: finishArchiveHealth,
    });

    const orderDayBriefing = buildOrderDayBriefing(db, {
        storeDate,
        storeWeekday: clock.storeWeekday,
    });

    const warningDate = addDaysToDateStamp(storeDate, 7);
    const killWarnings = db.all(`
        SELECT *, CAST(julianday(kill_date) - julianday(?) AS INTEGER) as days_until
        FROM kill_dates
        WHERE status='Active' AND kill_date>? AND kill_date<=?
        ORDER BY kill_date ASC
    `, storeDate, storeDate, warningDate);

    return {
        storeDate,
        clock,
        kpis,
        settings,
        managerExceptions,
        reportActions,
        orderDayBriefing,
        killWarnings,
        openTasks,
        getStoreDateStamp,
    };
}

function registerDailyDirectionRoutes(server, ctx) {
    const {
        wrap, fail, requireSession, db, broadcastUpdate,
        getStoreDateStamp, getStoreClockPayload, getHeatMap,
    } = ctx;

    const requireManager = (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return null;
        return session;
    };

    const loadDraft = () => {
        const storeDate = getStoreDateStamp();
        const clock = typeof getStoreClockPayload === 'function' ? getStoreClockPayload() : {};
        const settings = db.getSettings ? db.getSettings() : {};
        const counts = db.get('SELECT * FROM counts WHERE id = 1') || { grocery: 0, frozen: 0, hardware: 0, staff: 1 };
        const hwRow = db.get("SELECT SUM(pieces) as t FROM expected_orders WHERE category='hardware' AND arrived=0") || { t: 0 };
        const { computeShiftMetrics } = require('../../lib/shift-metrics.cjs');
        const shift = computeShiftMetrics(settings, counts);
        const kpis = {
            g: counts.grocery || 0,
            f: counts.frozen || 0,
            h: counts.hardware || 0,
            staff: counts.staff || 1,
            pieces_on_order: hwRow?.t || 0,
            ...shift,
        };
        const hubCtx = buildDailyDirectionContext(db, {
            storeDate,
            clock,
            kpis,
            settings,
            cachedHeatMap: typeof getHeatMap === 'function' ? getHeatMap() : {},
            getStoreDateStamp,
        });
        const draft = buildDailyDirectionDraft(db, hubCtx);
        return { storeDate, settings, kpis, clock, hubCtx, draft };
    };

    server.get('/api/daily-direction', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const { draft } = loadDraft();
        res.json({ success: true, daily_direction: draft });
    }));

    server.post('/api/daily-direction/save', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const storeDate = getStoreDateStamp();
        const b = req.body ?? {};
        try {
            saveDailyDirectionEdits(db, storeDate, {
                walk_notes: b.walk_notes,
                must_wins: b.must_wins,
                status_override: b.status_override,
                hidden_risk_ids: b.hidden_risk_ids,
                risk_order: b.risk_order,
                floor_message: b.floor_message,
                manager_only_notes: b.manager_only_notes,
            }, session.name);
            if (typeof broadcastUpdate === 'function') broadcastUpdate({ table: 'daily_direction', action: 'update' });
            const { draft } = loadDraft();
            res.json({ success: true, daily_direction: draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Save failed');
        }
    }));

    server.post('/api/daily-direction/approve', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const { storeDate, settings, hubCtx, draft } = loadDraft();
        const b = req.body ?? {};
        try {
            const result = approveDailyDirection(db, {
                ...hubCtx,
                settings,
                broadcastUpdate,
            }, {
                storeDate,
                actorName: session.name,
                floorMessage: b.floor_message != null ? b.floor_message : draft.floor_message,
                managerOnlyNotes: b.manager_only_notes != null ? b.manager_only_notes : draft.manager_only_notes,
                mustWins: b.must_wins != null ? b.must_wins : draft.must_wins,
                statusOverride: b.status_override !== undefined ? b.status_override : draft.status_override,
                walkNotes: b.walk_notes != null ? b.walk_notes : draft.walk_notes,
            });
            const refreshed = loadDraft();
            res.json({ success: true, ...result, daily_direction: refreshed.draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Approve failed');
        }
    }));

    server.post('/api/daily-direction/checkpoint-dismiss', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        try {
            const b = req.body ?? {};
            dismissDailyDirectionCheckpoint(db, getStoreDateStamp(), session.name, b.fingerprint);
            if (typeof broadcastUpdate === 'function') broadcastUpdate({ table: 'daily_direction', action: 'checkpoint_dismiss' });
            const { draft } = loadDraft();
            res.json({ success: true, daily_direction: draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Dismiss failed');
        }
    }));

    server.post('/api/daily-direction/amendment/ignore', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        try {
            const b = req.body ?? {};
            const result = ignoreAmendmentSuggestion(
                db,
                getStoreDateStamp(),
                session.name,
                b.minutes != null ? Number(b.minutes) : undefined,
            );
            if (typeof broadcastUpdate === 'function') broadcastUpdate({ table: 'daily_direction', action: 'amendment_ignore' });
            const { draft } = loadDraft();
            res.json({ success: true, ...result, daily_direction: draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Ignore failed');
        }
    }));

    server.post('/api/daily-direction/amendment/dismiss', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        try {
            const b = req.body ?? {};
            dismissAmendmentSuggestion(db, getStoreDateStamp(), session.name, b.fingerprint);
            if (typeof broadcastUpdate === 'function') broadcastUpdate({ table: 'daily_direction', action: 'amendment_dismiss' });
            const { draft } = loadDraft();
            res.json({ success: true, daily_direction: draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Dismiss failed');
        }
    }));

    server.post('/api/daily-direction/shift-update/save', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        try {
            saveShiftUpdateDraft(db, getStoreDateStamp(), req.body?.message, session.name);
            if (typeof broadcastUpdate === 'function') broadcastUpdate({ table: 'daily_direction', action: 'shift_update_draft' });
            const { draft } = loadDraft();
            res.json({ success: true, daily_direction: draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Save failed');
        }
    }));

    server.post('/api/daily-direction/shift-update/post', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const { storeDate, settings, hubCtx, draft } = loadDraft();
        const b = req.body ?? {};
        try {
            const message = b.message != null
                ? b.message
                : (draft.shift_update_draft?.message || draft.amendment_suggestion?.suggested_message || '');
            const result = postShiftUpdate(db, {
                ...hubCtx,
                settings,
                broadcastUpdate,
            }, {
                storeDate,
                actorName: session.name,
                message,
                fingerprint: b.fingerprint || draft.amendment_suggestion?.fingerprint,
                triggers: b.triggers || draft.amendment_suggestion?.triggers,
            });
            const refreshed = loadDraft();
            res.json({ success: true, ...result, daily_direction: refreshed.draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Post failed');
        }
    }));

    server.post('/api/daily-direction/update-posted', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const { storeDate, settings, hubCtx } = loadDraft();
        const b = req.body ?? {};
        try {
            const result = updatePostedDailyDirection(db, {
                ...hubCtx,
                settings,
                broadcastUpdate,
            }, {
                storeDate,
                actorName: session.name,
                floorMessage: b.floor_message,
                statusOverride: b.status_override,
                mustWins: b.must_wins,
                walkNotes: b.walk_notes,
                managerOnlyNotes: b.manager_only_notes,
            });
            const refreshed = loadDraft();
            res.json({ success: true, ...result, daily_direction: refreshed.draft });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Update failed');
        }
    }));
}

module.exports = { registerDailyDirectionRoutes, buildDailyDirectionContext };
