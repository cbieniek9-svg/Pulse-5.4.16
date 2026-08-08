'use strict';

/**
 * Floor shrink needs a close-out (finalize the day's count) and a way to void or
 * correct a line after a wrong scan — Open / Closed / Voided.
 */
module.exports = {
    name: '053_floor_shrink_status',
    up(db) {
        const cols = new Set(
            (db.all('PRAGMA table_info(floor_shrink_sku)') || []).map((c) => c.name),
        );
        const add = (name, ddl) => {
            if (!cols.has(name)) db.exec(`ALTER TABLE floor_shrink_sku ADD COLUMN ${ddl}`);
        };
        add('status', "status TEXT NOT NULL DEFAULT 'Open'");
        add('closed_at', 'closed_at TEXT NOT NULL DEFAULT \'\'');
        add('closed_by', 'closed_by TEXT NOT NULL DEFAULT \'\'');
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_floor_shrink_sku_status
                ON floor_shrink_sku(store_date, status);
        `);
        // Older rows predate status — treat them as still open so today's work is editable.
        db.run(`UPDATE floor_shrink_sku SET status = 'Open' WHERE COALESCE(TRIM(status),'') = ''`);
    },
};
