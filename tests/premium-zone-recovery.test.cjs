'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    validatePremiumZoneRecovery,
    createPremiumZoneRecoveryTasks,
    resolveZoneOwner,
} = require('../src/lib/premium-zone-recovery.cjs');

function mockDb({ zoneOwners = {}, staff = [] } = {}) {
    const tasks = [];
    const audits = [];
    return {
        tasks,
        audits,
        get(sql, ...params) {
            if (sql.includes('Zone_Ownership')) {
                return { setting_value: JSON.stringify(zoneOwners) };
            }
            if (sql.includes('FROM staff')) {
                return staff.find((s) => s.name === params[0]);
            }
            return undefined;
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO tasks')) {
                tasks.push({ task_id: params[0], task_detail: params[1], assigned_to: params[5], zone: params[4] });
            }
        },
        transaction(fn) {
            return () => fn();
        },
        upsertAudit(...args) {
            audits.push(args);
        },
    };
}

test('validatePremiumZoneRecovery requires zone, premium, and at least one fail', () => {
    assert.deepEqual(validatePremiumZoneRecovery(null), [
        'check payload must be a JSON object.',
    ]);
    const base = {
        zone_name: 'Zone 2',
        premium_name: 'Luke',
        front_edge_pass: 1,
        tag_integrity_pass: 1,
        hole_strategy_pass: 1,
        clearances_pass: 1,
    };
    assert.ok(validatePremiumZoneRecovery(base).some((e) => e.includes('FAIL')));
    assert.deepEqual(validatePremiumZoneRecovery({ ...base, front_edge_pass: 0 }), []);
});

test('resolveZoneOwner reads active staff from Zone_Ownership', () => {
    const db = mockDb({
        zoneOwners: { 'Zone 1': 'Kevin' },
        staff: [{ name: 'Kevin', active: 1 }],
    });
    assert.equal(resolveZoneOwner(db, 'Zone 1'), 'Kevin');
    assert.equal(resolveZoneOwner(db, 'Zone 3'), 'Unassigned');
});

test('createPremiumZoneRecoveryTasks inserts recovery tasks for failed Core 4 points', () => {
    const db = mockDb({
        zoneOwners: { 'Zone 2': 'Sam' },
        staff: [{ name: 'Sam', active: 1 }],
    });
    const result = createPremiumZoneRecoveryTasks(db, {
        zone_name: 'Zone 2',
        premium_name: 'Luke',
        front_edge_pass: 0,
        tag_integrity_pass: 1,
        hole_strategy_pass: 0,
        clearances_pass: 1,
        notes: 'Needs pull-forward',
    }, 'Luke');
    assert.equal(result.tasksCreated, 2);
    assert.equal(result.assignee, 'Sam');
    assert.equal(db.tasks.length, 2);
    assert.match(db.tasks[0].task_detail, /RECOVERY: FRONT-EDGE/);
    assert.match(db.tasks[1].task_detail, /RECOVERY: HOLE STRATEGY/);
    assert.equal(db.tasks[0].assigned_to, 'Sam');
});
