'use strict';

const { getStoreMeta } = require('../constants/store-meta.cjs');
const { normalizeStoreTimezone, DEFAULT_TZ } = require('./store-timezone.cjs');

function dateStampFromParts(parts) {
    const values = parts.reduce((acc, part) => {
        if (part.type !== 'literal') acc[part.type] = part.value;
        return acc;
    }, {});
    return `${values.year}-${values.month}-${values.day}`;
}

function createFormatters(timeZone, allowFallback = true) {
    const tz = timeZone || DEFAULT_TZ;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    } catch (_) {
        if (allowFallback && tz !== DEFAULT_TZ) return createFormatters(DEFAULT_TZ, false);
    }
    return {
        stamp: new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }),
        weekday: new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }),
        time: new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
        }),
        timeShort: new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }),
        dateShort: new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }),
    };
}

/**
 * @param {function(): Record<string, string>} getSettings
 */
function createStoreTimeAccessors(getSettings) {
    function getTimezone() {
        try {
            const settings = getSettings() || {};
            const raw = getStoreMeta(settings).timezone || DEFAULT_TZ;
            return normalizeStoreTimezone(raw, DEFAULT_TZ).timezone;
        } catch (_) {
            return DEFAULT_TZ;
        }
    }

    function getStoreDateStamp(date = new Date()) {
        const fmt = createFormatters(getTimezone()).stamp;
        return dateStampFromParts(fmt.formatToParts(date));
    }

    function getStoreDayName(date = new Date()) {
        return createFormatters(getTimezone()).weekday.format(date);
    }

    function getStoreClockPayload(date = new Date()) {
        const tz = getTimezone();
        const fmt = createFormatters(tz);
        return {
            storeDate: getStoreDateStamp(date),
            storeWeekday: fmt.weekday.format(date).toUpperCase(),
            storeDateLabel: fmt.dateShort.format(date).toUpperCase(),
            storeTime: fmt.timeShort.format(date),
            storeTimeSeconds: fmt.time.format(date),
            storeTimezone: tz,
        };
    }

    return { getStoreDateStamp, getStoreDayName, getStoreClockPayload, getTimezone };
}

/**
 * Minutes the store timezone is offset from UTC at `date` (negative = west of UTC).
 * Computed via Intl so DST is handled for the given instant.
 * @param {string} timeZone IANA tz
 * @param {Date} [date]
 * @returns {number}
 */
function utcOffsetMinutes(timeZone, date = new Date()) {
    try {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || DEFAULT_TZ, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        const p = dtf.formatToParts(date).reduce((acc, part) => {
            if (part.type !== 'literal') acc[part.type] = part.value;
            return acc;
        }, {});
        const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
        return Math.round((asUTC - date.getTime()) / 60000);
    } catch (_) {
        return 0;
    }
}

/**
 * SQLite datetime modifier that shifts a UTC timestamp into store-local time,
 * e.g. "-240 minutes". Use as `date(col, <modifier>)` so date-bucketing matches
 * the store's calendar day instead of UTC's.
 * @param {string} timeZone IANA tz
 * @param {Date} [date] reference instant (for DST)
 * @returns {string}
 */
function sqliteTzOffsetModifier(timeZone, date = new Date()) {
    const m = utcOffsetMinutes(timeZone, date);
    return `${m >= 0 ? '+' : '-'}${Math.abs(m)} minutes`;
}

/** @param {string} stamp YYYY-MM-DD */
function addDaysToDateStamp(stamp, days) {
    const [y, m, d] = String(stamp).split('-').map(Number);
    if (!y || !m || !d) return stamp;
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
}

const WEEKDAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

/**
 * Normalize clock/API weekday strings to vendor_schedule / rhythm_tasks day labels.
 * getStoreClockPayload uses uppercase ("SUNDAY"); DB rows use title case ("Sunday").
 */
function vendorScheduleWeekday(storeWeekday, storeDate) {
    const raw = String(storeWeekday || '').trim().toLowerCase();
    const hit = WEEKDAY_NAMES.find((day) => day.toLowerCase() === raw);
    if (hit) return hit;
    return weekdayNameFromDateStamp(storeDate);
}

