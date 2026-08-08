'use strict';

/**
 * SMS "Price List with Cost" carries unit retail, unit cost, case cost and case
 * pack size — the numbers /count will need for on-hand value later.
 */
module.exports = {
    name: '052_item_catalog_prices',
    up(db) {
        const cols = new Set(
            (db.all('PRAGMA table_info(item_catalog)') || []).map((c) => c.name),
        );
        const add = (name, ddl) => {
            if (!cols.has(name)) db.exec(`ALTER TABLE item_catalog ADD COLUMN ${ddl}`);
        };
        add('retail_price', 'retail_price REAL');
        add('unit_cost', 'unit_cost REAL');
        add('case_cost', 'case_cost REAL');
        add('case_qty', 'case_qty INTEGER');
    },
};
