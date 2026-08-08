'use strict';

/**
 * Shelf quantity on FIFO / markdown kill_dates rows (default 1).
 */
module.exports = {
    name: 'kill_dates_quantity',
    up(db) {
        try {
            db.exec('ALTER TABLE kill_dates ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
        } catch (_) { /* column exists */ }
    },
};
