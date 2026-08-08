'use strict';

const { vendorScheduleWeekday } = require('../store-time.cjs');
const {
    parseJson,
    loadDailyDirectionRow,
    emptyWalkNotes,
    normalizeStatusOverride,
    normalizeMustWin,
    deriveDayStatus,
    statusColor,
    normalizeDailyDirectionFloorMessage,
    normalizeDefaultOrderDayLabel,
} = require('./helpers.cjs');
const {
    resolveDirectionOrderDay,
    repairPostedDailyDirectionOrderDay,
    postedSnapshotWithLiveOrderDay,
} = require('./order-day.cjs');
const { collectSystemRisks, orderRisks } = require('./risks.cjs');
const {
    syncMustWinsWithOpenBoard,
    suggestMustWins,
    buildDefaultFloorMessage,
} = require('./must-wins.cjs');
const {
    buildAmendmentTriggers,
    buildAmendmentSuggestion,
} = require('./amendments.cjs');

function loadShiftUpdates(db, storeDate) {
    try {
        return db.all(`
            SELECT id, store_date, sequence_num, message, triggers_json, posted_at, posted_by, posted_msg_id, snapshot_json
            FROM shift_updates
            WHERE store_date = ?
            ORDER BY sequence_num ASC
        `, storeDate).map((row) => ({
            id: row.id,
            sequence: row.sequence_num,
            message: row.message,
            triggers: parseJson(row.triggers_json, []),
            posted_at: row.posted_at,
            posted_by: row.posted_by,
            posted_msg_id: row.posted_msg_id,
            snapshot: parseJson(row.snapshot_json, null),
        }));
    } catch (_) {
        return [];
    }
}

function nextShiftUpdateSequence(db, storeDate) {
    const row = db.get('SELECT MAX(sequence_num) as m FROM shift_updates WHERE store_date = ?', storeDate);
    return Number(row?.m || 0) + 1;
}

function updatePostedSnapshotMessage(row, message, postedAt, actorName, sequence, status, extras = {}) {
    const snap = parseJson(row?.posted_snapshot_json, {});
    const out = {
        ...snap,
        floor_message: message,
        last_updated_at: postedAt,
        last_updated_by: actorName,
        update_sequence: sequence,
    };
    if (status && ['green', 'yellow', 'red'].includes(status)) out.status = status;
    if (extras.must_wins != null) {
        out.must_wins = (extras.must_wins || []).slice(0, 3).map(normalizeMustWin).filter((w) => w.text);
    }
    if (extras.walk_notes != null) {
        out.walk_notes = { ...emptyWalkNotes(), ...extras.walk_notes, flags: { ...emptyWalkNotes().flags, ...(extras.walk_notes?.flags || {}) } };
    }
    if (extras.manager_only_notes != null) {
        out.manager_only_notes = String(extras.manager_only_notes || '').slice(0, 1000);
    }
    return out;
}

