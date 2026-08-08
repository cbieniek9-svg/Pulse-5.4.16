'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ackAction,
    filterAckedReportActions,
    deferRhythmTasks,
    applyRhythmEstUpdates,
    loadActionAcks,
    getDeferredRhythmIds,
    hasRhythmTemplate,
    canAddTaskTypeToRhythm,
    enrichTaskPlanningSummary,
    addRhythmFromPlanning,
    enrichReportActions,
} = require('../src/lib/reports-actions.cjs');

function mockDb(initial = {}) {
    const settings = new Map(Object.entries(initial.settings || {}));
    const rhythmTasks = [...(initial.rhythm_tasks || [
        { id: '1', detail: 'Store walk', est_mins: 10 },
        { id: '2', detail: 'FIFO Audit A', est_mins: 15 },
        { id: '3', detail: 'FIFO Audit B', est_mins: 15 },
    ])];
    const tasks = [...(initial.tasks || [
        { task_id: 't1', task_detail: 'Store walk', status: 'Open', priority: 'Routine', zone: 'General', time_submitted: '2026-05-19T12:00:00.000Z' },
    ])];
    const writes = [];

    return {
        get(sql, ...params) {
            if (sql.includes('setting_value FROM settings')) {
                const key = params[0];
                if (key === 'Manager_Action_Acks' || key === 'Rhythm_Deferred' || key === 'Rhythm_Defer_Log' || key === 'Store_Timezone') {
                    return { setting_value: settings.get(key) || (key === 'Store_Timezone' ? 'America/Edmonton' : '') };
                }
            }
            if (sql.includes('FROM rhythm_tasks WHERE id IN')) {
                const id = params[0];
                return rhythmTasks.find((r) => String(r.id) === String(id)) || null;
            }
            if (sql.includes('FROM rhythm_tasks WHERE detail=?')) {
                if (params.length >= 2) {
                    return rhythmTasks.find((r) => r.day === params[0] && r.detail === params[1]) || null;
                }
                return rhythmTasks.find((r) => r.detail === params[0]) || null;
            }
            if (sql.includes('SELECT id FROM rhythm_tasks WHERE detail=?')) {
                return rhythmTasks.find((r) => r.detail === params[0]) || null;
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('FROM rhythm_tasks WHERE id IN')) {
                const ids = params;
                return rhythmTasks.filter((r) => ids.includes(String(r.id)));
            }
            if (sql.includes('FROM rhythm_tasks WHERE detail LIKE')) {
                const prefix = String(params[0]).replace('%', '');
                return rhythmTasks.filter((r) => r.detail.startsWith(prefix));
            }
            if (sql.includes('FROM tasks') && sql.includes('task_detail=?')) {
                const hasDateFilter = sql.includes('date(time_submitted');
                const detail = hasDateFilter ? params[2] : params[0];
                const storeDate = hasDateFilter ? params[1] : null;
                return tasks.filter((t) =>
                    t.status === 'Open'
                    && t.priority === 'Routine'
                    && t.zone === 'General'
                    && t.task_detail === detail
                    && (!storeDate || String(t.time_submitted || '').slice(0, 10) === storeDate),
                );
            }
            return [];
        },
        run(sql, ...params) {
            writes.push({ sql, params });
            if (sql.includes('INSERT OR REPLACE INTO settings')) {
                settings.set(params[0], params[1]);
            }
            if (sql.includes('UPDATE rhythm_tasks SET est_mins')) {
                const row = rhythmTasks.find((r) => String(r.id) === String(params[1]));
                if (row) row.est_mins = params[0];
            }
            if (sql.includes('UPDATE tasks SET status')) {
                const row = tasks.find((t) => t.task_id === params[2]);
                if (row) {
                    row.status = 'Closed';
                    row.time_closed = params[0];
                    row.closed_by = params[1];
                }
            }
            if (sql.includes('INSERT INTO rhythm_tasks')) {
                rhythmTasks.push({
                    id: params[0],
                    day: params[1],
                    detail: params[2],
                    priority: params[3],
                    zone: params[4],
                    est_mins: params[5],
                });
            }
        },
        upsertAudit: () => {},
        _settings: settings,
        _tasks: tasks,
        _rhythmTasks: rhythmTasks,
        _writes: writes,
    };
}

test('ackAction persists dismissals and blocks missing_finish', () => {
    const db = mockDb();
    const ack = ackAction(db, {
        action_id: 'open_tasks:2026-05-19:Open tasks',
        reportDate: '2026-05-19',
        actorName: 'Manager',
    });
    assert.ok(ack.action_id);
    const acks = loadActionAcks(db);
    assert.equal(acks.length, 1);
    assert.throws(
        () => ackAction(db, { action_id: 'missing_finish:2026-05-19:FINISH' }),
        /must be resolved on the floor/i,
    );
});

test('filterAckedReportActions hides dismissed items', () => {
    const actions = [
        { kind: 'open_tasks', title: 'Open tasks', priority: 'warn' },
        { kind: 'missing_finish', title: 'FINISH', priority: 'urgent' },
    ];
    const filtered = filterAckedReportActions(actions, [
        { action_id: 'open_tasks:2026-05-19:Open tasks' },
    ], '2026-05-19');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].kind, 'missing_finish');
    assert.equal(filtered[0].dismissible, false);
});

