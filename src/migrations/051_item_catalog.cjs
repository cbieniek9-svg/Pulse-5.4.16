'use strict';

/**
 * Store item catalog so scanning a code fills in the description instead of
 * staff retyping it. Seeded from every item row already logged.
 */
module.exports = {
    name: '051_item_catalog',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS item_catalog (
                code TEXT PRIMARY KEY,
                raw_code TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                zone TEXT NOT NULL DEFAULT '',
                department TEXT NOT NULL DEFAULT '',
                size TEXT NOT NULL DEFAULT '',
                retail_price REAL,
                unit_cost REAL,
                case_cost REAL,
                case_qty INTEGER,
                source TEXT NOT NULL DEFAULT 'learned',
                times_seen INTEGER NOT NULL DEFAULT 0,
                first_seen TEXT NOT NULL DEFAULT '',
                last_seen TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_item_catalog_desc ON item_catalog(description);

            CREATE TABLE IF NOT EXISTS item_code_aliases (
                alias_code TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'learned',
                created_at TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_item_code_aliases_code ON item_code_aliases(code);
        `);

        // CREATE IF NOT EXISTS will not add columns if an earlier failed run left the
        // table behind (SQLite DDL auto-commits). Ensure the price columns exist before
        // seeding — upsertItem writes them, and 052 is a no-op when they are already here.
        const cols = new Set(
            (db.all('PRAGMA table_info(item_catalog)') || []).map((c) => c.name),
        );
        const add = (name, ddl) => {
            if (!cols.has(name)) db.exec(`ALTER TABLE item_catalog ADD COLUMN ${ddl}`);
        };
        add('retail_price', 'retail_price REAL');
        add('unit_cost', 'unit_cost REAL');
        add('case_cost', 'case_cost REAL');
        add('case_qty', 'case_qty INTEGER');

        const { backfillFromHistory } = require('../lib/item-catalog.cjs');
        const result = backfillFromHistory(db);
        console.log(`[MIGRATION] item_catalog seeded ${result.created} item(s) from ${result.scanned} historical row(s)`);
    },
};
