'use strict';

function addColumn(db, sql) {
    try {
        db.exec(sql);
    } catch (_) {
        /* column may already exist */
    }
}

const LINE_FREIGHT_COLS = [
    'freight_grocery',
    'freight_tobacco',
    'freight_meat',
    'freight_bakery',
    'freight_bakery_in_store',
    'freight_deli',
    'freight_produce',
    'freight_dairy',
    'freight_pharmacy',
];

module.exports = {
    name: 'receiving_invoice_freight',
    up(db) {
        LINE_FREIGHT_COLS.forEach((col) => {
            addColumn(db, `ALTER TABLE receiving_report_lines ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
        });

        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_recon_status TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_override_reason TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_override_by TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_override_at TEXT`);
        addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_tolerance REAL`);

        addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_reason TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_selected_at TEXT`);
        addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_selected_by TEXT NOT NULL DEFAULT ''`);
        addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_audit_json TEXT NOT NULL DEFAULT ''`);

        // Historical submitted/approved/locked (or snapshotted) periods keep legacy allocation.
        try {
            db.exec(`
                INSERT INTO receiving_report_period_status (
                    period_start, status, costing_method, costing_method_reason,
                    costing_method_selected_at, costing_method_selected_by, updated_at, updated_by
                )
                SELECT s.period_start,
                       COALESCE(ps.status, 'locked'),
                       'legacy_fixed_allocation',
                       'historical_default',
                       datetime('now'),
                       'migration_055',
                       datetime('now'),
                       'migration_055'
                  FROM receiving_report_period_snapshots s
             LEFT JOIN receiving_report_period_status ps ON ps.period_start = s.period_start
                 WHERE COALESCE(ps.costing_method, '') = ''
            `);
        } catch (_) { /* snapshots optional */ }

        try {
            db.exec(`
                UPDATE receiving_report_period_status
                   SET costing_method = 'legacy_fixed_allocation',
                       costing_method_reason = CASE
                           WHEN trim(costing_method_reason) = '' THEN 'historical_default'
                           ELSE costing_method_reason
                       END,
                       costing_method_selected_at = COALESCE(costing_method_selected_at, datetime('now')),
                       costing_method_selected_by = CASE
                           WHEN trim(costing_method_selected_by) = '' THEN 'migration_055'
                           ELSE costing_method_selected_by
                       END
                 WHERE trim(COALESCE(costing_method, '')) = ''
                   AND status IN ('submitted', 'approved', 'locked')
            `);
        } catch (_) { /* status table may be empty */ }

        try {
            db.exec(`
                INSERT OR IGNORE INTO settings (setting_name, setting_value)
                VALUES ('Receiving_Freight_Tolerance', '0.05')
            `);
        } catch (_) { /* settings optional */ }
    },
};
