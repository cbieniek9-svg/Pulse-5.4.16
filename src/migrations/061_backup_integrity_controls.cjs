'use strict';

function upsertSetting(db, name, value) {
    db.run(
        `INSERT INTO settings (setting_name, setting_value) VALUES (?, ?)
         ON CONFLICT(setting_name) DO NOTHING`,
        name,
        value,
    );
}

module.exports = {
    name: 'backup_integrity_controls',
    up(db) {
        upsertSetting(db, 'Eod_Last_Pre_Backup_Package', '');
        upsertSetting(db, 'Eod_Last_Post_Backup_Package', '');
        upsertSetting(db, 'Eod_Last_Backup_Error', '');
        upsertSetting(db, 'Eod_Last_Backup_Ok_At', '');
    },
};
