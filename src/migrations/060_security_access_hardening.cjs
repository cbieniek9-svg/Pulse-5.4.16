'use strict';

function hasColumn(db, table, column) {
    return (db.all(`PRAGMA table_info(${table})`) || []).some((row) => row.name === column);
}

function forceSetting(db, name, value) {
    db.run(
        `INSERT INTO settings (setting_name, setting_value)
         VALUES (?, ?)
         ON CONFLICT(setting_name) DO UPDATE SET setting_value = excluded.setting_value`,
        name,
        value,
    );
}

module.exports = {
    name: 'security_access_hardening',
    up(db) {
        if (!hasColumn(db, 'trusted_devices', 'device_purpose')) {
            db.exec("ALTER TABLE trusted_devices ADD COLUMN device_purpose TEXT NOT NULL DEFAULT ''");
        }

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_trusted_devices_purpose_status
                ON trusted_devices(device_purpose, status);
        `);

        forceSetting(db, 'Training_Mode_Enabled', '0');
        forceSetting(db, 'Require_TV_Device_Token', '1');

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
    },
};
