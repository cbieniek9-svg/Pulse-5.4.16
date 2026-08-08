'use strict';

/** Add ops notes on special orders (shorts, reorders, desk context). */
module.exports = {
    name: '047_special_order_notes',
    up(db) {
        const cols = db.all(`PRAGMA table_info(special_orders)`).map((c) => c.name);
        if (!cols.includes('notes')) {
            db.exec(`ALTER TABLE special_orders ADD COLUMN notes TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.includes('notes_updated_at')) {
            db.exec(`ALTER TABLE special_orders ADD COLUMN notes_updated_at TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.includes('notes_updated_by')) {
            db.exec(`ALTER TABLE special_orders ADD COLUMN notes_updated_by TEXT NOT NULL DEFAULT ''`);
        }
    },
};
