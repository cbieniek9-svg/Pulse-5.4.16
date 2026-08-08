'use strict';

const crypto = require('crypto');

function genId() {
    return `CM-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

module.exports = {
    name: 'message_center',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS comms_messages (
                msg_id TEXT PRIMARY KEY,
                lane TEXT NOT NULL,
                body TEXT NOT NULL,
                priority TEXT NOT NULL DEFAULT 'info',
                source TEXT NOT NULL DEFAULT 'human',
                posted_by TEXT NOT NULL,
                posted_at TEXT NOT NULL,
                expires_at TEXT,
                dismissed_at TEXT,
                dismissed_by TEXT,
                zone TEXT DEFAULT '',
                dedupe_key TEXT DEFAULT '',
                meta_json TEXT DEFAULT '{}',
                archived_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_comms_lane_active ON comms_messages (lane, posted_at DESC);
            CREATE INDEX IF NOT EXISTS idx_comms_dedupe_active ON comms_messages (dedupe_key)
                WHERE dedupe_key != '' AND dismissed_at IS NULL AND archived_at IS NULL;

            CREATE TABLE IF NOT EXISTS comms_handoff_archive (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                store_date TEXT NOT NULL,
                archived_at TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_comms_handoff_date ON comms_handoff_archive (store_date DESC);
        `);

        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Message_Center_Enabled', '1')");
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Comms_System_Messages', '1')");

        const now = new Date().toISOString();
        const tickers = db.all('SELECT msg_id, message FROM ticker');
        tickers.forEach((row) => {
            db.run(
                `INSERT OR IGNORE INTO comms_messages (
                    msg_id, lane, body, priority, source, posted_by, posted_at, dedupe_key, meta_json
                ) VALUES (?, 'ticker', ?, 'info', 'human', 'MIGRATED', ?, '', '{}')`,
                row.msg_id || genId(),
                String(row.message || '').trim(),
                now,
            );
        });

        const notesRow = db.get("SELECT setting_value FROM settings WHERE setting_name='Shift_Notes'");
        const critRow = db.get("SELECT setting_value FROM settings WHERE setting_name='Critical_Alert'");
        const notes = String(notesRow?.setting_value || '').trim();
        if (notes) {
            const priority = critRow?.setting_value === '1' ? 'urgent' : 'warn';
            db.run(
                `INSERT INTO comms_messages (
                    msg_id, lane, body, priority, source, posted_by, posted_at, dedupe_key, meta_json
                ) VALUES (?, 'pinned', ?, ?, 'human', 'MIGRATED', ?, 'legacy:shift_notes', '{}')`,
                genId(),
                notes,
                priority,
                now,
            );
        }
    },
};
