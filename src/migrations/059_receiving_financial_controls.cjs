'use strict';

function columns(db, table) {
    return new Set((db.all(`PRAGMA table_info(${table})`) || []).map((row) => row.name));
}

function addColumn(db, table, name, ddl) {
    if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = {
    name: 'receiving_financial_controls',
    up(db) {
        addColumn(db, 'receiving_report_period_status', 'submitted_by_staff_id', 'submitted_by_staff_id INTEGER');
        addColumn(db, 'receiving_report_period_status', 'approved_by_staff_id', 'approved_by_staff_id INTEGER');
        addColumn(db, 'receiving_report_period_status', 'locked_by_staff_id', 'locked_by_staff_id INTEGER');
        addColumn(db, 'receiving_report_period_status', 'reopened_at', 'reopened_at TEXT');
        addColumn(db, 'receiving_report_period_status', 'reopened_by', "reopened_by TEXT NOT NULL DEFAULT ''");
        addColumn(db, 'receiving_report_period_status', 'reopened_by_staff_id', 'reopened_by_staff_id INTEGER');
        addColumn(db, 'receiving_report_period_status', 'reopen_reason', "reopen_reason TEXT NOT NULL DEFAULT ''");
        addColumn(db, 'receiving_report_close_audit_outbox', 'event_id', "event_id TEXT NOT NULL DEFAULT ''");
        addColumn(db, 'manager_audit_log', 'source_event_id', "source_event_id TEXT NOT NULL DEFAULT ''");
        db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_receiving_close_outbox_event
                ON receiving_report_close_audit_outbox(event_id)
                WHERE event_id != '';
            CREATE INDEX IF NOT EXISTS idx_receiving_close_outbox_pending
                ON receiving_report_close_audit_outbox(flushed_at, created_at);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_audit_source_event
                ON manager_audit_log(source_event_id)
                WHERE source_event_id != '';
        `);
    },
};
