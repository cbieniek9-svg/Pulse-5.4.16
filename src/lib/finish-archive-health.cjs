'use strict';

const { addDaysToDateStamp } = require('./store-time.cjs');
const {
    WEEKDAY_NAMES,
    isCompleteOrderDay,
    weekdayFromStoreDate,
} = require('./order-weekly-scorecard.cjs');

function wasTgpOrderDay(db, weekdayName) {
    try {
        return !!db.get(
            "SELECT 1 FROM rhythm_tasks WHERE day=? AND detail='TGP Order' LIMIT 1",
            weekdayName || '',
        );
    } catch (_) {
        return false;
    }
}

/**
 * Scan FINISH archive quality for Phase 0 / scorecard trust.
 * @param {object} db
 * @param {{ asOfDate?: string, windowDays?: number }} [opts]
 */
function buildFinishArchiveHealth(db, { asOfDate, windowDays = 56 } = {}) {
    const end = asOfDate || new Date().toISOString().slice(0, 10);
    const start = addDaysToDateStamp(end, -(windowDays - 1));

    let history = [];
    try {
        history = db.all(`
            SELECT store_date, order_start, order_end, total_pieces, staff_count,
                   actual_order_minutes, actual_pieces_per_hour
            FROM shift_order_history
            WHERE store_date BETWEEN ? AND ?
            ORDER BY store_date DESC
        `, start, end);
    } catch (_) {
        history = [];
    }

    const byDate = new Map(history.map((r) => [r.store_date, r]));
    const complete = history.filter(isCompleteOrderDay);
    const incomplete_rows = history.filter((r) => r.store_date && !isCompleteOrderDay(r)).map((r) => ({
        store_date: r.store_date,
        order_start: r.order_start || '',
        order_end: r.order_end || '',
        actual_order_minutes: Number(r.actual_order_minutes || 0),
    }));

    const orderWeekdays = WEEKDAY_NAMES.filter((wd) => wasTgpOrderDay(db, wd));
    const missing_finish_days = [];

    for (let i = 0; i < windowDays; i++) {
        const d = addDaysToDateStamp(end, -i);
        if (d < start) break;
        const wdIdx = weekdayFromStoreDate(d);
        const weekday = wdIdx != null ? WEEKDAY_NAMES[wdIdx] : null;
        if (!weekday || !orderWeekdays.includes(weekday)) continue;
        const row = byDate.get(d);
        if (!row || !isCompleteOrderDay(row)) {
            missing_finish_days.push({ store_date: d, weekday });
        }
    }

    missing_finish_days.sort((a, b) => String(b.store_date).localeCompare(String(a.store_date)));

    const completeDays = complete.length;
    let trust = 'building';
    if (completeDays >= 24) trust = 'strong';
    else if (completeDays >= 8) trust = 'usable';

    const phase0_ready = completeDays >= 8 && missing_finish_days.length <= 2;

    return {
        window_start: start,
        window_end: end,
        window_days: windowDays,
        complete_order_days: completeDays,
        incomplete_rows: incomplete_rows.slice(0, 12),
        missing_finish_days: missing_finish_days.slice(0, 14),
        order_weekdays: orderWeekdays,
        phase0_ready: phase0_ready,
        scorecard_trust: trust,
        message: phase0_ready
            ? 'Scorecard and order briefing are usable — keep FINISH on every order day.'
            : (completeDays === 0
                ? 'No archived order days yet — run FINISH at end of each order shift.'
                : `Building archive (${completeDays} complete days) — need clean FINISH rows through 4–8 weeks.`),
    };
}

module.exports = { buildFinishArchiveHealth, wasTgpOrderDay };
