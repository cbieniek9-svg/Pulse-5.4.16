'use strict';

/** Idempotent column adds previously inline in db.cjs. */
module.exports = {
    name: 'legacy_column_adds',
    up(db) {
        const alters = [
            "ALTER TABLE kill_dates ADD COLUMN item_code TEXT",
            "ALTER TABLE tasks ADD COLUMN related_id TEXT",
            "ALTER TABLE tasks ADD COLUMN start_time TEXT",
            "ALTER TABLE staff ADD COLUMN permissions TEXT DEFAULT ''",
            "ALTER TABLE homebase_audits ADD COLUMN audit_data TEXT",
            "ALTER TABLE rhythm_tasks ADD COLUMN est_mins INTEGER DEFAULT 15",
            "ALTER TABLE shift_order_history ADD COLUMN grocery_pieces INTEGER DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN frozen_pieces INTEGER DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN hardware_pieces INTEGER DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN total_pieces INTEGER DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN staff_count INTEGER DEFAULT 1",
            "ALTER TABLE shift_order_history ADD COLUMN standard_hours REAL DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN actual_order_minutes INTEGER DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN actual_pieces_per_hour REAL DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN break_deduction_hours_per_person REAL DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN adjusted_labor_hours REAL DEFAULT 0",
            "ALTER TABLE shift_order_history ADD COLUMN adjusted_per_person_pph REAL DEFAULT 0",
            "ALTER TABLE special_orders ADD COLUMN route TEXT",
            "ALTER TABLE special_orders ADD COLUMN needed_by TEXT",
            "ALTER TABLE special_orders ADD COLUMN source TEXT",
            "ALTER TABLE special_orders ADD COLUMN taken_by TEXT",
            "ALTER TABLE special_orders ADD COLUMN ordered_at TEXT",
            "ALTER TABLE special_orders ADD COLUMN ready_at TEXT",
            "ALTER TABLE staff ADD COLUMN last_review TEXT",
            "ALTER TABLE staff ADD COLUMN availability TEXT",
            "ALTER TABLE expected_orders ADD COLUMN category TEXT DEFAULT 'general'",
            "ALTER TABLE expected_orders ADD COLUMN pieces INTEGER DEFAULT 0",
            "ALTER TABLE expected_orders ADD COLUMN arrived INTEGER DEFAULT 0",
            "ALTER TABLE expected_orders ADD COLUMN arrived_at TEXT",
            "ALTER TABLE expected_orders ADD COLUMN arrived_by TEXT",
            "ALTER TABLE expected_orders ADD COLUMN departed_at TEXT",
            "ALTER TABLE expected_orders ADD COLUMN departed_by TEXT",
            "ALTER TABLE expected_orders ADD COLUMN item TEXT",
        ];
        alters.forEach((sql) => {
            try {
                db.exec(sql);
            } catch (e) {
                const msg = String(e.message || '').toLowerCase();
                if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
            }
        });

        db.exec(`
            CREATE TABLE IF NOT EXISTS order_audit (
                id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                from_status TEXT,
                to_status TEXT,
                snapshot TEXT,
                ip TEXT,
                timestamp TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_order_audit_order ON order_audit(order_id, timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_order_audit_time ON order_audit(timestamp DESC);
        `);
    },
};
