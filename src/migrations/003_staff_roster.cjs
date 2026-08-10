'use strict';

module.exports = {
    name: 'shift_order_staff_roster',
    up(db) {
        try {
            db.exec("ALTER TABLE shift_order_history ADD COLUMN staff_roster TEXT DEFAULT ''");
        } catch (e) {
            const msg = String(e.message || '').toLowerCase();
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
        }
    },
};
