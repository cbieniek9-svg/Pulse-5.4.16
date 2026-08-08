'use strict';

module.exports = {
    name: 'receiving_period_controls',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_period_status (
                period_start TEXT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'open',
                submitted_at TEXT,
                submitted_by TEXT NOT NULL DEFAULT '',
                approved_at TEXT,
                approved_by TEXT NOT NULL DEFAULT '',
                locked_at TEXT,
                locked_by TEXT NOT NULL DEFAULT '',
                reopen_note TEXT NOT NULL DEFAULT '',
                updated_at TEXT,
                updated_by TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_report_period_status_status
                ON receiving_report_period_status(status);
        `);
    },
};
