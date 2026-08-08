'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildRhythmAssignContext,
    expandRhythmTaskForBoard,
    classifyShift,
    taskAssignRule,
} = require('../src/lib/rhythm-schedule-assign.cjs');

function mockDb({ settings = {}, staff = [], shifts = [] } = {}) {
    return {
        get(sql, ...params) {
            if (sql.includes('setting_name')) {
                const name = params[0];
                return settings[name] != null ? { setting_value: settings[name] } : undefined;
            }
            if (sql.includes("status='Open'")) return { c: 0 };
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts')) {
                return shifts.filter((s) => s.shift_date === params[0]);
            }
            if (sql.includes('FROM staff')) return staff;
            return [];
        },
    };
}

test('classifyShift maps schedule roles', () => {
    assert.equal(classifyShift('Stock/Float', ''), 'stock_float');
    assert.equal(classifyShift('Bakery', ''), 'bakery');
    assert.equal(classifyShift('', 'REC'), 'rec');
    assert.equal(classifyShift('Receiving', ''), 'rec');
    assert.equal(classifyShift('', 'Premium Clerk'), 'premium');
    assert.equal(classifyShift('Open Cash', ''), 'cash');
});

test('buildRhythmAssignContext buckets today shifts', () => {
    const db = mockDb({
        settings: { Active_Manager: 'Luke' },
        staff: [
            { name: 'Luke', role: 'Manager' },
            { name: 'Kevin', role: 'Clerk' },
            { name: 'Sam', role: 'Clerk' },
        ],
        shifts: [
            { staff_name: 'Luke', shift_date: '2026-06-08', department: 'Premium', role: '', start_time: '06:00' },
            { staff_name: 'Kevin', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' },
            { staff_name: 'Sam', shift_date: '2026-06-08', department: 'REC', role: '', start_time: '06:00' },
        ],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    assert.equal(ctx.hasSchedule, true);
    assert.equal(ctx.stockFloatPrimary, 'Kevin');
    assert.equal(ctx.recPrimary, 'Sam');
    assert.equal(ctx.shiftLead, 'Luke');
});

test('expandRhythmTaskForBoard assigns stock/float and shift lead from schedule', () => {
    const db = mockDb({
        settings: { Active_Manager: 'Luke' },
        staff: [{ name: 'Luke', role: 'Manager' }, { name: 'Kevin', role: 'Clerk' }],
        shifts: [
            { staff_name: 'Luke', shift_date: '2026-06-08', department: 'Premium', role: '', start_time: '06:00' },
            { staff_name: 'Kevin', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' },
        ],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    const level = expandRhythmTaskForBoard(db, { detail: 'Level off displays', zone: 'General' }, ctx)[0];
    const huddle = expandRhythmTaskForBoard(db, { detail: 'Daily direction huddle', zone: 'General' }, ctx)[0];
    assert.equal(level.assigned_to, 'Kevin');
    assert.equal(huddle.assigned_to, 'Luke');
});

test('expandRhythmTaskForBoard expands FIFO from aisle assignments when scheduled', () => {
    const db = mockDb({
        settings: {
            FIFO_Aisle_Assignments: JSON.stringify([
                { staff: 'Kevin', aisles: ['A1'] },
                { staff: 'Abigail', aisles: ['A2'] },
            ]),
            Zone_Mapping: JSON.stringify({ 'Zone 2': ['map-a1'], 'Zone 1': ['map-a2'] }),
            Zone_Section_Labels: JSON.stringify({
                'map-a1': { label: 'A1' },
                'map-a2': { label: 'A2' },
            }),
        },
        staff: [{ name: 'Kevin', role: 'Clerk' }, { name: 'Abigail', role: 'Clerk' }],
        shifts: [
            { staff_name: 'Kevin', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' },
        ],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    const rows = expandRhythmTaskForBoard(db, { detail: 'FIFO Audit', zone: 'General' }, ctx);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].task_detail, 'FIFO Audit — A1');
    assert.equal(rows[0].assigned_to, 'Kevin');
    assert.equal(rows[0].zone, 'A1');
});

test('expandRhythmTaskForBoard stays Unassigned without imported schedule', () => {
    const db = mockDb({ settings: {}, staff: [], shifts: [] });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    const row = expandRhythmTaskForBoard(db, { detail: 'Store walk', zone: 'General' }, ctx)[0];
    assert.equal(row.assigned_to, 'Unassigned');
    assert.equal(ctx.hasSchedule, false);
});

test('taskAssignRule maps rhythm templates', () => {
    assert.equal(taskAssignRule('TGP Order'), 'rec');
    assert.equal(taskAssignRule('Work the TGP order'), 'stock_float');
    assert.equal(taskAssignRule('FIFO Audit'), 'fifo_expand');
    assert.equal(taskAssignRule('Mid-day zone walk (Core 4)'), 'shift_lead');
    assert.equal(taskAssignRule('Pre-close zone walk (Core 4)'), 'shift_lead');
});

test('expandRhythmTaskForBoard distributes stock/float tasks across scheduled staff', () => {
    const db = mockDb({
        settings: { Active_Manager: '' },
        staff: [
            { name: 'Kevin', role: 'Clerk' },
            { name: 'Abigail', role: 'Clerk' },
        ],
        shifts: [
            { staff_name: 'Kevin', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' },
            { staff_name: 'Abigail', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' },
        ],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    const a = expandRhythmTaskForBoard(db, { detail: 'Level off displays', zone: 'General' }, ctx)[0];
    const b = expandRhythmTaskForBoard(db, { detail: 'Check freezer for fallen items', zone: 'General' }, ctx)[0];
    assert.notEqual(a.assigned_to, 'Unassigned');
    assert.notEqual(b.assigned_to, 'Unassigned');
    assert.notEqual(a.assigned_to, b.assigned_to);
});

test('premium clerk on stock/float schedule row is still a shift-lead candidate', () => {
    const db = mockDb({
        settings: { Active_Manager: '' },
        staff: [{ name: 'Ashley', role: 'Premium Clerk' }],
        shifts: [{ staff_name: 'Ashley', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' }],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    assert.ok(ctx.buckets.premium.includes('Ashley'));
    const huddle = expandRhythmTaskForBoard(db, { detail: 'Daily direction huddle', zone: 'General' }, ctx)[0];
    assert.equal(huddle.assigned_to, 'Ashley');
});

test('shift lead does not fall back to stock/float clerk', () => {
    const db = mockDb({
        settings: { Active_Manager: '' },
        staff: [{ name: 'Kevin', role: 'Clerk' }],
        shifts: [{ staff_name: 'Kevin', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' }],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    assert.equal(ctx.shiftLead, '');
    const huddle = expandRhythmTaskForBoard(db, { detail: 'Daily direction huddle', zone: 'General' }, ctx)[0];
    assert.equal(huddle.assigned_to, 'Unassigned');
});

test('reapplyRhythmAssignments updates open tasks from schedule', () => {
    const updates = [];
    const db = {
        get(sql, ...params) {
            if (sql.includes('setting_name')) {
                const map = { Active_Manager: 'Luke', FIFO_Aisle_Assignments: '[]', Store_Timezone: 'America/Edmonton' };
                return map[params[0]] != null ? { setting_value: map[params[0]] } : undefined;
            }
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts')) {
                return [
                    { staff_name: 'Luke', shift_date: params[0], department: 'Premium', role: '', start_time: '06:00' },
                    { staff_name: 'Kevin', shift_date: params[0], department: 'Stock/Float', role: '', start_time: '07:00' },
                ];
            }
            if (sql.includes('FROM staff')) return [{ name: 'Luke', role: 'Manager' }, { name: 'Kevin', role: 'Clerk' }];
            if (sql.includes("status='Open'") && sql.includes('date(time_submitted')) {
                const storeDate = params[1];
                const all = [
                    { task_id: 'T-1', task_detail: 'Level off displays', assigned_to: 'Unassigned', zone: 'General', time_submitted: '2026-06-08T12:00:00.000Z' },
                    { task_id: 'T-2', task_detail: 'Daily direction huddle', assigned_to: 'Unassigned', zone: 'General', time_submitted: '2026-06-08T12:00:00.000Z' },
                    { task_id: 'T-3', task_detail: 'FIFO Audit — A1', assigned_to: 'Kevin', zone: 'Zone 2', time_submitted: '2026-06-08T12:00:00.000Z' },
                    { task_id: 'T-OLD', task_detail: 'Level off displays', assigned_to: 'Unassigned', zone: 'General', time_submitted: '2026-06-07T12:00:00.000Z' },
                ];
                return all.filter((t) => String(t.time_submitted).slice(0, 10) === storeDate);
            }
            return [];
        },
        transaction(fn) { return fn; },
        run(sql, ...params) {
            if (sql.includes('UPDATE tasks')) {
                updates.push({
                    assignee: params[0],
                    zone: sql.includes('zone = ?') ? params[1] : undefined,
                    taskId: sql.includes('zone = ?') ? params[2] : params[1],
                });
            }
        },
    };
    const { reapplyRhythmAssignments } = require('../src/lib/rhythm-schedule-assign.cjs');
    const result = reapplyRhythmAssignments(db, '2026-06-08');
    assert.equal(result.updated, 3);
    assert.equal(result.total, 3);
    assert.equal(updates.find((u) => u.taskId === 'T-1')?.assignee, 'Kevin');
    assert.equal(updates.find((u) => u.taskId === 'T-2')?.assignee, 'Luke');
    assert.equal(updates.find((u) => u.taskId === 'T-3')?.zone, 'A1');
    assert.equal(updates.find((u) => u.taskId === 'T-OLD'), undefined);
});

test('supervisor owns huddle/walks; premium covers when supervisor not in yet', () => {
    const { pickShiftLeadAssignee, classifyShift } = require('../src/lib/rhythm-schedule-assign.cjs');
    assert.equal(classifyShift('Supervisor', ''), 'supervisor');

    const db = mockDb({
        settings: { Active_Manager: '' },
        staff: [
            { name: 'Chris', role: 'Manager' },
            { name: 'Luke', role: 'Premium Clerk' },
        ],
        shifts: [
            { staff_name: 'Chris', shift_date: '2026-06-08', department: 'Supervisor', role: '', start_time: '10:00' },
            { staff_name: 'Luke', shift_date: '2026-06-08', department: 'Premium', role: '', start_time: '06:00' },
        ],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    assert.ok(ctx.buckets.supervisor.includes('Chris'));
    assert.ok(ctx.buckets.premium.includes('Luke'));

    // 07:00 — supervisor not in yet → premium covers
    const early = { ...ctx, nowMinutes: 7 * 60 };
    assert.equal(pickShiftLeadAssignee(early), 'Luke');
    const earlyHuddle = expandRhythmTaskForBoard(
        db,
        { detail: 'Daily direction huddle', zone: 'General' },
        early,
    )[0];
    assert.equal(earlyHuddle.assigned_to, 'Luke');

    // 11:00 — supervisor in → supervisor owns it
    const late = { ...ctx, nowMinutes: 11 * 60 };
    assert.equal(pickShiftLeadAssignee(late), 'Chris');
    const lateWalk = expandRhythmTaskForBoard(
        db,
        { detail: 'Store walk', zone: 'General', assign_bucket: 'shift_lead' },
        late,
    )[0];
    assert.equal(lateWalk.assigned_to, 'Chris');
});

test('assign_bucket pins rhythm task to schedule tag', () => {
    const db = mockDb({
        settings: { Active_Manager: '' },
        staff: [
            { name: 'Sam', role: 'Clerk' },
            { name: 'Kevin', role: 'Clerk' },
        ],
        shifts: [
            { staff_name: 'Sam', shift_date: '2026-06-08', department: 'REC', role: '', start_time: '06:00' },
            { staff_name: 'Kevin', shift_date: '2026-06-08', department: 'Stock/Float', role: '', start_time: '07:00' },
        ],
    });
    const ctx = buildRhythmAssignContext(db, '2026-06-08');
    // Detail would normally go to stock_float; assign_bucket forces REC.
    const row = expandRhythmTaskForBoard(
        db,
        { detail: 'Level off displays', zone: 'General', assign_bucket: 'rec' },
        ctx,
    )[0];
    assert.equal(row.assigned_to, 'Sam');
});
