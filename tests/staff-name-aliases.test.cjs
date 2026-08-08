'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    attachStaffNameAliases,
    isStaffAliasIgnoredForSchedule,
    normalizeScheduleStaffName,
    resolveStaffAlias,
    seedStaffNameAliases,
    upsertStaffNameAlias,
    deactivateStaffNameAlias,
} = require('../src/lib/staff-name-aliases.cjs');
const { canonicalStaffName } = require('../src/lib/rhythm-schedule-assign.cjs');

function makeDb() {
    const tables = { staff_name_aliases: new Map() };
    const db = {
        exec() {},
        get(sql, ...params) {
            if (sql.includes('created_at FROM staff_name_aliases')) {
                return tables.staff_name_aliases.get(params[0]) || null;
            }
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO staff_name_aliases')) {
                const [sourceName, sourceKey, targetName, aliasType, notes, createdAt, updatedAt] = params;
                tables.staff_name_aliases.set(sourceName, {
                    source_name: sourceName,
                    source_key: sourceKey,
                    target_name: targetName,
                    alias_type: aliasType,
                    active: 1,
                    notes,
                    created_at: createdAt,
                    updated_at: updatedAt,
                });
                return { changes: 1 };
            }
            if (sql.includes('UPDATE staff_name_aliases SET active = 0')) {
                const row = tables.staff_name_aliases.get(params[1]);
                if (!row || row.active === 0) return { changes: 0 };
                row.active = 0;
                row.updated_at = params[0];
                return { changes: 1 };
            }
            return { changes: 1 };
        },
        all(sql) {
            if (sql.includes('staff_name_aliases')) {
                return [...tables.staff_name_aliases.values()].filter((r) => r.active !== 0);
            }
            return [];
        },
    };
    return db;
}

test('confirmed schedule aliases resolve to app staff names', () => {
    const db = makeDb();
    seedStaffNameAliases(db);

    assert.equal(normalizeScheduleStaffName(db, 'Isabella'), 'Izzy');
    assert.equal(normalizeScheduleStaffName(db, 'Abigail'), 'Abby');
    assert.equal(normalizeScheduleStaffName(db, 'Jessica'), 'Jess');
    assert.equal(normalizeScheduleStaffName(db, 'Lenora'), 'Nora');
});

test('Jennifer O is not mapped to Jenn', () => {
    const db = makeDb();
    seedStaffNameAliases(db);

    assert.equal(normalizeScheduleStaffName(db, 'Jennifer O'), 'Jennifer O');

    const directory = attachStaffNameAliases([
        { name: 'Jenn', role: 'Premium Clerk' },
    ], db.all('SELECT * FROM staff_name_aliases'));
    const alias = resolveStaffAlias(directory, 'Jennifer O');

    assert.equal(alias.alias_type, 'inactive');
    assert.equal(isStaffAliasIgnoredForSchedule(alias), true);
    assert.equal(canonicalStaffName(directory, 'Jennifer O'), '');
});

test('file-maintenance and pending schedule names are known but not rhythm assignees', () => {
    const db = makeDb();
    seedStaffNameAliases(db);

    const directory = attachStaffNameAliases([
        { name: 'Abby', role: 'Premium Clerk' },
        { name: 'Izzy', role: 'Clerk' },
    ], db.all('SELECT * FROM staff_name_aliases'));

    assert.equal(canonicalStaffName(directory, 'Shannon'), '');
    assert.equal(canonicalStaffName(directory, 'Connor'), '');
    assert.equal(canonicalStaffName(directory, 'Dawn'), '');
    assert.equal(canonicalStaffName(directory, 'Abigail'), 'Abby');
});

test('upsertStaffNameAlias saves and updates alias rows', () => {
    const db = makeDb();
    upsertStaffNameAlias(db, {
        source_name: 'Mike',
        target_name: 'Michael',
        alias_type: 'alias',
        notes: 'Schedule uses Mike',
    });
    assert.equal(normalizeScheduleStaffName(db, 'Mike'), 'Michael');
    upsertStaffNameAlias(db, {
        source_name: 'Mike',
        target_name: 'Michael B',
        alias_type: 'alias',
    });
    assert.equal(normalizeScheduleStaffName(db, 'Mike'), 'Michael B');
});

test('deactivateStaffNameAlias removes alias from active list', () => {
    const db = makeDb();
    upsertStaffNameAlias(db, { source_name: 'Temp', target_name: 'Temp Staff', alias_type: 'alias' });
    deactivateStaffNameAlias(db, 'Temp');
    assert.equal(db.all('SELECT * FROM staff_name_aliases WHERE active = 1').length, 0);
    assert.throws(() => deactivateStaffNameAlias(db, 'Missing'), /not found/i);
});
