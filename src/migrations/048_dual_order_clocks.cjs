'use strict';

/** Dual dry/frozen order clocks — archive columns + frozen staff on counts. */
module.exports = {
    name: '048_dual_order_clocks',
    up(db) {
        const histCols = db.all(`PRAGMA table_info(shift_order_history)`).map((c) => c.name);
        const addHist = (col, ddl) => {
            if (!histCols.includes(col)) db.exec(`ALTER TABLE shift_order_history ADD COLUMN ${ddl}`);
        };
        addHist('frozen_order_start', 'frozen_order_start TEXT');
        addHist('frozen_order_end', 'frozen_order_end TEXT');
        addHist('frozen_staff_count', 'frozen_staff_count INTEGER DEFAULT 0');
        addHist('frozen_actual_minutes', 'frozen_actual_minutes INTEGER DEFAULT 0');
        addHist('frozen_pieces_per_hour', 'frozen_pieces_per_hour REAL DEFAULT 0');

        const countCols = db.all(`PRAGMA table_info(counts)`).map((c) => c.name);
        if (!countCols.includes('frozen_staff')) {
            db.exec(`ALTER TABLE counts ADD COLUMN frozen_staff INTEGER DEFAULT 1`);
        }

        // Ensure settings rows exist (upsert-friendly empty defaults).
        const ensureSetting = (name) => {
            const row = db.get('SELECT setting_name FROM settings WHERE setting_name = ?', name);
            if (!row) {
                db.run(
                    'INSERT INTO settings (setting_name, setting_value) VALUES (?, ?)',
                    name,
                    '',
                );
            }
        };
        ensureSetting('Frozen_Order_Start');
        ensureSetting('Frozen_Order_End');
    },
};
