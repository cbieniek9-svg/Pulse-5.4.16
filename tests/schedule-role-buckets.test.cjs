'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyShift, DEFAULT_SCHEDULE_ROLE_RULES } = require('../src/lib/schedule-role-buckets.cjs');
const {
    taskAssignRule,
    shouldSkipFifoRhythm,
    fifoEligibleForStaff,
    buildRhythmAssignContext,
    expandRhythmTaskForBoard,
} = require('../src/lib/rhythm-schedule-assign.cjs');

test('classifyShift maps bakery to bakery bucket not stock_float', () => {
    assert.equal(classifyShift('Bakery', ''), 'bakery');
    assert.equal(classifyShift('BAKE', 'Clerk'), 'bakery');
    assert.equal(classifyShift('Stock/Float', ''), 'stock_float');
    assert.equal(classifyShift('', 'REC'), 'rec');
});

test('Receive vendor tasks assign to rec bucket only', () => {
    assert.equal(taskAssignRule('Receive SYSCO order'), 'rec');
    assert.equal(taskAssignRule('Check freezer for fallen items'), 'stock_float');
});

test('fifoEligibleForStaff excludes bakery from floor aisles', () => {
    const ctx = {
        staffBuckets: { isabella: 'bakery' },
        scheduledNames: new Set(['isabella']),
        directory: [{ name: 'Isabella' }],
    };
    assert.equal(fifoEligibleForStaff(ctx, 'Isabella', ['Bakery']), true);
    assert.equal(fifoEligibleForStaff(ctx, 'Isabella', ['A1']), false);
    assert.equal(fifoEligibleForStaff(ctx, 'Kevin', ['A1']), false);
});

test('shouldSkipFifoRhythm on TGP order days', () => {
    const db = {
        get(sql, day) {
            if (sql.includes('TGP Order') && day === 'Tuesday') return { ok: 1 };
            if (sql.includes('setting_name')) return { setting_value: '' };
            return undefined;
        },
    };
    assert.equal(shouldSkipFifoRhythm(db, '2026-06-09'), true);
});

test('expandRhythmTaskForBoard skips FIFO on order day', () => {
    const db = {
        get(sql, ...params) {
            if (sql.includes('setting_name') && params[0] === 'Schedule_Role_Buckets') return undefined;
            if (sql.includes('TGP Order')) return { ok: 1 };
            if (sql.includes('setting_name')) return undefined;
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts')) return [];
            if (sql.includes('FROM staff')) return [];
            return [];
        },
    };
    const ctx = buildRhythmAssignContext(db, '2026-06-10');
    const rows = expandRhythmTaskForBoard(db, { detail: 'FIFO Audit', zone: 'General' }, ctx);
    assert.equal(rows.length, 0);
});

test('bakery scheduled staff not in stock_float assignment pool', () => {
    const db = {
        get(sql, ...params) {
            if (sql.includes('setting_name') && params[0] === 'Active_Manager') return { setting_value: '' };
            if (sql.includes('setting_name')) return undefined;
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts')) {
                return [{ staff_name: 'Isabella', shift_date: params[0], department: 'Bakery', role: '', start_time: '07:00' }];
            }
            if (sql.includes('FROM staff')) return [{ name: 'Isabella', role: 'Clerk' }];
            return [];
        },
    };
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    assert.ok(ctx.buckets.bakery.includes('Isabella'));
    assert.equal(ctx.buckets.stock_float.includes('Isabella'), false);
    const freezer = expandRhythmTaskForBoard(db, { detail: 'Check freezer for fallen items', zone: 'General' }, ctx)[0];
    assert.notEqual(freezer.assigned_to, 'Isabella');
});

test('default role rules are valid regex', () => {
    assert.ok(DEFAULT_SCHEDULE_ROLE_RULES.length >= 5);
    DEFAULT_SCHEDULE_ROLE_RULES.forEach((rule) => {
        assert.doesNotThrow(() => new RegExp(rule.match, 'i'));
    });
});
