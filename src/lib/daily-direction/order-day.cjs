'use strict';

const {
    resolveTgpOrderWeekday,
    isTgpOrderWeekday,
    datePart,
    safeAll,
    safeGet,
    isTgpVendorName,
    parseJson,
    nowIso,
    normalizeDefaultOrderDayLabel,
} = require('./helpers.cjs');

function postedSnapshotWithLiveOrderDay(db, storeDate, snapshot, fallbackFloorMessage = '', liveCtx = {}) {
    const snap = snapshot && typeof snapshot === 'object' ? { ...snapshot } : {};
    const liveOrderDay = resolveDirectionOrderDay(db, {
        storeDate,
        storeWeekday: liveCtx.storeWeekday || '',
        settings: liveCtx.settings || (typeof db?.getSettings === 'function' ? db.getSettings() : {}),
        kpis: liveCtx.kpis || {},
        orderDayBriefing: liveCtx.orderDayBriefing || null,
    });
    const priorCtx = snap.day_context && typeof snap.day_context === 'object' ? snap.day_context : {};
    const liveSources = Array.isArray(liveOrderDay.sources) ? liveOrderDay.sources : [];
    const priorSources = Array.isArray(priorCtx.order_day_sources) ? priorCtx.order_day_sources : [];
    const beforeMessage = String(snap.floor_message || fallbackFloorMessage || '');
    const afterMessage = beforeMessage
        ? normalizeDefaultOrderDayLabel(beforeMessage, liveOrderDay.is_order_day)
        : beforeMessage;
    const contextChanged = priorCtx.is_order_day !== liveOrderDay.is_order_day
        || JSON.stringify(priorSources) !== JSON.stringify(liveSources);
    const messageChanged = afterMessage !== beforeMessage;

    if (!contextChanged && !messageChanged) return snap;

    snap.day_context = {
        ...priorCtx,
        is_order_day: liveOrderDay.is_order_day,
        order_day_sources: liveSources,
    };
    if (beforeMessage) {
        snap.floor_message = afterMessage;
    }
    return snap;
}

function repairPostedDailyDirectionOrderDay(db, storeDate, row, actorName = 'system', liveCtx = {}) {
    if (!row?.posted_at) return null;
    const originalSnapshot = parseJson(row.posted_snapshot_json, {});
    const repairedSnapshot = postedSnapshotWithLiveOrderDay(db, storeDate, originalSnapshot, row.floor_message || '', liveCtx);
    const snapshotChanged = JSON.stringify(repairedSnapshot) !== JSON.stringify(originalSnapshot);

    const beforeRowMessage = String(row.floor_message || '');
    const messageEdited = Number(row.floor_message_edited) === 1;
    const isOrderDay = repairedSnapshot?.day_context?.is_order_day === true;
    const afterRowMessage = (messageEdited || !beforeRowMessage)
        ? beforeRowMessage
        : normalizeDefaultOrderDayLabel(beforeRowMessage, isOrderDay);
    const rowMessageChanged = !messageEdited && afterRowMessage !== beforeRowMessage;

    if (!snapshotChanged && !rowMessageChanged) return repairedSnapshot;

    const updatedAt = nowIso();
    try {
        db.run(`
            UPDATE daily_direction SET
                floor_message = ?,
                posted_snapshot_json = ?,
                updated_at = ?,
                updated_by = ?
            WHERE store_date = ?
        `,
        afterRowMessage,
        JSON.stringify(repairedSnapshot),
        updatedAt,
        actorName,
        storeDate);
    } catch (_) { /* best-effort display repair */ }

    row.floor_message = afterRowMessage;
    row.posted_snapshot_json = JSON.stringify(repairedSnapshot);
    row.updated_at = updatedAt;
    row.updated_by = actorName;
    return repairedSnapshot;
}

/**
 * Resolve whether Daily Direction should treat the selected store date as a TGP order day.
 *
 * TGP order days are fixed calendar days for this store: Sunday, Tuesday, and Thursday.
 * The order clock and receiving/task rows are operational context only; they must not
 * move the Daily Direction label onto another weekday, especially when a clock ends
 * after midnight or stale activity remains open.
 */
function resolveDirectionOrderDay(db, {
    storeDate,
    storeWeekday,
    kpis = {},
    settings = {},
    orderDayBriefing = null,
} = {}) {
    const sources = [];
    const weekday = resolveTgpOrderWeekday({ storeDate, storeWeekday });

    if (isTgpOrderWeekday(weekday)) {
        sources.push('tgp_weekday_schedule');
    }

    if (storeDate && sources.length) {
        const orderStartDates = [
            settings?.Order_Start,
            settings?.TGP_Order_Start,
            settings?.order_start,
            settings?.tgp_order_start,
        ].map(datePart).filter(Boolean);
        if (orderStartDates.includes(storeDate)) {
            sources.push('order_clock_start');
        }

        const expectedTgp = safeAll(db, `
            SELECT vendor FROM expected_orders
            WHERE
                (
                    substr(COALESCE(arrived_at, ''), 1, 10) = ?
                    OR substr(COALESCE(departed_at, ''), 1, 10) = ?
                    OR substr(COALESCE(time_closed, ''), 1, 10) = ?
                )
                AND COALESCE(category, 'general') != 'hardware'
                AND (
                    UPPER(COALESCE(vendor, '')) LIKE 'TGP%'
                    OR UPPER(COALESCE(vendor, '')) LIKE 'THE GROCERY PEOPLE%'
                )
            LIMIT 1
        `, storeDate, storeDate, storeDate);
        if (expectedTgp.some((r) => isTgpVendorName(r.vendor))) {
            sources.push('received_tgp');
        }

        const tgpTask = safeGet(db, `
            SELECT task_id FROM tasks
            WHERE task_id LIKE 'T-TGP-%'
              AND (
                    substr(COALESCE(time_submitted, ''), 1, 10) = ?
                    OR substr(COALESCE(start_time, ''), 1, 10) = ?
                    OR substr(COALESCE(time_closed, ''), 1, 10) = ?
                )
            LIMIT 1
        `, storeDate, storeDate, storeDate);
        if (tgpTask) {
            sources.push('tgp_work_task');
        }

        const archivedOrder = safeGet(db, `
            SELECT store_date FROM shift_order_history
            WHERE store_date = ?
              AND (
                COALESCE(total_pieces, 0) > 0
                OR COALESCE(grocery_pieces, 0) > 0
                OR COALESCE(frozen_pieces, 0) > 0
                OR COALESCE(hardware_pieces, 0) > 0
                OR COALESCE(order_start, '') != ''
                OR COALESCE(order_end, '') != ''
              )
            LIMIT 1
        `, storeDate);
        if (archivedOrder) {
            sources.push('shift_order_history');
        }
    }

    return {
        is_order_day: sources.includes('tgp_weekday_schedule'),
        sources: [...new Set(sources)],
    };
}

module.exports = {
    postedSnapshotWithLiveOrderDay,
    repairPostedDailyDirectionOrderDay,
    resolveDirectionOrderDay,
};
