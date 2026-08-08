'use strict';

module.exports = {
    name: 'lan_boundary_and_manager_audit',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS manager_audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL,
                actor_staff_id INTEGER,
                actor_name TEXT,
                action TEXT NOT NULL,
                target_type TEXT,
                target_id TEXT,
                summary TEXT,
                metadata_json TEXT,
                ip_address TEXT,
                user_agent TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_manager_audit_created ON manager_audit_log(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_manager_audit_action ON manager_audit_log(action, created_at DESC);
        `);

        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Allow_LAN_Clients', '1')");
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('LAN_Bind_Host', '0.0.0.0')");
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('LAN_Port', '3001')");

        try {
            db.run("ALTER TABLE trusted_devices ADD COLUMN device_token_hash TEXT");
        } catch (e) {
            if (!String(e.message || '').includes('duplicate column')) throw e;
        }
        try {
            db.run("ALTER TABLE trusted_devices ADD COLUMN token_created_at TEXT");
        } catch (e) {
            if (!String(e.message || '').includes('duplicate column')) throw e;
        }
        try {
            db.run("ALTER TABLE trusted_devices ADD COLUMN last_seen_at TEXT");
        } catch (e) {
            if (!String(e.message || '').includes('duplicate column')) throw e;
        }
    },
};
