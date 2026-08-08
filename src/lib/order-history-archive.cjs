'use strict';

const {
    computeArchivedOrderMetrics,
    resolveOrderPieceCounts,
    computeStandardOrderHours,
    resolveOrderStaffCount,
} = require('./shift-metrics.cjs');
const { computeWithinStoreHoursMinutes, orderSpansCalendarDay } = require('./store-hours.cjs');

/**
 * Raw clock span vs store-hours duration (7am–close). Used by archive + manager corrections.
 * @returns {{ rawClockMinutes: number, actualOrderMinutes: number, spansCalendarDay: 0|1 }}
 */
function computeOrderClockMetrics(orderStart, orderEnd, settings = {}) {
    const rawClockMinutes = (orderStart && orderEnd && Date.parse(orderEnd) >= Date.parse(orderStart))
        ? Math.round((Date.parse(orderEnd) - Date.parse(orderStart)) / 60000)
        : 0;
    const withinStoreMinutes = (orderStart && orderEnd)
        ? computeWithinStoreHoursMinutes(orderStart, orderEnd, settings)
        : 0;
    const actualOrderMinutes = withinStoreMinutes > 0 ? withinStoreMinutes : rawClockMinutes;
    const spansCalendarDay = orderStart && orderEnd && orderSpansCalendarDay(orderStart, orderEnd, settings) ? 1 : 0;
    return { rawClockMinutes, actualOrderMinutes, spansCalendarDay };
}

/** Order day is always the calendar day the clock **started** (TGP order day). */
function resolveOrderStoreDate(orderStart, orderEnd, getStoreDateStamp) {
    if (orderStart) return getStoreDateStamp(new Date(orderStart));
    if (orderEnd) return getStoreDateStamp(new Date(orderEnd));
    return getStoreDateStamp();
}

function isOrderAlreadyArchived(db, storeDate) {
    const row = db.get('SELECT order_end FROM shift_order_history WHERE store_date = ?', storeDate);
    return !!(row && String(row.order_end || '').trim());
}

function readExistingOrderHistory(db, storeDate) {
    if (typeof db.get !== 'function') return {};
    return db.get('SELECT * FROM shift_order_history WHERE store_date = ?', storeDate) || {};
}

/**
 * Write or refresh dry (grocery) portion of shift_order_history.
 * When clockKind === 'dry', preserves any existing frozen_* archive fields.
 */
