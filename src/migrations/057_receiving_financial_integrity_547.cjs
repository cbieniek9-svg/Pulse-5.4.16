'use strict';

/**
 * Migration 057 — receiving financial integrity repairs for 5.4.7.
 * Idempotent additive schema only. Does not rewrite 055/056.
 */

function tableExists(db, name) {
    return !!db.get(
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`,
        name,
    );
}

function columnNames(db, table) {
    return new Set((db.all(`PRAGMA table_info(${table})`) || []).map((c) => c.name));
}

function addColumnIfMissing(db, table, column, ddl) {
    const cols = columnNames(db, table);
    if (cols.has(column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    return true;
}

module.exports = {
    name: 'receiving_financial_integrity_547',
    up(db) {
        if (!tableExists(db, 'receiving_report_day')) {
            throw new Error('Migration 057 requires receiving_report_day (migration 039+).');
        }
        if (!tableExists(db, 'receiving_report_lines')) {
            throw new Error('Migration 057 requires receiving_report_lines (migration 039+).');
        }

        // Day: overflow review acknowledgement + freight expected explicit marker cache
        addColumnIfMissing(db, 'receiving_report_day', 'overflow_line_count',
            'overflow_line_count INTEGER NOT NULL DEFAULT 0');
        addColumnIfMissing(db, 'receiving_report_day', 'overflow_acknowledged_at',
            'overflow_acknowledged_at TEXT');
        addColumnIfMissing(db, 'receiving_report_day', 'overflow_acknowledged_by',
            'overflow_acknowledged_by TEXT NOT NULL DEFAULT \'\'');
        addColumnIfMissing(db, 'receiving_report_day', 'overflow_ack_reason',
            'overflow_ack_reason TEXT NOT NULL DEFAULT \'\'');
        addColumnIfMissing(db, 'receiving_report_day', 'overflow_ack_line_count',
            'overflow_ack_line_count INTEGER');
        addColumnIfMissing(db, 'receiving_report_day', 'freight_expected_entered',
            'freight_expected_entered INTEGER NOT NULL DEFAULT 0');
        // Cache of live recon — close always recomputes; this is for UI/overview
        addColumnIfMissing(db, 'receiving_report_day', 'freight_recon_entered',
            'freight_recon_entered REAL');
        addColumnIfMissing(db, 'receiving_report_day', 'freight_recon_difference',
            'freight_recon_difference REAL');
        addColumnIfMissing(db, 'receiving_report_day', 'cert_content_fingerprint',
            'cert_content_fingerprint TEXT NOT NULL DEFAULT \'\'');

        // Explicit zero confirmation for sales weeks (blank ≠ confirmed zero)
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_sales_zero_confirm (
                confirm_id TEXT PRIMARY KEY,
                period_start TEXT NOT NULL,
                category_key TEXT NOT NULL,
                week_number INTEGER NOT NULL,
                confirmed_zero INTEGER NOT NULL DEFAULT 1,
                confirmed_by TEXT NOT NULL DEFAULT '',
                confirmed_at TEXT NOT NULL,
                reason TEXT NOT NULL DEFAULT '',
                UNIQUE(period_start, category_key, week_number)
            );
            CREATE INDEX IF NOT EXISTS idx_sales_zero_confirm_period
                ON receiving_report_sales_zero_confirm(period_start);
        `);

        // Immutable snapshot revision history (current pointer stays on period_snapshots)
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_period_snapshot_revisions (
                revision_id TEXT PRIMARY KEY,
                period_start TEXT NOT NULL,
                revision INTEGER NOT NULL,
                costing_method TEXT NOT NULL DEFAULT '',
                base_purchases_total REAL,
                freight_included_total REAL,
                landed_purchases_total REAL,
                reconciliation_status TEXT NOT NULL DEFAULT '',
                model_status TEXT NOT NULL DEFAULT '',
                margin_outputs_json TEXT NOT NULL DEFAULT '',
                snapshot_json TEXT NOT NULL DEFAULT '',
                actor_name TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                UNIQUE(period_start, revision)
            );
            CREATE INDEX IF NOT EXISTS idx_snapshot_revisions_period
                ON receiving_report_period_snapshot_revisions(period_start, revision);
        `);

        // Negative freight manager exceptions
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_negative_freight_acks (
                ack_id TEXT PRIMARY KEY,
                store_date TEXT NOT NULL,
                line_id TEXT NOT NULL,
                freight_field TEXT NOT NULL,
                original_value REAL,
                new_value REAL NOT NULL,
                actor_name TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_neg_freight_acks_line
                ON receiving_report_negative_freight_acks(line_id, freight_field);
        `);

        // Backfill freight_expected_entered when freight_total is non-null (including explicit 0)
        try {
            db.exec(`
                UPDATE receiving_report_day
                   SET freight_expected_entered = 1
                 WHERE freight_total IS NOT NULL
                   AND COALESCE(freight_expected_entered, 0) = 0
            `);
        } catch (err) {
            throw new Error(`Migration 057 freight_expected_entered backfill failed: ${err.message}`);
        }
    },
};
