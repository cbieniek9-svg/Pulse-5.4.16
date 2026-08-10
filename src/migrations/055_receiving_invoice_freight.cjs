'use strict';

function tableExists(db, name) {
    return !!db.get(
        `SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`,
        name,
    );
}

function addColumn(db, sql) {
    try {
        db.exec(sql);
    } catch (e) {
        const msg = String(e.message || '').toLowerCase();
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
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
        if (tableExists(db, 'receiving_report_lines')) {
            LINE_FREIGHT_COLS.forEach((col) => {
                addColumn(db, `ALTER TABLE receiving_report_lines ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
            });
        }

        if (tableExists(db, 'receiving_report_day')) {
            addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_recon_status TEXT NOT NULL DEFAULT ''`);
            addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_override_reason TEXT NOT NULL DEFAULT ''`);
            addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_override_by TEXT NOT NULL DEFAULT ''`);
            addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_override_at TEXT`);
            addColumn(db, `ALTER TABLE receiving_report_day ADD COLUMN freight_tolerance REAL`);
        }

        if (tableExists(db, 'receiving_report_period_status')) {
            addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method TEXT NOT NULL DEFAULT ''`);
            addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_reason TEXT NOT NULL DEFAULT ''`);
            addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_selected_at TEXT`);
            addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_selected_by TEXT NOT NULL DEFAULT ''`);
            addColumn(db, `ALTER TABLE receiving_report_period_status ADD COLUMN costing_method_audit_json TEXT NOT NULL DEFAULT ''`);
        }

        // Historical snapshotted periods keep legacy allocation. Insert only when no
        // status row exists (empty costing_method on an existing row is handled below).
        if (
            tableExists(db, 'receiving_report_period_snapshots')
            && tableExists(db, 'receiving_report_period_status')
        ) {
            db.exec(`
                INSERT OR IGNORE INTO receiving_report_period_status (
                    period_start, status, costing_method, costing_method_reason,
                    costing_method_selected_at, costing_method_selected_by, updated_at, updated_by
                )
                SELECT DISTINCT s.period_start,
                       'locked',
                       'legacy_fixed_allocation',
                       'historical_default',
                       datetime('now'),
                       'migration_055',
                       datetime('now'),
                       'migration_055'
                  FROM receiving_report_period_snapshots s
             LEFT JOIN receiving_report_period_status ps ON ps.period_start = s.period_start
                 WHERE ps.period_start IS NULL
            `);
        }

        if (tableExists(db, 'receiving_report_period_status')) {
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
        }

        if (tableExists(db, 'settings')) {
            db.exec(`
                INSERT OR IGNORE INTO settings (setting_name, setting_value)
                VALUES ('Receiving_Freight_Tolerance', '0.05')
            `);
        }
    },
};
