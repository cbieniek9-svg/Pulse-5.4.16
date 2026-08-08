'use strict';

function addColumn(db, sql) {
    try {
        db.run(sql);
    } catch (e) {
        if (!String(e.message || '').includes('duplicate column')) throw e;
    }
}

module.exports = {
    name: 'receiving_vendor_work_tasks',
    up(db) {
        addColumn(db, 'ALTER TABLE expected_orders ADD COLUMN create_task INTEGER DEFAULT 0');
        db.exec(`
            CREATE INDEX IF NOT EXISTS idx_expected_orders_create_task
                ON expected_orders(create_task, status);
        `);
    },
};
