'use strict';

const DEFAULT_TV_DISPLAY_TOGGLES = [
    ['TV_Show_Pinned_Daily_Huddle', '0'],
    ['TV_Show_Store_Comms', '1'],
    ['TV_Show_Audit_Trail', '1'],
    ['TV_Show_Ticker', '0'],
    ['TV_Show_Latest_Shift_Update', '0'],
];

module.exports = {
    name: 'tv_display_toggles',
    up(db) {
        DEFAULT_TV_DISPLAY_TOGGLES.forEach(([name, value]) => {
            db.run(
                'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
                name,
                value,
            );
        });
    },
    DEFAULT_TV_DISPLAY_TOGGLES,
};
