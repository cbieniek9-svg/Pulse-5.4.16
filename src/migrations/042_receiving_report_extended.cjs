'use strict';

module.exports = {
    name: 'receiving_report_extended',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_dept_margin (
                period_start TEXT NOT NULL,
                department TEXT NOT NULL,
                opening_inventory REAL,
                closing_inventory REAL,
                last_inventory REAL,
                target_margin_pct REAL,
                sms_margin_pct REAL,
                sales_before_count REAL,
                sales_after_count REAL,
                sales_during_count REAL,
                inventory_adjustment REAL,
                variance_explanation TEXT NOT NULL DEFAULT '',
                updated_at TEXT,
                updated_by TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (period_start, department)
            );

            CREATE TABLE IF NOT EXISTS receiving_report_rebate_lines (
                rebate_id TEXT PRIMARY KEY,
                period_start TEXT NOT NULL,
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
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT,
                updated_at TEXT,
                created_by TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_report_rebate_period
                ON receiving_report_rebate_lines(period_start, sort_order);

            CREATE TABLE IF NOT EXISTS receiving_report_recounts (
                recount_id TEXT PRIMARY KEY,
                period_start TEXT NOT NULL,
                location TEXT NOT NULL,
                count_first REAL,
                count_second REAL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT,
                updated_by TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_report_recounts_period
                ON receiving_report_recounts(period_start, sort_order);

            CREATE TABLE IF NOT EXISTS receiving_report_sales_history (
                week_ending TEXT NOT NULL,
                category_key TEXT NOT NULL,
                amount REAL NOT NULL DEFAULT 0,
                period_start TEXT,
                updated_at TEXT,
                PRIMARY KEY (week_ending, category_key)
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_report_sales_history_week
                ON receiving_report_sales_history(week_ending);

            CREATE TABLE IF NOT EXISTS receiving_report_period_snapshots (
                period_start TEXT PRIMARY KEY,
                period_number INTEGER,
                total_grocery_sales REAL,
                total_grocery_gp REAL,
                total_grocery_margin_pct REAL,
                centre_store_sales REAL,
                dairy_sales REAL,
                meat_sales REAL,
                produce_sales REAL,
                tobacco_sales REAL,
                archived_at TEXT
            );
        `);
    },
};
