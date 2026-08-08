'use strict';

const STABILIZED_TV_DEFAULTS = [
    ['TV_Show_Pinned_Daily_Huddle', '0'],
    ['TV_Show_Ticker', '0'],
    ['TV_Show_Latest_Shift_Update', '0'],
    ['TV_Show_Store_Comms', '1'],
    ['TV_Show_Audit_Trail', '1'],
];

module.exports = {
    name: 'tv_display_stabilization',
    up(db) {
        STABILIZED_TV_DEFAULTS.forEach(([name, value]) => {
            db.run(
                'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
                name,
                value,
            );
        });

        // These three were legacy/clutter surfaces from the old TV model. Daily
        // Direction and Shift Updates now render in-place, so existing installs
        // should default them off unless a manager turns them back on later.
        ['TV_Show_Pinned_Daily_Huddle', 'TV_Show_Ticker', 'TV_Show_Latest_Shift_Update'].forEach((name) => {
            db.run(
                `UPDATE settings
                    SET setting_value='0'
                  WHERE setting_name=?
                    AND COALESCE(setting_value,'') IN ('', '1', 'true', 'on', 'yes')`,
                name,
            );
        });
    },
    STABILIZED_TV_DEFAULTS,
};
