'use strict';

const {
    WEEKDAY_NAMES,
    isCompleteOrderDay,
    weekdayFromStoreDate,
    buildOrderWeeklyScorecard,
} = require('./order-weekly-scorecard.cjs');

function pieceRange(rows) {
    const pieces = rows.map((r) => Number(r.total_pieces || 0)).filter((n) => n > 0);
    if (!pieces.length) return { min: null, max: null };
    return { min: Math.min(...pieces), max: Math.max(...pieces) };
}

function round1(v) {
    if (v == null || Number.isNaN(v)) return null;
    return Math.round(v * 10) / 10;
}

function safeGet(db, sql, ...params) {
    try {
        if (!db || typeof db.get !== 'function') return null;
        return db.get(sql, ...params) || null;
    } catch (_) {
        return null;
    }
}

function isTgpVendorName(value) {
    const v = String(value || '').trim();
    return /^(TGP|THE\s+GROCERY\s+PEOPLE)\b/i.test(v);
}

const TGP_ORDER_WEEKDAYS = Object.freeze(new Set(['Sunday', 'Tuesday', 'Thursday']));

function normalizeWeekdayName(value) {
    const raw = String(value || '').trim().toLowerCase();
    return WEEKDAY_NAMES.find((day) => day.toLowerCase() === raw) || '';
}

function weekdayNameFromDateStamp(storeDate) {
    const raw = String(storeDate || '').trim();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (Number.isNaN(date.getTime())) return '';
    return WEEKDAY_NAMES[date.getUTCDay()] || '';
}

function isFixedTgpOrderWeekday(value) {
    return TGP_ORDER_WEEKDAYS.has(normalizeWeekdayName(value));
}

function resolveDatedOrderDaySignals(db, storeDate, storeWeekday = '') {
    const sources = [];
    if (!storeDate && !storeWeekday) return { is_order_day: false, sources };

    const weekday = normalizeWeekdayName(storeWeekday) || weekdayNameFromDateStamp(storeDate);
    if (isFixedTgpOrderWeekday(weekday)) {
        sources.push('tgp_weekday_schedule');
    }

    // Dated operational activity is retained as context, but it does not decide
    // the calendar label. TGP order days for this store are Sunday/Tuesday/Thursday.
    if (storeDate && sources.length) {
        const expectedTgp = safeGet(db, `
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
        if (expectedTgp && isTgpVendorName(expectedTgp.vendor)) sources.push('received_tgp');

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
        if (archivedOrder) sources.push('shift_order_history');

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
        if (tgpTask) sources.push('tgp_work_task');
    }

    return {
        is_order_day: sources.includes('tgp_weekday_schedule'),
        sources: [...new Set(sources)],
    };
}

/**
 * Pre-order briefing for today's weekday from archived FINISH rows.
 * @param {object} db
 * @param {{ storeDate: string, storeWeekday?: string, windowDays?: number }} opts
 */
function buildOrderDayBriefing(db, { storeDate, storeWeekday, windowDays = 90 } = {}) {
    const today = storeDate || new Date().toISOString().slice(0, 10);
    const weekdayIndex = weekdayFromStoreDate(today);
    const weekday = storeWeekday || (weekdayIndex != null ? WEEKDAY_NAMES[weekdayIndex] : null);

    const historyRows = db.all(`
        SELECT store_date, order_start, order_end, total_pieces, staff_count,
               actual_order_minutes, actual_pieces_per_hour, adjusted_per_person_pph
        FROM shift_order_history
        ORDER BY store_date DESC
        LIMIT ?
    `, Math.max(windowDays, 90));

    const complete = historyRows.filter(isCompleteOrderDay);
    const scorecard = buildOrderWeeklyScorecard(complete, { windowDays });
    const weekdayRow = scorecard.by_weekday.find((r) => r.weekday === weekday) || null;

    const sameWeekdayRows = complete
        .filter((r) => weekdayFromStoreDate(r.store_date) === weekdayIndex)
        .sort((a, b) => String(b.store_date).localeCompare(String(a.store_date)));

    const recentSameWeekday = sameWeekdayRows.slice(0, 3).map((r) => ({
        store_date: r.store_date,
        total_pieces: Number(r.total_pieces || 0),
        staff_count: Math.max(1, Number(r.staff_count || 1)),
        actual_order_minutes: Number(r.actual_order_minutes || 0),
        team_pph: round1(Number(r.actual_pieces_per_hour || 0)),
    }));

    const range = pieceRange(sameWeekdayRows);

    const fixedTgpOrderDay = isFixedTgpOrderWeekday(weekday);
    const datedOrderDay = resolveDatedOrderDaySignals(db, today, weekday);

    return {
        store_date: today,
        weekday,
        is_order_day: fixedTgpOrderDay,
        scheduled_order_day: fixedTgpOrderDay,
        order_day_sources: datedOrderDay.sources,
        sample_count: sameWeekdayRows.length,
        expected_pieces: weekdayRow ? {
            avg: weekdayRow.avg_pieces,
            min: range.min,
            max: range.max,
        } : null,
        expected_duration_minutes: weekdayRow?.avg_minutes ?? null,
        expected_staff: weekdayRow?.avg_staff ?? null,
        expected_team_pph: weekdayRow?.avg_team_pph ?? null,
        recent_same_weekday: recentSameWeekday,
        scorecard_window_days: windowDays,
    };
}

module.exports = { buildOrderDayBriefing, weekdayFromStoreDate, resolveDatedOrderDaySignals };
