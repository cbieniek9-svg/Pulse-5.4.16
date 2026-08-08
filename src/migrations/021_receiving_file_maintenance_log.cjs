'use strict';

function addColumn(db, sql) {
    try {
        db.run(sql);
    } catch (e) {
        if (!String(e.message || '').includes('duplicate column')) throw e;
    }
}

module.exports = {
    name: 'receiving_file_maintenance_log',
    up(db) {
        addColumn(db, 'ALTER TABLE expected_orders ADD COLUMN invoice_ref TEXT');
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_expected_orders_invoice_ref
                ON expected_orders(invoice_ref);
        `);
    },
};
