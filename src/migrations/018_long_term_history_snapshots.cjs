'use strict';

const { SNAPSHOT_TABLE_SQL, DEFAULT_RETENTION_DAYS } = require('../lib/history-trends.cjs');

module.exports = {
    name: 'long_term_history_snapshots',
    up(db) {
        db.exec(SNAPSHOT_TABLE_SQL);
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Operational_Retention_Days', ?)",
            String(DEFAULT_RETENTION_DAYS),
        );
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Report_Trend_Window_Days', '90')",
        );
    },
};