function upsertShiftOrderHistory(db, {
    orderStart,
    orderEnd,
    recordedAt,
    storeDate,
    settings = {},
    counts = {},
    staffCount: staffCountOverride,
    staffRoster = null,
    exceptionReason = null,
    clockKind = 'both',
}) {
    const existing = readExistingOrderHistory(db, storeDate);
    const groceryPieces = Number(counts.grocery || 0);
    const hardwareRaw = Number(counts.hardware || 0);
    const hardwareArrived = settings.Hardware_Arrived === '1';

    // Dry clock archives grocery (+ hardware); frozen pieces come from frozen finish or legacy both-mode.
    let frozenPieces = Number(counts.frozen || 0);
    if (clockKind === 'dry') {
        frozenPieces = Number(existing.frozen_pieces || 0);
    }

    const resolved = resolveOrderPieceCounts({
        grocery: groceryPieces,
        frozen: frozenPieces,
        hardware: hardwareRaw,
        hardwareArrived,
    });

    const staffCount = (staffCountOverride != null && Number(staffCountOverride) > 0)
        ? Math.max(1, Math.min(99, Number(staffCountOverride)))
        : resolveOrderStaffCount(counts, db);

    const totalPieces = resolved.total_pieces;
    const cph = parseFloat(settings.Cases_Per_Hour) || 55;
    const hardwareCph = parseFloat(settings.Hardware_CPH) || 50;
    const standardHours = computeStandardOrderHours(
        groceryPieces, frozenPieces, hardwareRaw, cph, hardwareCph, hardwareArrived,
    );

    const { rawClockMinutes, actualOrderMinutes, spansCalendarDay: spansDay } = computeOrderClockMetrics(
        orderStart, orderEnd, settings,
    );

    // Dry PPH uses grocery + hardware only when clocks are decoupled.
    const dryPieces = groceryPieces + (hardwareArrived ? hardwareRaw : 0);
    const metricsPieces = clockKind === 'dry' ? dryPieces : totalPieces;
    const metrics = computeArchivedOrderMetrics(metricsPieces, actualOrderMinutes, staffCount);

    const rosterJson = Array.isArray(staffRoster) && staffRoster.length
        ? JSON.stringify(staffRoster.map((n) => String(n).trim()).filter(Boolean))
        : '';
    const reasonText = exceptionReason == null ? null : String(exceptionReason).trim().slice(0, 200);

    db.run(
        `INSERT INTO shift_order_history (
            store_date, order_start, order_end, recorded_at,
            grocery_pieces, frozen_pieces, hardware_pieces, total_pieces, staff_count,
            standard_hours, actual_order_minutes, actual_pieces_per_hour,
            break_deduction_hours_per_person, adjusted_labor_hours, adjusted_per_person_pph,
            staff_roster, raw_clock_minutes, spans_calendar_day, exception_reason,
            frozen_order_start, frozen_order_end, frozen_staff_count, frozen_actual_minutes, frozen_pieces_per_hour
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(store_date) DO UPDATE SET
            order_start=excluded.order_start,
            order_end=excluded.order_end,
            recorded_at=excluded.recorded_at,
            grocery_pieces=excluded.grocery_pieces,
            frozen_pieces=CASE WHEN ? = 'dry' THEN shift_order_history.frozen_pieces ELSE excluded.frozen_pieces END,
            hardware_pieces=excluded.hardware_pieces,
            total_pieces=excluded.grocery_pieces
                + CASE WHEN ? = 'dry' THEN COALESCE(shift_order_history.frozen_pieces, 0) ELSE excluded.frozen_pieces END
                + excluded.hardware_pieces,
            staff_count=excluded.staff_count,
            standard_hours=excluded.standard_hours,
            actual_order_minutes=excluded.actual_order_minutes,
            actual_pieces_per_hour=excluded.actual_pieces_per_hour,
            break_deduction_hours_per_person=excluded.break_deduction_hours_per_person,
            adjusted_labor_hours=excluded.adjusted_labor_hours,
            adjusted_per_person_pph=excluded.adjusted_per_person_pph,
            staff_roster=excluded.staff_roster,
            raw_clock_minutes=excluded.raw_clock_minutes,
            spans_calendar_day=excluded.spans_calendar_day,
            exception_reason=COALESCE(excluded.exception_reason, shift_order_history.exception_reason),
            frozen_order_start=COALESCE(shift_order_history.frozen_order_start, excluded.frozen_order_start),
            frozen_order_end=COALESCE(shift_order_history.frozen_order_end, excluded.frozen_order_end),
            frozen_staff_count=COALESCE(shift_order_history.frozen_staff_count, excluded.frozen_staff_count),
            frozen_actual_minutes=COALESCE(shift_order_history.frozen_actual_minutes, excluded.frozen_actual_minutes),
            frozen_pieces_per_hour=COALESCE(shift_order_history.frozen_pieces_per_hour, excluded.frozen_pieces_per_hour)`,
        storeDate, orderStart, orderEnd, recordedAt,
        resolved.grocery_pieces, frozenPieces, resolved.hardware_pieces, totalPieces, staffCount,
        Number(standardHours.toFixed(2)), actualOrderMinutes, metrics.team_pph,
        metrics.break_deduction_hours_per_person, metrics.adjusted_labor_hours, metrics.adjusted_per_person_pph,
        rosterJson, rawClockMinutes, spansDay, reasonText,
        existing.frozen_order_start || null,
        existing.frozen_order_end || null,
        Number(existing.frozen_staff_count || 0),
        Number(existing.frozen_actual_minutes || 0),
        Number(existing.frozen_pieces_per_hour || 0),
        clockKind,
        clockKind,
    );

    return { storeDate, actualOrderMinutes, rawClockMinutes, shiftTotalPph: metrics.team_pph, spansCalendarDay: spansDay };
}