function buildDailyDirectionDraft(db, ctx) {
    const {
        storeDate,
        clock = {},
        kpis = {},
        settings = {},
        managerExceptions = [],
        reportActions = [],
        orderDayBriefing = null,
        killWarnings = [],
        openTasks = [],
        getStoreDateStamp,
    } = ctx;

    const row = loadDailyDirectionRow(db, storeDate);
    if (row) {
        try {
            syncMustWinsWithOpenBoard(db, storeDate, {
                settings,
                actorName: 'system',
            });
        } catch (_) { /* non-fatal */ }
    }
    const rowFresh = loadDailyDirectionRow(db, storeDate) || row;
    if (rowFresh?.posted_at) {
        repairPostedDailyDirectionOrderDay(db, storeDate, rowFresh, 'system', {
            storeWeekday: clock.storeWeekday,
            kpis,
            settings,
            orderDayBriefing,
        });
    }
    const walkNotes = parseJson(rowFresh?.walk_notes_json, emptyWalkNotes());
    const mustWinsSaved = parseJson(rowFresh?.must_wins_json, null);
    const hiddenRiskIds = parseJson(rowFresh?.hidden_risk_ids_json, []);
    const riskOrder = parseJson(rowFresh?.risk_order_json, []);
    const statusOverride = normalizeStatusOverride(rowFresh?.status_override);
    const floorMessageEdited = !!rowFresh?.floor_message_edited;
    const managerOnlyNotes = String(rowFresh?.manager_only_notes || '');

    const directionOrderDay = resolveDirectionOrderDay(db, {
        storeDate,
        storeWeekday: clock.storeWeekday,
        kpis,
        settings,
        orderDayBriefing,
    });

    const systemRisks = collectSystemRisks({
        db,
        storeDate,
        storeWeekday: clock.storeWeekday,
        kpis,
        settings,
        managerExceptions,
        reportActions,
        orderDayBriefing,
        directionOrderDay,
        killWarnings,
        getStoreDateStamp,
    });

    const orderedRisks = orderRisks(systemRisks, riskOrder, hiddenRiskIds);
    const statusDerived = deriveDayStatus(orderedRisks);
    const scheduleWeekday = vendorScheduleWeekday(clock.storeWeekday, storeDate);
    const vendors = db.all('SELECT vendor FROM vendor_schedule WHERE day=? ORDER BY vendor', scheduleWeekday || '');
    const postedSnap = rowFresh?.posted_at ? parseJson(rowFresh.posted_snapshot_json, {}) : null;
    const mustWins = rowFresh?.posted_at && Array.isArray(postedSnap?.must_wins) && postedSnap.must_wins.length
        ? postedSnap.must_wins.slice(0, 3).map(normalizeMustWin).filter((w) => w.text)
        : ((mustWinsSaved && mustWinsSaved.length)
            ? mustWinsSaved.slice(0, 3).map(normalizeMustWin).filter((w) => w.text)
            : suggestMustWins(orderedRisks, settings, 3));
    let status;
    let floorMessage;
    if (rowFresh?.posted_at) {
        status = postedSnap?.status || statusOverride || 'yellow';
        floorMessage = normalizeDailyDirectionFloorMessage(
            String(rowFresh.floor_message || postedSnap?.floor_message || '').trim(),
            status,
        );
    } else {
        status = statusOverride || statusDerived;
        floorMessage = String(rowFresh?.floor_message || '').trim();
        if (!floorMessageEdited || !floorMessage) {
            floorMessage = buildDefaultFloorMessage({
                status,
                weekday: clock.storeWeekday,
                isOrderDay: directionOrderDay.is_order_day,
                mustWins,
                vendors,
            });
        }
        floorMessage = normalizeDailyDirectionFloorMessage(floorMessage, status);
    }

    const posted = rowFresh?.posted_at ? {
        posted_at: rowFresh.posted_at,
        posted_by: rowFresh.posted_by,
        posted_msg_id: rowFresh.posted_msg_id,
        snapshot: parseJson(rowFresh.posted_snapshot_json, null),
    } : null;

    const shiftUpdates = loadShiftUpdates(db, storeDate);
    const shiftUpdateDraft = parseJson(rowFresh?.shift_update_draft_json, null);

    const postedSnapshot = posted?.snapshot
        ? { ...posted.snapshot, posted_at: posted.posted_at }
        : null;

    const amendmentTriggers = postedSnapshot
        ? buildAmendmentTriggers({
            postedSnapshot,
            liveRisks: systemRisks,
            kpis,
            openTasks,
            settings,
        })
        : [];

    const amendmentSuggestion = posted
        ? buildAmendmentSuggestion(rowFresh, postedSnapshot, amendmentTriggers, clock, shiftUpdateDraft)
        : null;

    return {
        store_date: storeDate,
        status,
        status_derived: statusDerived,
        status_color: statusColor(status),
        day_context: {
            weekday: clock.storeWeekday || '',
            store_time: clock.storeTime || '',
            is_order_day: directionOrderDay.is_order_day,
            order_day_sources: directionOrderDay.sources,
            vendors: vendors.map((v) => v.vendor),
        },
        system_risks: orderedRisks,
        all_system_risks: systemRisks,
        hidden_risk_ids: hiddenRiskIds,
        risk_order: riskOrder,
        must_wins: mustWins,
        walk_notes: walkNotes,
        floor_message: floorMessage,
        floor_message_edited: floorMessageEdited,
        manager_only_notes: managerOnlyNotes,
        posted,
        shift_updates: shiftUpdates,
        shift_update_draft: shiftUpdateDraft,
        amendment_suggestion: amendmentSuggestion,
        /** @deprecated use amendment_suggestion */
        checkpoint: amendmentSuggestion ? {
            suggested_at: amendmentSuggestion.suggested_at,
            summary: amendmentSuggestion.summary,
            items: amendmentSuggestion.triggers.map((t) => t.line),
        } : null,
        can_edit: !posted,
        can_post_shift_update: !!posted,
        can_update_posted: !!posted,
        status_override: statusOverride || (rowFresh?.posted_at ? status : ''),
    };
}

