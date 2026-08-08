'use strict';

function addColumn(db, sql) {
    try {
        db.run(sql);
    } catch (e) {
        if (!String(e.message || '').includes('duplicate column')) throw e;
    }
}

module.exports = {
    name: 'trusted_device_token_pairing',
    up(db) {
        addColumn(db, 'ALTER TABLE trusted_devices ADD COLUMN device_token_hash TEXT');
        addColumn(db, 'ALTER TABLE trusted_devices ADD COLUMN token_created_at TEXT');
        addColumn(db, 'ALTER TABLE trusted_devices ADD COLUMN last_seen_at TEXT');

        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_trusted_devices_token
                ON trusted_devices(device_token_hash)
                WHERE device_token_hash IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_trusted_devices_status_seen
                ON trusted_devices(status, last_seen_at DESC);
        `);
    },
};
