'use strict';

/**
 * Persist login sessions so a service restart does not silently sign out the floor.
 *
 * Sessions were previously held in an in-memory Map, so every restart left staff
 * holding tokens the server no longer recognised — writes failed with 403 while
 * the UI still looked signed in.
 */
module.exports = {
    name: 'persistent_sessions',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                staff_id INTEGER,
                name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT '',
                training INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                last_active_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_last_active ON sessions(last_active_at);
            CREATE INDEX IF NOT EXISTS idx_sessions_staff_id ON sessions(staff_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
        `);
    },
};
