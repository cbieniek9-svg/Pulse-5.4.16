'use strict';

module.exports = {
    name: 'cs_full_hub_settings',
    up(db) {
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Cs_Hub_Enabled', '0')");
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Cs_Full_Enabled', '0')");
        // Seed CS_Full from legacy Betacs so upgrades keep the same on/off state.
        const betacs = db.get("SELECT setting_value FROM settings WHERE setting_name = 'Betacs_Enabled'");
        if (betacs && String(betacs.setting_value) === '1') {
            db.run("UPDATE settings SET setting_value = '1' WHERE setting_name = 'Cs_Full_Enabled'");
        }
    },
};
