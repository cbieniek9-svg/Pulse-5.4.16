'use strict';

module.exports = {
    name: 'receiving_pallets',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_pallets (
                pallet_id TEXT PRIMARY KEY,
                exp_id TEXT NOT NULL,
                store_date TEXT NOT NULL,
                seq_num INTEGER NOT NULL DEFAULT 1,
                license_plate TEXT NOT NULL,
                department TEXT NOT NULL,
                temp_c REAL,
                in_range INTEGER NOT NULL DEFAULT 1,
                notes TEXT,
                captured_at TEXT NOT NULL,
                captured_by TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_receiving_pallets_exp ON receiving_pallets(exp_id);
            CREATE INDEX IF NOT EXISTS idx_receiving_pallets_store_date ON receiving_pallets(store_date);
            CREATE INDEX IF NOT EXISTS idx_receiving_pallets_in_range ON receiving_pallets(store_date, in_range);
        `);
    },
};
