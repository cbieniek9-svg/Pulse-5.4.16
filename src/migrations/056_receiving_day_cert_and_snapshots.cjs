'use strict';

function addColumn(db, sql) {
    try {
        db.exec(sql);
    } catch (_) {
        /* column may already exist */
    }
}

module.exports = {
    name: 'receiving_day_cert_and_snapshots',
    up(db) {
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN cert_receiving_complete INTEGER NOT NULL DEFAULT 0`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN cert_invoices_entered INTEGER NOT NULL DEFAULT 0`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN cert_references_verified INTEGER NOT NULL DEFAULT 0`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN cert_freight_verified INTEGER NOT NULL DEFAULT 0`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN cert_receiver_identified INTEGER NOT NULL DEFAULT 0`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN cert_exceptions_documented INTEGER NOT NULL DEFAULT 0`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN certified_at TEXT`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN certified_by TEXT NOT NULL DEFAULT ''`);

        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN costing_method TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN snapshot_revision INTEGER NOT NULL DEFAULT 1`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN base_purchases_total REAL`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN freight_included_total REAL`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN landed_purchases_total REAL`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN reconciliation_status TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN model_status TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_period_snapshots ADD COLUMN archived_by TEXT NOT NULL DEFAULT ''`);

        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_report_financial_audit (
                audit_id TEXT PRIMARY KEY,
                period_start TEXT NOT NULL DEFAULT '',
                store_date TEXT NOT NULL DEFAULT '',
                event_type TEXT NOT NULL,
                actor_name TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                detail_json TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_financial_audit_period
                ON receiving_report_financial_audit(period_start, created_at);

            CREATE TABLE IF NOT EXISTS receiving_report_exception_acks (
                ack_id TEXT PRIMARY KEY,
                period_start TEXT NOT NULL DEFAULT '',
                store_date TEXT NOT NULL DEFAULT '',
                exception_type TEXT NOT NULL,
                exception_key TEXT NOT NULL DEFAULT '',
                actor_name TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_exception_acks_period
                ON receiving_report_exception_acks(period_start, exception_type);

            CREATE TABLE IF NOT EXISTS receiving_report_close_audit_outbox (
                outbox_id TEXT PRIMARY KEY,
                period_start TEXT NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                flushed_at TEXT
            );
        `);
    },
};
