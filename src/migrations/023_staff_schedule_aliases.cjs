'use strict';

const {
    DEFAULT_STAFF_NAME_ALIASES,
    ensureStaffNameAliasTable,
    seedStaffNameAliases,
} = require('../lib/staff-name-aliases.cjs');

const ACTIVE_ALIAS_PAIRS = DEFAULT_STAFF_NAME_ALIASES
    .filter((row) => row.alias_type === 'alias' && row.target_name)
    .map((row) => [row.source_name, row.target_name]);

module.exports = {
    name: 'staff_schedule_name_aliases',
    up(db) {
        ensureStaffNameAliasTable(db);
        seedStaffNameAliases(db);

        ACTIVE_ALIAS_PAIRS.forEach(([source, target]) => {
            db.run('UPDATE staff_shifts SET staff_name = ? WHERE lower(trim(staff_name)) = lower(trim(?))', target, source);
            db.run('UPDATE tasks SET assigned_to = ? WHERE lower(trim(assigned_to)) = lower(trim(?))', target, source);
        });
    },
};
