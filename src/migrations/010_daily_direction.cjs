'use strict';

module.exports = {
    name: 'daily_direction',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS daily_direction (
                store_date TEXT PRIMARY KEY,
                walk_notes_json TEXT NOT NULL DEFAULT '{}',
                must_wins_json TEXT NOT NULL DEFAULT '[]',
                status_override TEXT NOT NULL DEFAULT '',
                hidden_risk_ids_json TEXT NOT NULL DEFAULT '[]',
                risk_order_json TEXT NOT NULL DEFAULT '[]',
                floor_message TEXT NOT NULL DEFAULT '',
                floor_message_edited INTEGER NOT NULL DEFAULT 0,
                manager_only_notes TEXT NOT NULL DEFAULT '',
                posted_at TEXT,
                posted_by TEXT,
                posted_msg_id TEXT,
                posted_snapshot_json TEXT,
                checkpoint_dismissed_at TEXT,
                updated_at TEXT NOT NULL,
                updated_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_daily_direction_posted
                ON daily_direction (posted_at DESC);
        `);
    },
};
