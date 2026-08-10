'use strict';

const { STORE_HOUR_DEFAULTS } = require('../lib/store-hours.cjs');

module.exports = {
    name: 'store_hours_and_order_clock_metrics',
    up(db) {
        const addCol = (sql) => {
            try { db.exec(sql); } catch (e) {
                const msg = String(e.message || '').toLowerCase();
                if (!msg.includes('duplicate column') && !msg.includes('already exists')) throw e;
            }
        };
        addCol('ALTER TABLE shift_order_history ADD COLUMN raw_clock_minutes INTEGER DEFAULT 0');
        addCol('ALTER TABLE shift_order_history ADD COLUMN spans_calendar_day INTEGER DEFAULT 0');

        Object.entries(STORE_HOUR_DEFAULTS).forEach(([name, value]) => {
            db.run(
                'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
                name,
                value,
            );
        });
    },
};
