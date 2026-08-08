'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ensureKillDatePullTasks, closeKillDatePullTask } = require('../src/lib/kill-date-pull.cjs');

test('ensureKillDatePullTasks creates urgent open task for due kill date', () => {
    const tasks = new Map();

    const db = {
        all: () => [{ id: 'K-1', item: 'Test Yogurt', zone: 'Dairy', kill_date: '2026-05-18' }],
        get: (_sql, taskId) => tasks.get(taskId),
        run: (_sql, ...params) => {
            if (params.length >= 8) {
                const [taskId, detail, status, priority, zone] = params;
                tasks.set(taskId, { task_id: taskId, task_detail: detail, status, priority, zone });
            } else if (params.length === 3) {
                const [closer, closedAt, taskId] = params;
                const t = tasks.get(taskId);
                if (t) tasks.set(taskId, { ...t, status: 'Closed', closed_by: closer, time_closed: closedAt });
            }
        },
    };

    ensureKillDatePullTasks(db, '2026-05-19');
    const task = tasks.get('AUTO-PULL-K-1');
    assert.ok(task);
    assert.equal(task.status, 'Open');
    assert.equal(task.priority, 'Urgent');
    assert.match(task.task_detail, /Test Yogurt/i);

    closeKillDatePullTask(db, 'K-1', 'Clerk', '2026-05-19T12:00:00.000Z');
    assert.equal(tasks.get('AUTO-PULL-K-1').status, 'Closed');
});

test('broadcastPullTaskEvents emits task insert deltas', () => {
    const taskRow = { task_id: 'AUTO-PULL-K-2', task_detail: 'PULL: Milk', status: 'Open', priority: 'Urgent', zone: 'Dairy' };
    const sent = [];
    const db = {
        get: (_sql, id) => (id === 'AUTO-PULL-K-2' ? taskRow : undefined),
    };
    const { broadcastPullTaskEvents } = require('../src/lib/kill-date-pull.cjs');
    broadcastPullTaskEvents(db, [{ action: 'insert', task_id: 'AUTO-PULL-K-2' }], (d) => sent.push(d));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].table, 'tasks');
    assert.equal(sent[0].action, 'insert');
    assert.equal(sent[0].data.task_id, 'AUTO-PULL-K-2');
});

test('AUTO-PULL task close updates both task and kill date rows', () => {
    const killId = 'K-99';
    const tasks = new Map([
        ['AUTO-PULL-K-99', { task_id: 'AUTO-PULL-K-99', related_id: killId, assigned_to: 'Unassigned', status: 'Open' }],
    ]);
    const kills = new Map([[killId, { id: killId, status: 'Active' }]]);
    const db = {
        get(sql, id) {
            if (sql.includes('FROM tasks')) return tasks.get(id) ? { ...tasks.get(id) } : null;
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE kill_dates')) {
                const id = params[2];
                const row = kills.get(id);
                if (row) kills.set(id, { ...row, status: 'Closed' });
            }
            if (sql.includes('UPDATE tasks SET status')) {
                const id = params[2];
                const row = tasks.get(id);
                if (row) tasks.set(id, { ...row, status: 'Closed', closed_by: params[0] });
            }
        },
        transaction(fn) {
            return () => fn();
        },
    };
    const { createActionHandlers } = require('../src/actions/handlers.cjs');
    const handlers = createActionHandlers({ db, broadcastUpdate: () => {}, getStoreDateStamp: () => '2026-05-19' });
    handlers.tasks_update({
        id_val: 'AUTO-PULL-K-99',
        workingData: { status: 'Closed' },
        actorName: 'Clerk',
        serverTime: '2026-05-19T12:00:00.000Z',
    });
    assert.equal(tasks.get('AUTO-PULL-K-99').status, 'Closed');
    assert.equal(kills.get(killId).status, 'Closed');
});
