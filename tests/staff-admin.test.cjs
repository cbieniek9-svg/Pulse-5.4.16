'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTION_SCHEMAS } = require('../src/constants/action-schema.cjs');
const { validateAction } = require('../src/validation/action-request.cjs');
const { createActionHandlers } = require('../src/actions/handlers.cjs');

test('staff insert accepts shift_lead_eligible in schema', () => {
    assert.ok(ACTION_SCHEMAS.staff.columns.includes('shift_lead_eligible'));
    assert.doesNotThrow(() => validateAction({
        table: 'staff',
        action: 'insert',
        data: {
            name: 'Test User',
            active: 1,
            pin: '1234',
            app_access: 1,
            role: 'Clerk',
            permissions: '',
            shift_lead_eligible: 1,
        },
    }));
});

test('validateAction rejects malformed insert and update payloads', () => {
    assert.throws(
        () => validateAction({ table: 'tasks', action: 'insert', data: {} }),
        /Insert data cannot be empty/,
    );
    assert.throws(
        () => validateAction({ table: 'tasks', action: 'update', id_col: 'task_id', id_val: 'T-1', data: null }),
        /Action data must be an object/,
    );
    assert.throws(
        () => validateAction({ table: 'tasks', action: 'update', id_col: 'task_id', id_val: 'T-1', data: [] }),
        /Action data must be an object/,
    );
});

test('staff_insert uses insertStaffRow', () => {
    const inserted = [];
    const db = {
        all(q) {
            if (q.includes('PRAGMA table_info')) {
                return [{ name: 'shift_lead_eligible' }, { name: 'name' }, { name: 'active' }, { name: 'pin' }, { name: 'app_access' }, { name: 'role' }, { name: 'permissions' }, { name: 'pin_hashed' }];
            }
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO staff')) inserted.push({ sql, params });
        },
    };
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {} });
    handlers.staff_insert({
        table: 'staff',
        workingData: { name: 'Corp Admin', active: 1, pin: '1234', app_access: 0, role: 'Store Manager', permissions: '' },
        actorName: 'Manager',
        serverTime: '2026-06-08T12:00:00.000Z',
    });
    assert.equal(inserted.length, 1);
    handlers.staff_insert({
        table: 'staff',
        workingData: { name: 'Sam', active: 1, pin: '5678', app_access: 1, role: 'Premium Clerk', permissions: 'tasks' },
        actorName: 'Manager',
        serverTime: '2026-06-08T12:00:00.000Z',
    });
    assert.ok(inserted.length >= 2);
});
