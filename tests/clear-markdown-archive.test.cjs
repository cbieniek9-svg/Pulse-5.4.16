'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clearMarkdownArchive } = require('../src/lib/clear-markdown-archive.cjs');

function makeDb() {
    const killDates = new Map([
        ['k1', { id: 'k1', status: 'Active' }],
        ['k2', { id: 'k2', status: 'Closed' }],
        ['k3', { id: 'k3', status: 'Deleted' }],
    ]);
    const tasks = new Map([
        ['AUTO-PULL-k1', { task_id: 'AUTO-PULL-k1', status: 'Open' }],
        ['AUTO-PULL-k2', { task_id: 'AUTO-PULL-k2', status: 'Closed' }],
        ['T-1', { task_id: 'T-1', status: 'Closed' }],
    ]);
    return {
        transaction(fn) { return () => fn(); },
        get(sql) {
            if (sql.includes('kill_dates WHERE status !=')) {
                return { c: [...killDates.values()].filter((r) => r.status !== 'Active').length };
            }
            if (sql.includes("kill_dates WHERE status='Active'")) {
                return { c: [...killDates.values()].filter((r) => r.status === 'Active').length };
            }
            if (sql.includes('AUTO-PULL-%')) {
                return { c: [...tasks.values()].filter((t) => t.task_id.startsWith('AUTO-PULL-') && t.status !== 'Open').length };
            }
            return { c: 0 };
        },
        run(sql) {
            if (sql.includes("DELETE FROM kill_dates WHERE status != 'Active'")) {
                for (const [id, row] of killDates) {
                    if (row.status !== 'Active') killDates.delete(id);
                }
            }
            if (sql.includes("DELETE FROM tasks WHERE task_id LIKE 'AUTO-PULL-%'")) {
                for (const [id, row] of tasks) {
                    if (id.startsWith('AUTO-PULL-') && row.status !== 'Open') tasks.delete(id);
                }
            }
        },
    };
}

test('clearMarkdownArchive removes non-active kill_dates and closed pull tasks', () => {
    const db = makeDb();
    const result = clearMarkdownArchive(db);
    assert.equal(result.removedKillDates, 2);
    assert.equal(result.removedPullTasks, 1);
    assert.equal(result.activeRemaining, 1);
});
