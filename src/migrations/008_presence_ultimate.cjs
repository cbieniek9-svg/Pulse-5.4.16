'use strict';

module.exports = {
    name: 'presence_ultimate_assets',
    up(db) {
        const addCol = (sql) => {
            try { db.exec(sql); } catch (e) {
                const msg = String(e.message || '').toLowerCase();
                if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
            }
        };
        addCol('ALTER TABLE beacon_events ADD COLUMN asset_type TEXT');
        addCol('ALTER TABLE beacon_events ADD COLUMN asset_label TEXT');
        addCol('ALTER TABLE presence_staff_zones ADD COLUMN asset_type TEXT');
        addCol('ALTER TABLE presence_staff_zones ADD COLUMN asset_label TEXT');
        addCol('ALTER TABLE order_presence_snapshots ADD COLUMN asset_mode TEXT');
        addCol('ALTER TABLE order_presence_snapshots ADD COLUMN asset_details TEXT');

        db.exec(`
            CREATE TABLE IF NOT EXISTS presence_assets (
                beacon_id TEXT PRIMARY KEY,
                asset_type TEXT NOT NULL DEFAULT 'unknown',
                label TEXT,
                aisle_hint TEXT,
                default_staff TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                notes TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_presence_assets_type ON presence_assets(asset_type, active);

            CREATE TABLE IF NOT EXISTS presence_gateway_catalog (
                gateway_id TEXT PRIMARY KEY,
                kind TEXT NOT NULL DEFAULT 'corner',
                label TEXT,
                zone_key TEXT,
                zone TEXT,
                parent_hub_id TEXT,
                order_count INTEGER DEFAULT 0,
                rssi_min INTEGER DEFAULT -90,
                enabled INTEGER NOT NULL DEFAULT 1,
                battery_powered INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);

        const defaults = [
            ['Presence_Asset_Mode', 'staff'],
            ['Presence_Cart_Map', '{}'],
            ['Presence_Allow_Discovery', '0'],
            ['Presence_Mismatch_Threshold', '2'],
            ['Presence_Sim_Last_Run', ''],
        ];
        defaults.forEach(([name, value]) => {
            db.run(
                'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
                name,
                value,
            );
        });
    },
};
