'use strict';

const DEFAULT_TZ = 'America/Toronto';

const KNOWN_ALIASES = {
    'america/edmonton': 'America/Edmonton',
    'america/toronto': 'America/Toronto',
    'america/vancouver': 'America/Vancouver',
    'america/winnipeg': 'America/Winnipeg',
    'america/halifax': 'America/Halifax',
    'america/st_johns': 'America/St_Johns',
};

function fixRegionCityCasing(tz) {
    const parts = String(tz || '').trim().split('/');
    if (parts.length !== 2) return String(tz || '').trim();
    const region = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
    let city = parts[1];
    if (/^e[A-Z]/.test(city)) {
        city = `E${city.slice(1).toLowerCase()}`;
    } else if (/^[a-z]/.test(city)) {
        city = city.charAt(0).toUpperCase() + city.slice(1);
    }
    return `${region}/${city}`;
}

function isValidTimezone(tz) {
    if (!tz) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
        return true;
    } catch {
        return false;
    }
}

/**
 * Normalize store timezone strings (typos, casing) and fall back when invalid.
 * @returns {{ timezone: string, corrected: boolean, invalid: boolean }}
 */
function normalizeStoreTimezone(raw, fallback = DEFAULT_TZ) {
    const rawTrimmed = String(raw || '').trim();
    let tz = fixRegionCityCasing(rawTrimmed);
    if (!tz) return { timezone: fallback, corrected: false, invalid: false };

    const alias = KNOWN_ALIASES[tz.toLowerCase()];
    if (alias) tz = alias;
    const corrected = tz !== rawTrimmed;

    if (isValidTimezone(tz)) {
        return { timezone: tz, corrected, invalid: false };
    }
    return { timezone: fallback, corrected: true, invalid: true };
}

module.exports = {
    DEFAULT_TZ,
    normalizeStoreTimezone,
    isValidTimezone,
    fixRegionCityCasing,
};
