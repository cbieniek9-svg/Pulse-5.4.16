'use strict';

/**
 * 5.4.8 completion migration.
 * Additive only: ties overrides/duplicate acknowledgements to exactly reviewed
 * financial content and preserves a 5.4.7 current snapshot as immutable history.
 */

function columns(db, table) {
    return new Set((db.all(`PRAGMA table_info(${table})`) || []).map((row) => row.name));
}

function addColumn(db, table, name, ddl) {
    if (columns(db, table).has(name)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
    name: 'receiving_integrity_completion',
    up(db) {
        addColumn(
            db,
            'receiving_report_day',
            'freight_override_fingerprint',
            "freight_override_fingerprint TEXT NOT NULL DEFAULT ''",
        );
        addColumn(
            db,
            'receiving_report_exception_acks',
            'group_fingerprint',
            "group_fingerprint TEXT NOT NULL DEFAULT ''",
        );
        addColumn(
            db,
            'receiving_report_exception_acks',
            'supplier_key',
            "supplier_key TEXT NOT NULL DEFAULT ''",
        );
        addColumn(
            db,
            'receiving_report_exception_acks',
            'invoice_key',
            "invoice_key TEXT NOT NULL DEFAULT ''",
        );
        addColumn(
            db,
            'receiving_report_exception_acks',
            'line_ids_json',
            "line_ids_json TEXT NOT NULL DEFAULT '[]'",
        );
        addColumn(
            db,
            'receiving_report_exception_acks',
            'line_count',
            'line_count INTEGER NOT NULL DEFAULT 0',
        );

        /*
         * 057 created history but could not backfill snapshots that already
         * existed in a 5.4.7 database. Copy each current pointer once, using
         * its existing revision and original payload/actor/timestamp.
         */
        db.exec(`
            INSERT INTO receiving_report_period_snapshot_revisions (
                revision_id, period_start, revision, costing_method,
                base_purchases_total, freight_included_total, landed_purchases_total,
                reconciliation_status, model_status, margin_outputs_json,
                snapshot_json, actor_name, reason, created_at
            )
            SELECT
                lower(hex(randomblob(16))),
                s.period_start,
                COALESCE(NULLIF(s.snapshot_revision, 0), 1),
                COALESCE(s.costing_method, ''),
                s.base_purchases_total,
                s.freight_included_total,
                s.landed_purchases_total,
                COALESCE(s.reconciliation_status, ''),
                COALESCE(s.model_status, ''),
                '',
                COALESCE(s.snapshot_json, ''),
                COALESCE(s.archived_by, ''),
                'migration_058_backfill',
                COALESCE(s.archived_at, datetime('now'))
              FROM receiving_report_period_snapshots s
             WHERE NOT EXISTS (
                 SELECT 1
                   FROM receiving_report_period_snapshot_revisions r
                  WHERE r.period_start = s.period_start
                    AND r.revision = COALESCE(NULLIF(s.snapshot_revision, 0), 1)
             )
        `);
    },
};
