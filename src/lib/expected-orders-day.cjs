'use strict';

/**
 * Helpers for matching expected_orders rows to a store calendar day.
 * Rhythm used to store weekday names ("Monday") — those never archived at EOD.
 */

const WEEKDAY_NAMES = Object.freeze([
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);

function isDateStamp(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').trim());
}

function isWeekdayName(value) {
    const s = String(value || '').trim();
    return WEEKDAY_NAMES.includes(s);
}

/** Coerce client weekday strings (or empty) to a store calendar date stamp. */
function normalizeExpectedDay(value, getStoreDateStamp) {
    const s = String(value || '').trim();
    if (isDateStamp(s)) return s;
    if (typeof getStoreDateStamp === 'function') return getStoreDateStamp();
    return s;
}

function rhythmLoadMsFromExpId(expId) {
    const m = String(expId || '').match(/^E-(\d+)-/);
    if (!m) return null;
    const ms = Number(m[1]);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * @param {object} row expected_orders row
 * @param {string} storeDate YYYY-MM-DD
 * @param {string} storeWeekday e.g. "Monday"
 * @param {function(Date=): string} [getStoreDateStamp]
 */
function isPendingExpectedForStoreDate(row, storeDate, storeWeekday, getStoreDateStamp) {
    const ed = String(row?.expected_day || '').trim();
    if (isDateStamp(ed)) return ed === storeDate;
    if (ed && ed === storeWeekday && typeof getStoreDateStamp === 'function') {
        const ms = rhythmLoadMsFromExpId(row?.exp_id);
        if (ms == null) return false;
        return getStoreDateStamp(new Date(ms)) === storeDate;
    }
    return false;
}

function filterPendingExpectedForStoreDate(rows, storeDate, storeWeekday, getStoreDateStamp) {
    return (rows || []).filter((r) => isPendingExpectedForStoreDate(r, storeDate, storeWeekday, getStoreDateStamp));
}

module.exports = {
    isDateStamp,
    isWeekdayName,
    normalizeExpectedDay,
    rhythmLoadMsFromExpId,
    isPendingExpectedForStoreDate,
    filterPendingExpectedForStoreDate,
};