/** Archive frozen clock onto the same store_date row without wiping dry fields. */
function upsertFrozenOrderHistory(db, {
    frozenOrderStart,
    frozenOrderEnd,
    recordedAt,
    storeDate,
    settings = {},
    counts = {},
    frozenStaffCount,
    staffRoster = null,
    exceptionReason = null,
}) {
    const existing = readExistingOrderHistory(db, storeDate);
    const frozenPieces = Number(counts.frozen || 0);
    const staff = Math.max(1, Math.min(99, Number(frozenStaffCount) || 1));
    const { rawClockMinutes, actualOrderMinutes } = computeOrderClockMetrics(
        frozenOrderStart, frozenOrderEnd, settings,
    );
    const metrics = computeArchivedOrderMetrics(frozenPieces, actualOrderMinutes, staff);
    const grocery = Number(existing.grocery_pieces || counts.grocery || 0);
    const hardware = Number(existing.hardware_pieces || 0);
    const totalPieces = grocery + frozenPieces + hardware;
    const reasonText = exceptionReason == null ? null : String(exceptionReason).trim().slice(0, 200);
    const rosterJson = Array.isArray(staffRoster) && staffRoster.length
        ? JSON.stringify(staffRoster.map((n) => String(n).trim()).filter(Boolean))
        : (existing.staff_roster || '');

    db.run(
        `INSERT INTO shift_order_history (
            store_date, order_start, order_end, recorded_at,
            grocery_pieces, frozen_pieces, hardware_pieces, total_pieces, staff_count,
            standard_hours, actual_order_minutes, actual_pieces_per_hour,
            break_deduction_hours_per_person, adjusted_labor_hours, adjusted_per_person_pph,
            staff_roster, raw_clock_minutes, spans_calendar_day, exception_reason,
            frozen_order_start, frozen_order_end, frozen_staff_count, frozen_actual_minutes, frozen_pieces_per_hour
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(store_date) DO UPDATE SET
            recorded_at=excluded.recorded_at,
            frozen_pieces=excluded.frozen_pieces,
            total_pieces=COALESCE(shift_order_history.grocery_pieces, 0)
                + excluded.frozen_pieces
                + COALESCE(shift_order_history.hardware_pieces, 0),
            frozen_order_start=excluded.frozen_order_start,
            frozen_order_end=excluded.frozen_order_end,
            frozen_staff_count=excluded.frozen_staff_count,
            frozen_actual_minutes=excluded.frozen_actual_minutes,
            frozen_pieces_per_hour=excluded.frozen_pieces_per_hour,
            exception_reason=COALESCE(excluded.exception_reason, shift_order_history.exception_reason)`,
        storeDate,
        existing.order_start || '',
        existing.order_end || '',
        recordedAt,
        grocery,
        frozenPieces,
        hardware,
        totalPieces,
        Number(existing.staff_count || 1),
        Number(existing.standard_hours || 0),
        Number(existing.actual_order_minutes || 0),
        Number(existing.actual_pieces_per_hour || 0),
        Number(existing.break_deduction_hours_per_person || 0),
        Number(existing.adjusted_labor_hours || 0),
        Number(existing.adjusted_per_person_pph || 0),
        rosterJson,
        Number(existing.raw_clock_minutes || 0),
        Number(existing.spans_calendar_day || 0),
        reasonText,
        frozenOrderStart,
        frozenOrderEnd,
        staff,
        actualOrderMinutes,
        metrics.team_pph,
    );

    return {
        storeDate,
        frozenActualMinutes: actualOrderMinutes,
        rawClockMinutes,
        frozenPph: metrics.team_pph,
        shiftTotalPph: metrics.team_pph,
    };
}

module.exports = {
    resolveOrderStoreDate,
    isOrderAlreadyArchived,
    upsertShiftOrderHistory,
    upsertFrozenOrderHistory,
    computeOrderClockMetrics,
};
