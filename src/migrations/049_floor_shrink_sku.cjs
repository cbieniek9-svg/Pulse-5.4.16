'use strict';

/** Floor shrink-by-SKU log for /markdown portal (separate from receiving shrink). */
module.exports = {
    name: '049_floor_shrink_sku',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS floor_shrink_sku (
                id TEXT PRIMARY KEY,
                store_date TEXT NOT NULL,
                sku TEXT NOT NULL DEFAULT '',
                item TEXT NOT NULL DEFAULT '',
                quantity REAL NOT NULL DEFAULT 1,
                reason TEXT NOT NULL DEFAULT '',
                zone TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT 'manual',
                logged_by TEXT NOT NULL DEFAULT '',
                time_logged TEXT NOT NULL,
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_floor_shrink_sku_date ON floor_shrink_sku(store_date, time_logged DESC);
            CREATE INDEX IF NOT EXISTS idx_floor_shrink_sku_sku ON floor_shrink_sku(sku);
        `);
    },
};
