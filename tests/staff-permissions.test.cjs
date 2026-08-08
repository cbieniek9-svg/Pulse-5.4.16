'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    insertStaffRow,
    hasStaffPermission,
    defaultPermissionsForRole,
    staffHasColumn,
    isManagerRole,
    listStaffForSync,
    listActiveStaffForLead,
    canAccessSafeInspections,
    canAccessInventoryCount,
    CLERK_PERMISSIONS,
} = require('../src/lib/staff-permissions.cjs');
const { isTaskWorkTimingEnabled } = require('../src/lib/task-work-timing.cjs');
const { suggestEstMinutes, refreshLearnedEstimate } = require('../src/lib/task-estimates.cjs');

test('isManagerRole includes Store Manager', () => {
    assert.equal(isManagerRole('Manager'), true);
    assert.equal(isManagerRole('Store Manager'), true);
    assert.equal(isManagerRole('Clerk'), false);
});

test('Premium Clerks can load daily rhythm (shift-lead auth)', () => {
    const { canLoadDailyRhythm } = require('../src/routes/manager/maintenance.cjs');
    assert.equal(canLoadDailyRhythm({ role: 'Premium Clerk', name: 'Lead' }), true);
    assert.equal(canLoadDailyRhythm({ role: 'Manager', name: 'Mgr' }), true);
    assert.equal(canLoadDailyRhythm({ role: 'Store Manager', name: 'SM' }), true);
    assert.equal(canLoadDailyRhythm({ role: 'Clerk', name: 'Clerk' }), false);
    assert.equal(canLoadDailyRhythm(null), false);
});

test('listStaffForSync defaults shift_lead_eligible when column missing', () => {
    const db = {
        all(q) {
            if (q.includes('PRAGMA table_info')) {
                return [{ name: 'id' }, { name: 'name' }, { name: 'active' }, { name: 'app_access' }, { name: 'role' }, { name: 'permissions' }];
            }
            if (q.includes('FROM staff ORDER BY name')) {
                return [{ id: 1, name: 'Sam', active: 1, app_access: 1, role: 'Clerk', permissions: 'tasks' }];
            }
            return [];
        },
    };
    const rows = listStaffForSync(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].shift_lead_eligible, 1);
});

test('listActiveStaffForLead defaults shift_lead_eligible when column missing', () => {
    const db = {
        all(q) {
            if (q.includes('PRAGMA table_info')) return [{ name: 'name' }, { name: 'role' }, { name: 'active' }];
            if (q.includes('WHERE active = 1')) return [{ name: 'Lead', role: 'Premium Clerk', active: 1 }];
            return [];
        },
    };
    const rows = listActiveStaffForLead(db);
    assert.equal(rows[0].shift_lead_eligible, 1);
});

test('insertStaffRow omits shift_lead_eligible when column missing', () => {
    const sql = [];
    const db = {
        all(q) {
            if (q.includes('PRAGMA table_info')) {
                return [{ name: 'name' }, { name: 'active' }, { name: 'pin' }, { name: 'app_access' }, { name: 'role' }, { name: 'permissions' }, { name: 'pin_hashed' }];
            }
            return [];
        },
        run(s, ...params) { sql.push({ s, params }); },
    };
    insertStaffRow(db, { name: 'Sam Test', pin: '1234', app_access: 1, role: 'Clerk', permissions: 'tasks' });
    assert.equal(sql.length, 1);
    assert.match(sql[0].s, /INSERT INTO staff/);
    assert.ok(!sql[0].s.includes('shift_lead_eligible'));
});

test('insertStaffRow includes shift_lead_eligible when column exists', () => {
    const sql = [];
    const db = {
        all(q) {
            if (q.includes('PRAGMA table_info')) {
                return [{ name: 'shift_lead_eligible' }, { name: 'name' }, { name: 'pin_hashed' }];
            }
            return [];
        },
        run(s, ...params) { sql.push({ s, params }); },
    };
    insertStaffRow(db, { name: 'Lead', pin: '1234', app_access: 1, role: 'Premium Clerk', permissions: 'tasks' });
    assert.ok(sql[0].s.includes('shift_lead_eligible'));
});

