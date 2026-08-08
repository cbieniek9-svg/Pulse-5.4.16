'use strict';

/** Inventory count portal (/count) — off until SMS / superseding is figured out. */
module.exports = {
    name: 'inventory_count_enabled',
    up(db) {
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Inventory_Count_Enabled', '0')",
        );
    },
};
