'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { expandRhythmTaskForBoard, buildRhythmAssignContext } = require('../src/lib/rhythm-task-expand.cjs');

test('expandRhythmTaskForBoard without schedule stays Unassigned', () => {
    const db = {
        get() { return undefined; },
        all() { return []; },
    };
    const rows = expandRhythmTaskForBoard(db, { detail: 'FIFO Audit', priority: 'Routine', zone: 'General', est_mins: 15 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_detail, 'FIFO Audit');
    assert.equal(rows[0].assigned_to, 'Unassigned');
});

test('expandRhythmTaskForBoard assigns with schedule context', () => {
    const db = {
        get(sql, name) {
            if (name === 'Active_Manager') return { setting_value: 'Luke' };
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts')) {
                return [{ staff_name: 'Kevin', shift_date: params[0], department: 'Stock/Float', role: '', start_time: '07:00' }];
            }
            if (sql.includes('FROM staff')) return [{ name: 'Kevin', role: 'Clerk' }, { name: 'Luke', role: 'Manager' }];
            return [];
        },
    };
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    const rows = expandRhythmTaskForBoard(db, { detail: 'Level off displays', zone: 'General' }, ctx);
    assert.equal(rows[0].assigned_to, 'Kevin');
});

test('isAutoClosedTask detects EOD auto archive', () => {
    const { isAutoClosedTask } = require('../src/lib/rhythm-task-expand.cjs');
    assert.equal(isAutoClosedTask({ closed_by: 'AUTO' }), true);
    assert.equal(isAutoClosedTask({ closed_by: 'Sam' }), false);
});
