'use strict';

module.exports = {
    name: 'shift_lead_eligible',
    up(db) {
        try {
            db.exec('ALTER TABLE staff ADD COLUMN shift_lead_eligible INTEGER DEFAULT 1');
        } catch (_) { /* exists */ }
        db.run("UPDATE staff SET shift_lead_eligible = 0 WHERE role = 'Store Manager'");
    },
};
