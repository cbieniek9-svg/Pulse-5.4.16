'use strict';

const { DEFAULT_GATEWAYS } = require('../lib/presence-config.cjs');

module.exports = {
    name: 'presence_production',
    up(db) {
        try { db.exec('ALTER TABLE beacon_events ADD COLUMN gateway_id TEXT DEFAULT \'\''); } catch (_) { /* exists */ }
        try { db.exec('ALTER TABLE order_presence_snapshots ADD COLUMN staff_names TEXT'); } catch (_) { /* exists */ }

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_beacon_events_gateway_time
                ON beacon_events(gateway_id, recorded_at DESC);
            CREATE INDEX IF NOT EXISTS idx_beacon_events_beacon_time
                ON beacon_events(beacon_id, recorded_at DESC);

            CREATE TABLE IF NOT EXISTS presence_gateway_heartbeats (
                gateway_id TEXT PRIMARY KEY,
                label TEXT,
                last_seen TEXT NOT NULL,
                last_batch_count INTEGER DEFAULT 0,
                firmware TEXT
            );

            CREATE TABLE IF NOT EXISTS presence_staff_zones (
                beacon_id TEXT PRIMARY KEY,
                staff_name TEXT,
                zone_key TEXT,
                zone TEXT,
                gateway_id TEXT,
                rssi INTEGER,
                updated_at TEXT NOT NULL
            );
        `);

        db.run(
            'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            'Presence_Gateway_Map',
            JSON.stringify(DEFAULT_GATEWAYS),
        );
        db.run(
            'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            'Presence_Order_Gateways',
            JSON.stringify(['GW-RECV']),
        );
        db.run(
            'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            'Presence_Gateway_Stale_Minutes',
            '5',
        );
        db.run(
            'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            'Presence_Zone_Window_Minutes',
            '3',
        );
        db.run(
            'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            'Presence_RSSI_Floor',
            '-95',
        );
        db.run(
            'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            'Presence_Staff_Beacons',
            '{}',
        );
    },
};
