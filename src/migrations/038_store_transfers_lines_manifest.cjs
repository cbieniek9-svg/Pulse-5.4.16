'use strict';

/**
 * Add line items + manifest file to store transfers.
 */
function addColumn(db, sql) {
    try {
        db.run(sql);
    } catch (e) {
        if (!String(e.message || '').includes('duplicate column')) throw e;
    }
}

module.exports = {
    name: 'store_transfers_lines_manifest',
    up(db) {
        addColumn(db, 'ALTER TABLE store_transfers ADD COLUMN line_items_json TEXT NOT NULL DEFAULT \'[]\'');
        addColumn(db, 'ALTER TABLE store_transfers ADD COLUMN manifest_file_name TEXT NOT NULL DEFAULT \'\'');
        addColumn(db, 'ALTER TABLE store_transfers ADD COLUMN storage_type TEXT NOT NULL DEFAULT \'Cooler\'');
        addColumn(db, 'ALTER TABLE store_transfers ADD COLUMN pallets REAL');
        addColumn(db, 'ALTER TABLE store_transfers ADD COLUMN weight_kg REAL');
    },
};
