'use strict';

module.exports = {
    name: 'optional_presence_tables',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS beacon_events (
                id TEXT PRIMARY KEY,
                beacon_id TEXT NOT NULL,
                staff_name TEXT,
                event_type TEXT NOT NULL,
                rssi INTEGER,
                recorded_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_beacon_events_time ON beacon_events(recorded_at DESC);

            CREATE TABLE IF NOT EXISTS order_presence_snapshots (
                id TEXT PRIMARY KEY,
                store_date TEXT NOT NULL,
                order_start TEXT,
                snapshot_at TEXT NOT NULL,
                anchor_counts TEXT NOT NULL,
                inferred_staff INTEGER,
                source TEXT DEFAULT 'beacon'
            );
            CREATE INDEX IF NOT EXISTS idx_presence_snapshots_date ON order_presence_snapshots(store_date DESC);
        `);
        db.run(
            "INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Presence_Enabled', '0')",
        );
    },
};
