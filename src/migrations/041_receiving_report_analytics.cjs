'use strict';

module.exports = {
    name: 'receiving_report_analytics',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_sales (
                period_start TEXT NOT NULL,
                week_num INTEGER NOT NULL,
                category_key TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                updated_at TEXT,
                updated_by TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (period_start, week_num, category_key)
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_report_sales_period
                ON receiving_report_sales(period_start, week_num);

            CREATE TABLE IF NOT EXISTS receiving_report_margin (
                period_start TEXT PRIMARY KEY,
                period_number INTEGER,
                opening_inventory REAL,
                closing_inventory REAL,
                last_inventory REAL,
                target_margin_pct REAL,
                sms_margin_pct REAL,
                sales_before_count REAL,
                sales_after_count REAL,
                sales_during_count REAL,
                count_time_hours REAL,
                variance_explanation TEXT NOT NULL DEFAULT '',
                updated_at TEXT,
                updated_by TEXT NOT NULL DEFAULT ''
            );

            INSERT OR IGNORE INTO settings (setting_name, setting_value)
            VALUES ('Receiving_Report_Period_Number', '');
        `);
    },
};
