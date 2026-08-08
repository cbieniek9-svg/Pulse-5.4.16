'use strict';

const { upsertSetting } = require('../lib/settings-store.cjs');

const SHADOW_MODE = 'Financial_Log_Shadow_Mode';
const SHADOW_ALLOWLIST = 'Financial_Log_Shadow_Allowlist';

module.exports = {
    name: 'financial_log_shadow',
    up(db) {
        upsertSetting(db, SHADOW_MODE, '1');
        const existing = db.get('SELECT setting_value FROM settings WHERE setting_name=?', SHADOW_ALLOWLIST);
        if (!existing) {
            upsertSetting(db, SHADOW_ALLOWLIST, '');
        }
    },
};