test('defaultPermissionsForRole grants tasks to clerks with app access', () => {
    assert.equal(defaultPermissionsForRole('Clerk', 1), 'tasks');
    assert.equal(defaultPermissionsForRole('Clerk', 0), '');
    assert.equal(defaultPermissionsForRole('Premium Clerk', 1), 'tasks,receiving');
});

test('hasStaffPermission respects tasks flag for clerks', () => {
    const db = {
        findStaffByName: (name) => ({ name, permissions: name === 'Sam' ? 'tasks' : '' }),
    };
    assert.equal(hasStaffPermission(db, { name: 'Sam', role: 'Clerk' }, 'tasks'), true);
    assert.equal(hasStaffPermission(db, { name: 'Pat', role: 'Clerk' }, 'tasks'), false);
    assert.equal(hasStaffPermission(db, { name: 'Lead', role: 'Premium Clerk' }, 'tasks'), true);
    assert.equal(hasStaffPermission(db, { name: 'Boss', role: 'Manager' }, 'tasks'), true);
});

test('canAccessSafeInspections allows managers or safe permission', () => {
    const db = {
        findStaffByName: (name) => ({ name, permissions: name === 'Lee' ? 'safe' : 'tasks' }),
    };
    assert.equal(canAccessSafeInspections(db, { name: 'Boss', role: 'Manager' }), true);
    assert.equal(canAccessSafeInspections(db, { name: 'Lee', role: 'Clerk' }), true);
    assert.equal(canAccessSafeInspections(db, { name: 'Sam', role: 'Clerk' }), false);
});

test('CLERK_PERMISSIONS keys include inventory; canAccessInventoryCount mirrors hasStaffPermission', () => {
    assert.deepEqual(
        CLERK_PERMISSIONS.map((p) => p.key),
        ['tasks', 'receiving', 'markdown', 'comms', 'safe', 'inventory'],
    );
    const db = {
        findStaffByName: (name) => ({ name, permissions: name === 'Pat' ? 'inventory' : 'tasks' }),
    };
    assert.equal(canAccessInventoryCount(db, { name: 'Boss', role: 'Manager' }), true);
    assert.equal(canAccessInventoryCount(db, { name: 'Pat', role: 'Clerk' }), true);
    assert.equal(canAccessInventoryCount(db, { name: 'Sam', role: 'Clerk' }), false);
    assert.ok(!defaultPermissionsForRole('Clerk', 1).includes('inventory'));
    assert.ok(!defaultPermissionsForRole('Premium Clerk', 1).includes('inventory'));
});

test('task work timing disabled by default', () => {
    assert.equal(isTaskWorkTimingEnabled({}), false);
    assert.equal(isTaskWorkTimingEnabled({ Task_Work_Timing_Enabled: '0' }), false);
    assert.equal(isTaskWorkTimingEnabled({ Task_Work_Timing_Enabled: '1' }), true);
});

test('suggestEstMinutes skips learning when timing off', () => {
    const db = {
        getSettings: () => ({ Task_Work_Timing_Enabled: '0' }),
        get: () => ({ avg_mins: 99, sample_count: 10 }),
    };
    assert.equal(suggestEstMinutes(db, { detail: 'Store walk', fallback: 12 }), 12);
});

test('refreshLearnedEstimate no-ops when timing off', () => {
    const db = {
        getSettings: () => ({ Task_Work_Timing_Enabled: '0' }),
        run() { throw new Error('should not write'); },
    };
    assert.equal(refreshLearnedEstimate(db, {
        task_detail: 'Store walk', closed_by: 'Sam', start_time: '2026-01-01T10:00:00.000Z', time_closed: '2026-01-01T10:15:00.000Z',
    }), null);
});
