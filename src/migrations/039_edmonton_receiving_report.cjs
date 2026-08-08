'use strict';

module.exports = {
    name: 'edmonton_receiving_report',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_day (
                store_date TEXT PRIMARY KEY,
                receiver_name TEXT NOT NULL DEFAULT '',
                freight_total REAL,
                updated_at TEXT,
                updated_by TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS receiving_report_lines (
                line_id TEXT PRIMARY KEY,
                store_date TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                line_kind TEXT NOT NULL DEFAULT 'invoice',
                invoice_number TEXT NOT NULL DEFAULT '',
                supplier_name TEXT NOT NULL DEFAULT '',
                grocery REAL NOT NULL DEFAULT 0,
                tobacco REAL NOT NULL DEFAULT 0,
                meat REAL NOT NULL DEFAULT 0,
                bakery REAL NOT NULL DEFAULT 0,
                bakery_in_store REAL NOT NULL DEFAULT 0,
                deli REAL NOT NULL DEFAULT 0,
                produce REAL NOT NULL DEFAULT 0,
                produce_shrink REAL NOT NULL DEFAULT 0,
                dairy REAL NOT NULL DEFAULT 0,
                pharmacy REAL NOT NULL DEFAULT 0,
                gst REAL NOT NULL DEFAULT 0,
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT,
                created_by TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_report_lines_date
                ON receiving_report_lines(store_date, sort_order);
        `);
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Receiving_Report_Period_Start', '')",
        );
    },
};
