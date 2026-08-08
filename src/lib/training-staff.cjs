'use strict';

const TRAINING_STAFF_NAME = 'TRAINING MODE';
const TRAINING_MODE_SETTING = 'Training_Mode_Enabled';
const UNASSIGNED_OPTION_SETTING = 'Unassigned_Option_Enabled';

function isTrainingStaff(name) {
    return String(name || '').trim().toUpperCase() === TRAINING_STAFF_NAME;
}

function isTrainingModeEnabled(db) {
    const row = db.get('SELECT setting_value FROM settings WHERE setting_name = ?', TRAINING_MODE_SETTING);
    return Boolean(row && row.setting_value === '1');
}

function isUnassignedOptionEnabled(settings = {}) {
    return settings[UNASSIGNED_OPTION_SETTING] !== '0';
}

/** Permanently revoke any legacy walkthrough identity without deleting its history. */
function ensureTrainingStaff(db) {
    db.transaction(() => {
        db.run(
            `DELETE FROM sessions
             WHERE training = 1
                OR staff_id IN (
                    SELECT id FROM staff WHERE UPPER(TRIM(name)) = 'TRAINING MODE'
                )
                OR UPPER(TRIM(name)) = 'TRAINING MODE'`,
        );
        db.run(
            `UPDATE staff
             SET active = 0, app_access = 0, pin = '', pin_hashed = 0
             WHERE UPPER(TRIM(name)) = 'TRAINING MODE'`,
        );
    })();
}

module.exports = {
    TRAINING_STAFF_NAME,
    TRAINING_MODE_SETTING,
    UNASSIGNED_OPTION_SETTING,
    isTrainingStaff,
    isTrainingModeEnabled,
    isUnassignedOptionEnabled,
    ensureTrainingStaff,
};
