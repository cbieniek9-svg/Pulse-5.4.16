'use strict';

module.exports = {
    name: 'betacs_settings',
    up(db) {
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Betacs_Enabled', '0')");
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Rhythm_Schedule_Edit_Enabled', '1')");
    },
};
