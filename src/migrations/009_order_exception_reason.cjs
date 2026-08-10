'use strict';

module.exports = {
    name: 'order_exception_reason',
    up(db) {
        // Why a given order day deviated (truck late, short-staffed, oversized order, etc.).
        // Captured at FINISH so the scorecard/history can separate a bad process from a bad day.
        try {
            db.exec("ALTER TABLE shift_order_history ADD COLUMN exception_reason TEXT DEFAULT ''");
        } catch (e) {
            const msg = String(e.message || '').toLowerCase();
            if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
        }
    },
};
