'use strict';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const { weekdayIndexFromDateStamp } = require('./store-time.cjs');

function isCompleteOrderDay(row) {
    if (!row || !row.store_date) return false;
    if (!row.order_start || !row.order_end) return false;
    return Number(row.actual_order_minutes || 0) > 0;
}

function weekdayFromStoreDate(storeDate) {
    return weekdayIndexFromDateStamp(storeDate);
}

function average(nums) {
    if (!nums.length) return null;
    return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function round1(value) {
    if (value == null || Number.isNaN(value)) return null;
    return Math.round(value * 10) / 10;
}

function summarizeOrderDays(rows) {
    if (!rows.length) return null;
    return {
        order_days: rows.length,
        avg_pieces: round1(average(rows.map((r) => Number(r.total_pieces || 0)))),
        avg_minutes: round1(average(rows.map((r) => Number(r.actual_order_minutes || 0)))),
        avg_staff: round1(average(rows.map((r) => Math.max(1, Number(r.staff_count || 1))))),
        avg_team_pph: round1(average(rows.map((r) => Number(r.team_pph ?? r.actual_pieces_per_hour ?? 0)))),
        avg_adj_pph: round1(average(rows.map((r) => Number(r.adjusted_per_person_pph ?? 0)))),
    };
}

/**
 * Roll up archived order days (closed clock only) for weekly planning.
 * @param {object[]} historyRows — rows like order_shift_history from reports payload
 * @param {{ windowDays?: number }} [opts]
 */
function buildOrderWeeklyScorecard(historyRows, { windowDays = 90 } = {}) {
    const complete = (historyRows || []).filter(isCompleteOrderDay);
    const overall = summarizeOrderDays(complete);
    const byWeekday = WEEKDAY_NAMES.map((weekday, weekdayIndex) => {
        const rows = complete.filter((r) => weekdayFromStoreDate(r.store_date) === weekdayIndex);
        const summary = summarizeOrderDays(rows);
        if (!summary) return null;
        return { weekday, weekday_index: weekdayIndex, ...summary };
    }).filter(Boolean);

    return {
        window_days: windowDays,
        order_days: complete.length,
        overall,
        by_weekday: byWeekday,
    };
}

module.exports = {
    WEEKDAY_NAMES,
    isCompleteOrderDay,
    weekdayFromStoreDate,
    buildOrderWeeklyScorecard,
};