test('deferRhythmTasks stores deferrals and closes matching board tasks', () => {
    const db = mockDb();
    const result = deferRhythmTasks(db, {
        storeDate: '2026-05-19',
        rhythmIds: ['1'],
        actorName: 'Manager',
        serverTime: '2026-05-19T12:00:00.000Z',
    });
    assert.deepEqual(getDeferredRhythmIds(db, '2026-05-19'), ['1']);
    assert.equal(result.closed_board_tasks, 1);
    assert.equal(db._tasks[0].status, 'Closed');
    const log = JSON.parse(db._settings.get('Rhythm_Defer_Log') || '[]');
    assert.equal(log.length, 1);
    assert.equal(log[0].store_date, '2026-05-19');
    assert.equal(log[0].deferred_by, 'Manager');
});

test('deferRhythmTasks does not close carryover Routine tasks from prior days', () => {
    const db = mockDb({
        tasks: [
            { task_id: 'old', task_detail: 'Store walk', status: 'Open', priority: 'Routine', zone: 'General', time_submitted: '2026-05-18T12:00:00.000Z' },
            { task_id: 'today', task_detail: 'Store walk', status: 'Open', priority: 'Routine', zone: 'General', time_submitted: '2026-05-19T12:00:00.000Z' },
        ],
    });
    const result = deferRhythmTasks(db, {
        storeDate: '2026-05-19',
        rhythmIds: ['1'],
        actorName: 'Manager',
        serverTime: '2026-05-19T15:00:00.000Z',
    });
    assert.equal(result.closed_board_tasks, 1);
    assert.equal(db._tasks.find((t) => t.task_id === 'old').status, 'Open');
    assert.equal(db._tasks.find((t) => t.task_id === 'today').status, 'Closed');
});

test('applyRhythmEstUpdates writes est_mins to rhythm templates', () => {
    const db = mockDb();
    const result = applyRhythmEstUpdates(db, [
        { detail: 'Store walk', est_mins: 22 },
        { detail: 'FIFO Audit', est_mins: 18 },
    ], { actorName: 'Manager' });
    assert.equal(db._rhythmTasks[0].est_mins, 20);
    assert.ok(result.applied.some((r) => r.detail === 'Store walk'));
    assert.ok(result.applied.some((r) => r.detail.startsWith('FIFO Audit')));
});

test('enrichTaskPlanningSummary flags rhythm membership and add eligibility', () => {
    const db = mockDb({ rhythm_tasks: [{ id: '1', detail: 'Store walk', est_mins: 10 }] });
    const enriched = enrichTaskPlanningSummary(db, {
        sample_count: 10,
        overall: { avg_est_mins: 10, avg_actual_mins: 20, bias_mins: 10, bias_pct: 100 },
        by_type: [
            { task_type: 'Store walk', sample_count: 5, avg_est_mins: 10, avg_actual_mins: 20, bias_mins: 10, bias_pct: 100, status: 'under_estimated' },
            { task_type: 'Back stock', sample_count: 4, avg_est_mins: 10, avg_actual_mins: 35, bias_mins: 25, bias_pct: 250, status: 'under_estimated' },
            { task_type: 'PULL:*', sample_count: 6, avg_est_mins: 10, avg_actual_mins: 18, bias_mins: 8, bias_pct: 80, status: 'under_estimated' },
            { task_type: 'One-off', sample_count: 2, avg_est_mins: 10, avg_actual_mins: 30, bias_mins: 20, bias_pct: 200, status: 'under_estimated' },
        ],
    });
    const byType = Object.fromEntries(enriched.by_type.map((r) => [r.task_type, r]));
    assert.equal(byType['Store walk'].has_rhythm_template, true);
    assert.equal(byType['Store walk'].can_add_to_rhythm, false);
    assert.equal(byType['Back stock'].has_rhythm_template, false);
    assert.equal(byType['Back stock'].can_add_to_rhythm, true);
    assert.equal(byType['PULL:*'].can_add_to_rhythm, false);
    assert.equal(byType['One-off'].can_add_to_rhythm, false);
});

test('addRhythmFromPlanning inserts a new rhythm template', () => {
    const db = mockDb({ rhythm_tasks: [] });
    const created = addRhythmFromPlanning(db, {
        detail: 'Back stock',
        day: 'Wednesday',
        zone: 'General',
        priority: 'Routine',
        est_mins: 37,
        actorName: 'Manager',
    });
    assert.equal(created.detail, 'Back stock');
    assert.equal(created.day, 'Wednesday');
    assert.equal(created.est_mins, 35);
    assert.equal(db._rhythmTasks.length, 1);
});

test('addRhythmFromPlanning rejects grouped pull buckets', () => {
    const db = mockDb({ rhythm_tasks: [] });
    assert.throws(
        () => addRhythmFromPlanning(db, { detail: 'PULL:*', day: 'Everyday', est_mins: 20 }),
        /Grouped pull tasks/i,
    );
});

test('enrichReportActions uses item_key for unique dismiss IDs', () => {
    const actions = enrichReportActions([
        { kind: 'task', title: 'Urgent TASK', item_key: 'task:t1' },
        { kind: 'task', title: 'Urgent TASK', item_key: 'task:t2' },
    ], '2026-06-10');
    assert.equal(actions[0].action_id, 'task:2026-06-10:task:t1');
    assert.equal(actions[1].action_id, 'task:2026-06-10:task:t2');
    assert.notEqual(actions[0].action_id, actions[1].action_id);
});
