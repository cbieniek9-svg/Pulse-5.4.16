'use strict';

/**
 * Upsert a single settings row (insert if missing, update if present).
 * @param {object} db
 * @param {string} settingName
 * @param {string} settingValue
 */
function upsertSetting(db, settingName, settingValue) {
    db.run(
        `INSERT INTO settings (setting_name, setting_value) VALUES (?, ?)
         ON CONFLICT(setting_name) DO UPDATE SET setting_value = excluded.setting_value`,
        settingName,
        settingValue,
    );
}

module.exports = { upsertSetting };
