'use strict';

function hasColumn(db, table, column) {
    return (db.all(`PRAGMA table_info(${table})`) || []).some((row) => row.name === column);
}

module.exports = {
    name: 'presence_zone_since',
    up(db) {
        if (!hasColumn(db, 'presence_staff_zones', 'zone_since')) {
            db.exec('ALTER TABLE presence_staff_zones ADD COLUMN zone_since TEXT');
        }
    },
};
