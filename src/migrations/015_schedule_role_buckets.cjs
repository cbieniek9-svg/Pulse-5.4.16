'use strict';

const { DEFAULT_SCHEDULE_ROLE_RULES } = require('../lib/schedule-role-buckets.cjs');

module.exports = {
    name: 'schedule_role_buckets_setting',
    up(db) {
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Schedule_Role_Buckets', ?)",
            JSON.stringify(DEFAULT_SCHEDULE_ROLE_RULES),
        );
    },
};
