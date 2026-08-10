'use strict';

function addColumn(db, sql) {
    try {
        db.exec(sql);
    } catch (e) {
        const msg = String(e.message || '').toLowerCase();
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
    }
}

module.exports = {
    name: 'receiving_count_cycles',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_count_cycles (
                cycle_end_period_start TEXT PRIMARY KEY,
                period_number_start INTEGER,
                period_number_end INTEGER,
                period_starts_json TEXT NOT NULL DEFAULT '[]',
                counted_closing_total_grocery REAL,
                counted_closing_centre_store REAL,
                counted_closing_dairy REAL,
                counted_closing_meat REAL,
                counted_closing_produce REAL,
                counted_closing_tobacco REAL,
                cycle_opening_total_grocery REAL,
                cycle_opening_centre_store REAL,
                cycle_opening_dairy REAL,
                cycle_opening_meat REAL,
                cycle_opening_produce REAL,
                cycle_opening_tobacco REAL,
                notes TEXT NOT NULL DEFAULT '',
                updated_at TEXT,
                updated_by TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_count_cycles_period_end
                ON receiving_report_count_cycles(period_number_end);
        `);

        addColumn(db, 'ALTER TABLE receiving_report_margin ADD COLUMN is_count_period INTEGER NOT NULL DEFAULT 0');
    },
};
