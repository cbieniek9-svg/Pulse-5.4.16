'use strict';

module.exports = {
    name: 'shift_updates',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS shift_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                store_date TEXT NOT NULL,
                sequence_num INTEGER NOT NULL,
                message TEXT NOT NULL,
                triggers_json TEXT NOT NULL DEFAULT '[]',
                posted_at TEXT NOT NULL,
                posted_by TEXT NOT NULL,
                posted_msg_id TEXT,
                snapshot_json TEXT,
                created_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_shift_updates_day_seq
                ON shift_updates (store_date, sequence_num);
            CREATE INDEX IF NOT EXISTS idx_shift_updates_day_posted
                ON shift_updates (store_date, posted_at DESC);
        `);

        const addCol = (sql) => {
            try { db.exec(sql); } catch (e) {
                if (!String(e.message).includes('duplicate column')) throw e;
            }
        };
        addCol('ALTER TABLE daily_direction ADD COLUMN amendment_snoozed_until TEXT');
        addCol('ALTER TABLE daily_direction ADD COLUMN amendment_dismissed_fingerprint TEXT NOT NULL DEFAULT \'\'');
        addCol('ALTER TABLE daily_direction ADD COLUMN shift_update_draft_json TEXT NOT NULL DEFAULT \'\'');
    },
};
