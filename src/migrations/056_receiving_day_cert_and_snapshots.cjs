'use strict';

const { addColumn } = require('./_ddl.cjs');

module.exports = {
    name: 'receiving_day_cert_and_snapshots',
    up(db) {
        addColumn(db, 'receiving_report_day', 'cert_receiving_complete', 'cert_receiving_complete INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'receiving_report_day', 'cert_invoices_entered', 'cert_invoices_entered INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'receiving_report_day', 'cert_references_verified', 'cert_references_verified INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'receiving_report_day', 'cert_freight_verified', 'cert_freight_verified INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'receiving_report_day', 'cert_receiver_identified', 'cert_receiver_identified INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'receiving_report_day', 'cert_exceptions_documented', 'cert_exceptions_documented INTEGER NOT NULL DEFAULT 0');
        addColumn(db, 'receiving_report_day', 'certified_at', 'certified_at TEXT');
        addColumn(db, 'receiving_report_day', 'certified_by', "certified_by TEXT NOT NULL DEFAULT ''");

        addColumn(db, 'receiving_report_period_snapshots', 'costing_method', "costing_method TEXT NOT NULL DEFAULT ''");
        addColumn(db, 'receiving_report_period_snapshots', 'snapshot_json', "snapshot_json TEXT NOT NULL DEFAULT ''");
        addColumn(db, 'receiving_report_period_snapshots', 'snapshot_revision', 'snapshot_revision INTEGER NOT NULL DEFAULT 1');
        addColumn(db, 'receiving_report_period_snapshots', 'base_purchases_total', 'base_purchases_total REAL');
        addColumn(db, 'receiving_report_period_snapshots', 'freight_included_total', 'freight_included_total REAL');
        addColumn(db, 'receiving_report_period_snapshots', 'landed_purchases_total', 'landed_purchases_total REAL');
        addColumn(db, 'receiving_report_period_snapshots', 'reconciliation_status', "reconciliation_status TEXT NOT NULL DEFAULT ''");
        addColumn(db, 'receiving_report_period_snapshots', 'model_status', "model_status TEXT NOT NULL DEFAULT ''");
        addColumn(db, 'receiving_report_period_snapshots', 'archived_by', "archived_by TEXT NOT NULL DEFAULT ''");

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
