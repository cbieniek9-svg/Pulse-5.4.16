'use strict';

const { getStoreMeta } = require('../constants/store-meta.cjs');
const { addDaysToDateStamp } = require('./store-time.cjs');

const STORE_HOUR_DEFAULTS = {
    Store_Open_Hour: '7',
    Store_Close_Weekday: '20',
    Store_Close_Sunday: '18',
};

function parseHour(settings, key, fallback) {
    const n = parseInt(settings?.[key], 10);
    return Number.isFinite(n) ? n : fallback;
}

function getStoreHourSettings(settings = {}) {
    return {
        openHour: parseHour(settings, 'Store_Open_Hour', 7),
        closeWeekday: parseHour(settings, 'Store_Close_Weekday', 20),
        closeSunday: parseHour(settings, 'Store_Close_Sunday', 18),
        timezone: getStoreMeta(settings).timezone,
    };
}

function localParts(date, timeZone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    }).formatToParts(date).reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});
}

function ymdFromDate(date, timeZone) {
    const p = localParts(date, timeZone);
    return `${p.year}-${p.month}-${p.day}`;
}

function weekdayShort(date, timeZone) {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
}

/** Resolve UTC ms for a store-local calendar date + clock time. */
function utcMsForStoreLocal(ymd, hour, minute, timeZone) {
    const [y, m, d] = String(ymd).split('-').map(Number);
    if (!y || !m || !d) return NaN;
    const targetMin = hour * 60 + minute;
    let guess = Date.UTC(y, m - 1, d, hour, minute, 0);
    for (let offsetH = -18; offsetH <= 18; offsetH += 1) {
        const ms = guess + offsetH * 3600000;
        const p = localParts(new Date(ms), timeZone);
        const stamp = `${p.year}-${p.month}-${p.day}`;
        const mins = parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10);
        if (stamp === ymd && mins === targetMin) return ms;
    }
    return guess;
}

function closeHourForYmd(ymd, timeZone, settings) {
    const noonMs = utcMsForStoreLocal(ymd, 12, 0, timeZone);
    const wd = weekdayShort(new Date(noonMs), timeZone);
    const { closeWeekday, closeSunday } = getStoreHourSettings(settings);
    return wd === 'Sun' ? closeSunday : closeWeekday;
}

/**
 * Minutes of order clock that fall inside store open hours (default 7:00 open).
 */
function computeWithinStoreHoursMinutes(orderStartIso, orderEndIso, settings = {}) {
    const startMs = Date.parse(orderStartIso);
    const endMs = Date.parse(orderEndIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;

    const { openHour, timezone } = getStoreHourSettings(settings);
    const startYmd = ymdFromDate(new Date(startMs), timezone);
    const endYmd = ymdFromDate(new Date(endMs), timezone);

    let total = 0;
    let ymd = startYmd;
    let guard = 0;
    while (ymd <= endYmd && guard++ < 14) {
        const closeHour = closeHourForYmd(ymd, timezone, settings);
        const openMs = utcMsForStoreLocal(ymd, openHour, 0, timezone);
        const closeMs = utcMsForStoreLocal(ymd, closeHour, 0, timezone);
        if (Number.isFinite(openMs) && Number.isFinite(closeMs) && closeMs > openMs) {
            const segStart = Math.max(startMs, openMs);
            const segEnd = Math.min(endMs, closeMs);
            if (segEnd > segStart) total += Math.round((segEnd - segStart) / 60000);
        }
        ymd = addDaysToDateStamp(ymd, 1);
    }
    return total;
}

function orderSpansCalendarDay(orderStartIso, orderEndIso, settings = {}) {
    const startMs = Date.parse(orderStartIso);
    const endMs = Date.parse(orderEndIso);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
    const tz = getStoreHourSettings(settings).timezone;
    return ymdFromDate(new Date(startMs), tz) !== ymdFromDate(new Date(endMs), tz);
}

module.exports = {
    STORE_HOUR_DEFAULTS,
    getStoreHourSettings,
    computeWithinStoreHoursMinutes,
    orderSpansCalendarDay,
};
