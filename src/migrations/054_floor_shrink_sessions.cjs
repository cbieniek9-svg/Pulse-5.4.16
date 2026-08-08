'use strict';

/**
 * Concurrent shrink counts: each walk is a session (like /count location sessions).
 * Closing one walk no longer blocks opening another the same day.
 */
module.exports = {
    name: '054_floor_shrink_sessions',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS floor_shrink_sessions (
                id TEXT PRIMARY KEY,
                store_date TEXT NOT NULL,
                label TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'open',
                source TEXT NOT NULL DEFAULT 'manual',
                created_at TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT '',
                closed_at TEXT NOT NULL DEFAULT '',
                closed_by TEXT NOT NULL DEFAULT '',
                notes TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_floor_shrink_sessions_date
                ON floor_shrink_sessions(store_date, status);
        `);

        const cols = new Set(
            (db.all('PRAGMA table_info(floor_shrink_sku)') || []).map((c) => c.name),
        );
        if (!cols.has('session_id')) {
            db.exec(`ALTER TABLE floor_shrink_sku ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`);
        }
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_floor_shrink_sku_session
                ON floor_shrink_sku(session_id);
        `);

        // One legacy session per store_date that already has lines.
        const dates = db.all(`
            SELECT store_date FROM floor_shrink_sku
            WHERE COALESCE(TRIM(session_id),'') = ''
            GROUP BY store_date
        `) || [];

        for (const row of dates) {
            const storeDate = row.store_date;
            const lines = db.all(
                `SELECT id, status FROM floor_shrink_sku
                  WHERE store_date = ? AND COALESCE(TRIM(session_id),'') = ''`,
                storeDate,
            ) || [];
            if (!lines.length) continue;

            const openN = lines.filter((l) => String(l.status || 'Open') === 'Open').length;
            const sessionStatus = openN > 0 ? 'open' : 'closed';
            const now = new Date().toISOString();
            const id = `FSS-legacy-${String(storeDate).replace(/[^\d]/g, '') || 'day'}`;
            const existing = db.get('SELECT id FROM floor_shrink_sessions WHERE id = ?', id);
            const sessionId = existing?.id || id;
            if (!existing) {
                db.run(
                    `INSERT INTO floor_shrink_sessions
                        (id, store_date, label, status, source, created_at, created_by, closed_at, closed_by, notes)
                     VALUES (?,?,?,?,?,?,?,?,?,?)`,
                    sessionId,
                    storeDate,
                    'Legacy day walk',
                    sessionStatus,
                    'legacy',
                    now,
                    'system',
                    sessionStatus === 'closed' ? now : '',
                    sessionStatus === 'closed' ? 'system' : '',
                    'Backfilled from pre-session shrink lines',
                );
            }
            db.run(
                `UPDATE floor_shrink_sku SET session_id = ? WHERE store_date = ? AND COALESCE(TRIM(session_id),'') = ''`,
                sessionId,
                storeDate,
            );
        }
    },
};