function buildDailyDirectionFloorView(draft) {
    if (!draft?.posted?.posted_at) return null;
    const rawSnap = draft.posted.snapshot || {};
    const liveCtx = draft.day_context || {};
    const beforeMessage = String(rawSnap.floor_message || draft.floor_message || '');
    const managerEdited = !!draft.floor_message_edited || Number(rawSnap.update_sequence || 0) > 0;
    const afterMessage = (!managerEdited && liveCtx?.is_order_day !== undefined)
        ? normalizeDefaultOrderDayLabel(beforeMessage, liveCtx.is_order_day)
        : beforeMessage;
    const snap = (!managerEdited && liveCtx?.is_order_day !== undefined
        && (
            rawSnap?.day_context?.is_order_day !== liveCtx.is_order_day
            || afterMessage !== beforeMessage
        ))
        ? {
            ...rawSnap,
            day_context: {
                ...(rawSnap.day_context || {}),
                is_order_day: liveCtx.is_order_day,
                order_day_sources: liveCtx.order_day_sources || [],
            },
            floor_message: afterMessage,
        }
        : rawSnap;
    const updateCount = Number(snap.update_sequence || 0);
    const updatedAt = snap.last_updated_at || draft.posted.posted_at;
    const updatedBy = snap.last_updated_by || draft.posted.posted_by;
    return {
        store_date: draft.store_date,
        daily_direction: {
            status: snap.status || draft.status,
            status_color: statusColor(snap.status || draft.status),
            floor_message: normalizeDailyDirectionFloorMessage(snap.floor_message || draft.floor_message, snap.status || draft.status),
            must_wins: (snap.must_wins || draft.must_wins || []).slice(0, 3),
            posted_at: draft.posted.posted_at,
            posted_by: draft.posted.posted_by,
            updated_at: updatedAt,
            updated_by: updatedBy,
            update_count: updateCount,
            label: 'Daily Direction',
        },
        // Floor/TV clients intentionally get one current Daily Direction card.
        // Shift update history remains available in manager_meta and reports.
        shift_updates: [],
        latest_update: updateCount > 0 ? {
            sequence: updateCount,
            posted_at: updatedAt,
            posted_by: updatedBy,
        } : null,
        update_count: updateCount,
        updated_at: updatedAt,
        updated_by: updatedBy,
        /** flat fields for backward compatibility */
        status: snap.status || draft.status,
        status_color: statusColor(snap.status || draft.status),
        floor_message: normalizeDailyDirectionFloorMessage(snap.floor_message || draft.floor_message, snap.status || draft.status),
        must_wins: (snap.must_wins || draft.must_wins || []).slice(0, 3),
        posted_at: draft.posted.posted_at,
        posted_by: draft.posted.posted_by,
    };
}

function loadDailyDirectionFloor(db, storeDate) {
    try {
        syncMustWinsWithOpenBoard(db, storeDate, { actorName: 'system' });
    } catch (_) { /* non-fatal */ }
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) return null;
    const snap = repairPostedDailyDirectionOrderDay(db, storeDate, row, 'system')
        || postedSnapshotWithLiveOrderDay(db, storeDate, parseJson(row.posted_snapshot_json, {}), row.floor_message || '');
    const status = snap.status || 'yellow';
    const updateCount = Number(snap.update_sequence || 0);
    const updatedAt = snap.last_updated_at || row.posted_at;
    const updatedBy = snap.last_updated_by || row.posted_by;
    return {
        store_date: storeDate,
        daily_direction: {
            status,
            status_color: statusColor(status),
            floor_message: normalizeDailyDirectionFloorMessage(snap.floor_message || row.floor_message || '', status),
            must_wins: (snap.must_wins || []).slice(0, 3),
            posted_at: row.posted_at,
            posted_by: row.posted_by,
            updated_at: updatedAt,
            updated_by: updatedBy,
            update_count: updateCount,
            label: 'Daily Direction',
        },
        // Floor/TV clients intentionally get one current Daily Direction card.
        // Shift update history remains available in manager_meta and reports.
        shift_updates: [],
        latest_update: updateCount > 0 ? {
            sequence: updateCount,
            posted_at: updatedAt,
            posted_by: updatedBy,
        } : null,
        update_count: updateCount,
        updated_at: updatedAt,
        updated_by: updatedBy,
        status,
        status_color: statusColor(status),
        floor_message: normalizeDailyDirectionFloorMessage(snap.floor_message || row.floor_message || '', status),
        must_wins: (snap.must_wins || []).slice(0, 3),
        posted_at: row.posted_at,
        posted_by: row.posted_by,
    };
}

function loadDailyDirectionReportView(db, storeDate) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) return null;

    const snap = repairPostedDailyDirectionOrderDay(db, storeDate, row, 'system')
        || postedSnapshotWithLiveOrderDay(db, storeDate, parseJson(row.posted_snapshot_json, {}), row.floor_message || '');
    const status = String(snap.status || row.status_override || 'yellow').toLowerCase();
    const mustWins = (Array.isArray(snap.must_wins) ? snap.must_wins : parseJson(row.must_wins_json, []))
        .slice(0, 3)
        .map(normalizeMustWin)
        .filter((w) => w.text);
    const shiftUpdates = loadShiftUpdates(db, storeDate);

    return {
        store_date: storeDate,
        source: 'posted_archive',
        archived: true,
        status,
        status_color: statusColor(status),
        day_context: snap.day_context || {},
        floor_message: normalizeDailyDirectionFloorMessage(snap.floor_message || row.floor_message || '', status),
        must_wins: mustWins,
        walk_notes: snap.walk_notes || parseJson(row.walk_notes_json, emptyWalkNotes()),
        manager_only_notes: snap.manager_only_notes || row.manager_only_notes || '',
        posted: {
            posted_at: row.posted_at,
            posted_by: row.posted_by,
            posted_msg_id: row.posted_msg_id,
            snapshot: snap,
        },
        shift_updates: shiftUpdates,
        amendment_suggestion: null,
        can_edit: false,
        can_post_shift_update: false,
    };
}

module.exports = {
    loadShiftUpdates,
    nextShiftUpdateSequence,
    updatePostedSnapshotMessage,
    buildDailyDirectionDraft,
    buildDailyDirectionFloorView,
    loadDailyDirectionFloor,
    loadDailyDirectionReportView,
};
