'use strict';

function tableExists(db, name) {
    return !!db.get(
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`,
        name,
    );
}

function hasColumn(db, table, column) {
    return (db.all(`PRAGMA table_info(${table})`) || []).some((row) => row.name === column);
}

module.exports = {
    name: 'incident_inventory_integrity',
    up(db) {
        // Minimal upgrade fixtures (e.g. 060/061 tests) may not include this table.
        // Real installs create it in earlier migrations; skip ALTER when absent.
        if (tableExists(db, 'incident_investigations')) {
            if (!hasColumn(db, 'incident_investigations', 'last_submitted_by')) {
                db.exec('ALTER TABLE incident_investigations ADD COLUMN last_submitted_by TEXT');
            }
            if (!hasColumn(db, 'incident_investigations', 'last_submitted_at')) {
                db.exec('ALTER TABLE incident_investigations ADD COLUMN last_submitted_at TEXT');
            }
        }
        db.exec(`
            CREATE TABLE IF NOT EXISTS incident_investigation_amend_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                investigation_id TEXT NOT NULL,
                action TEXT NOT NULL,
                actor_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                note TEXT
            );
        `);
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_ii_amend_inv
                ON incident_investigation_amend_events(investigation_id, created_at);
        `);
    },
};
