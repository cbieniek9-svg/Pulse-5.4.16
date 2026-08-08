'use strict';

const TV_DISPLAY_TOGGLE_DEFAULTS = Object.freeze({
    TV_Show_Pinned_Daily_Huddle: false,
    TV_Show_Store_Comms: true,
    TV_Show_Audit_Trail: true,
    TV_Show_Ticker: false,
    TV_Show_Latest_Shift_Update: false,
});

const TV_DISPLAY_PREF_KEYS = Object.freeze(Object.keys(TV_DISPLAY_TOGGLE_DEFAULTS));

function settingEnabled(settings, key, defaultValue = true) {
    const raw = settings ? settings[key] : undefined;
    if (raw === undefined || raw === null || raw === '') return !!defaultValue;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    return !/^(0|false|off|no)$/i.test(String(raw).trim());
}

/**
 * Small, explicit TV-facing preference object. The TV should use this instead of
 * guessing from raw settings so manager toggles work the same for tokenless,
 * paired-device, and key-based TV sessions.
 */
function buildTvDisplayPrefs(settings = {}) {
    return {
        showPinnedDailyHuddle: settingEnabled(settings, 'TV_Show_Pinned_Daily_Huddle', TV_DISPLAY_TOGGLE_DEFAULTS.TV_Show_Pinned_Daily_Huddle),
        showStoreComms: settingEnabled(settings, 'TV_Show_Store_Comms', TV_DISPLAY_TOGGLE_DEFAULTS.TV_Show_Store_Comms),
        showAuditTrail: settingEnabled(settings, 'TV_Show_Audit_Trail', TV_DISPLAY_TOGGLE_DEFAULTS.TV_Show_Audit_Trail),
        showTicker: settingEnabled(settings, 'TV_Show_Ticker', TV_DISPLAY_TOGGLE_DEFAULTS.TV_Show_Ticker),
        showLatestShiftUpdate: settingEnabled(settings, 'TV_Show_Latest_Shift_Update', TV_DISPLAY_TOGGLE_DEFAULTS.TV_Show_Latest_Shift_Update),
    };
}

module.exports = {
    TV_DISPLAY_TOGGLE_DEFAULTS,
    TV_DISPLAY_PREF_KEYS,
    settingEnabled,
    buildTvDisplayPrefs,
};
