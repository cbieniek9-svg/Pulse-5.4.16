'use strict';

/**
 * Store transfer docs on /rec (toggleable). Unique invoice numbers + file index.
 */
module.exports = {
    name: 'store_transfers',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS store_transfers (
                transfer_id TEXT PRIMARY KEY,
                invoice_no TEXT NOT NULL UNIQUE,
                store_date TEXT NOT NULL,
                customer_name TEXT NOT NULL,
                customer_number TEXT NOT NULL DEFAULT '',
                file_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_store_transfers_date ON store_transfers(store_date);
            CREATE INDEX IF NOT EXISTS idx_store_transfers_customer ON store_transfers(customer_name);
            CREATE INDEX IF NOT EXISTS idx_store_transfers_created ON store_transfers(created_at);
        `);
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Store_Transfers_Enabled', '0')",
        );
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Store_Transfer_Invoice_Seq', '0')",
        );
    },
};
