'use strict';

/** Settings keys for store identity (single DB per install; ready for HQ rollup labels). */
const STORE_CODE_KEY = 'Store_Code';
const STORE_DISPLAY_NAME_KEY = 'Store_Display_Name';
const STORE_TIMEZONE_KEY = 'Store_Timezone';
const STORE_INSTANCE_ID_KEY = 'Store_Instance_Id';

const STORE_META_KEYS = new Set([
    STORE_CODE_KEY,
    STORE_DISPLAY_NAME_KEY,
    STORE_TIMEZONE_KEY,
    STORE_INSTANCE_ID_KEY,
]);

const STORE_META_DEFAULTS = [
    { name: STORE_CODE_KEY, value: 'STORE-001' },
    { name: STORE_DISPLAY_NAME_KEY, value: 'TGP Center Store' },
    { name: STORE_TIMEZONE_KEY, value: 'America/Toronto' },
    // Instance id is minted by migration 029 / ensureStoreInstanceId — empty default is intentional.
    { name: STORE_INSTANCE_ID_KEY, value: '' },
];

/**
 * @param {Record<string, string>} settings — from db.getSettings()
 */
function getStoreMeta(settings = {}) {
    return {
        code: String(settings[STORE_CODE_KEY] || STORE_META_DEFAULTS[0].value).trim(),
        displayName: String(settings[STORE_DISPLAY_NAME_KEY] || STORE_META_DEFAULTS[1].value).trim(),
        timezone: String(settings[STORE_TIMEZONE_KEY] || STORE_META_DEFAULTS[2].value).trim(),
        instanceId: String(settings[STORE_INSTANCE_ID_KEY] || '').trim(),
    };
}

module.exports = {
    STORE_CODE_KEY,
    STORE_DISPLAY_NAME_KEY,
    STORE_TIMEZONE_KEY,
    STORE_INSTANCE_ID_KEY,
    STORE_META_KEYS,
    STORE_META_DEFAULTS,
    getStoreMeta,
};
