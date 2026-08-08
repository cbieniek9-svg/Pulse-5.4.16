'use strict';

module.exports = {
    name: 'shift_order_staff_roster',
    up(db) {
        try {
            db.exec("ALTER TABLE shift_order_history ADD COLUMN staff_roster TEXT DEFAULT ''");
        } catch (_) { /* exists */ }
    },
};