/** Weekday name for a YYYY-MM-DD stamp (noon UTC anchor — stable calendar-day weekday). */
function weekdayNameFromDateStamp(stamp, timeZone = DEFAULT_TZ) {
    const m = String(stamp || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0));
    if (Number.isNaN(date.getTime())) return '';
    try {
        return createFormatters(timeZone).weekday.format(date);
    } catch (_) {
        return WEEKDAY_NAMES[date.getUTCDay()] || '';
    }
}

/** 0=Sun … 6=Sat for a YYYY-MM-DD stamp. */
function weekdayIndexFromDateStamp(stamp, timeZone = DEFAULT_TZ) {
    const name = weekdayNameFromDateStamp(stamp, timeZone);
    const idx = WEEKDAY_NAMES.indexOf(name);
    return idx >= 0 ? idx : null;
}

/** Format parsed Date as YYYY-MM-DD using UTC calendar parts (avoids toISOString TZ shift). */
function dateStampFromParsedDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Build a UTC ISO instant for a store-local civil time on YYYY-MM-DD.
 * Used so SQLite `date(col, tzMod)` lands on the store stamp (rhythm inserts, etc.).
 */
function utcIsoFromStoreLocal(stamp, timeZone, hour = 12, minute = 0, second = 0) {
    const m = String(stamp || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date().toISOString();
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    let utcMs = Date.UTC(y, mo - 1, d, hour, minute, second);
    for (let i = 0; i < 4; i += 1) {
        const offsetMin = utcOffsetMinutes(timeZone || DEFAULT_TZ, new Date(utcMs));
        const desiredAsIfUtc = Date.UTC(y, mo - 1, d, hour, minute, second);
        utcMs = desiredAsIfUtc - (offsetMin * 60000);
    }
    return new Date(utcMs).toISOString();
}

/** Parse store clock strings like "7:15 AM" / "14:30" into 24h parts. */
function parseStoreClockHms(storeTime) {
    const raw = String(storeTime || '').trim();
    if (!raw) return { hour: 12, minute: 0, second: 0 };
    const m12 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
    if (m12) {
        let hour = Number(m12[1]) % 12;
        if (String(m12[4]).toUpperCase() === 'PM') hour += 12;
        return { hour, minute: Number(m12[2]), second: Number(m12[3] || 0) };
    }
    const m24 = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m24) {
        return {
            hour: Math.min(23, Number(m24[1])),
            minute: Number(m24[2]),
            second: Number(m24[3] || 0),
        };
    }
    return { hour: 12, minute: 0, second: 0 };
}

/**
 * Rhythm board inserts: always stamp against the store calendar day being seeded
 * (store-local clock when available, else noon) so openToday / completeness match.
 */
function rhythmSubmittedAtIso(deps, stamp) {
    const tz = typeof deps.getTimezone === 'function'
        ? deps.getTimezone()
        : (typeof deps.getStoreClockPayload === 'function'
            ? deps.getStoreClockPayload()?.storeTimezone
            : DEFAULT_TZ);
    const storeTime = deps.storeTime
        || (typeof deps.getStoreClockPayload === 'function' ? deps.getStoreClockPayload()?.storeTime : '')
        || '';
    const { hour, minute, second } = parseStoreClockHms(storeTime);
    return utcIsoFromStoreLocal(stamp, tz || DEFAULT_TZ, hour, minute, second);
}

module.exports = {
    createStoreTimeAccessors,
    createFormatters,
    addDaysToDateStamp,
    utcOffsetMinutes,
    sqliteTzOffsetModifier,
    DEFAULT_TZ,
    WEEKDAY_NAMES,
    vendorScheduleWeekday,
    weekdayNameFromDateStamp,
    weekdayIndexFromDateStamp,
    dateStampFromParsedDate,
    utcIsoFromStoreLocal,
    parseStoreClockHms,
    rhythmSubmittedAtIso,
};
