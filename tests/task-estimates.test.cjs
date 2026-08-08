const test = require('node:test');
const assert = require('node:assert/strict');
const {
    computeActualMinutes,
    roundEstMinutes,
    suggestEstMinutes,
    refreshLearnedEstimate,
    taskDetailKey,
} = require('../src/lib/task-estimates.cjs');

function makeDb(rows = [], { timingEnabled = true } = {}) {
    return {
        getSettings: () => ({ Task_Work_Timing_Enabled: timingEnabled ? '1' : '0' }),
        get(sql, ...params) {
            if (sql.includes('FROM rhythm_tasks')) {
                const detail = params[0];
                const r = rows.find((x) => x.type === 'rhythm' && x.detail === detail);
                return r ? { est_mins: r.est_mins } : undefined;
            }
            if (sql.includes('AVG(actual_mins)')) {
                const detail = sql.includes("LIKE 'PULL:%'") ? 'PULL:*'
                    : sql.includes("LIKE 'FIFO Audit%'") ? 'FIFO Audit'
                    : params[0];
                const matches = rows.filter((x) => {
                    if (x.type !== 'task' || !x.time_closed) return false;
                    if (x.closed_by === 'AUTO') return false;
                    if (detail === 'PULL:*') return String(x.task_detail).startsWith('PULL:');
                    if (detail === 'FIFO Audit') return String(x.task_detail).startsWith('FIFO Audit');
                    return x.task_detail === detail;
                });
                if (!matches.length) return { avg_mins: 0, sample_count: 0 };
                const avg = matches.reduce((s, r) => s + r.actual_mins, 0) / matches.length;
                return { avg_mins: avg, sample_count: matches.length };
            }
            return undefined;
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE rhythm_tasks')) {
                const [est, detail] = params;
                const row = rows.find((x) => x.type === 'rhythm' && x.detail === detail);
                if (row) row.est_mins = est;
            }
        },
    };
}

test('taskDetailKey groups pull lines', () => {
    assert.equal(taskDetailKey('FIFO Audit'), 'FIFO Audit');
    assert.equal(taskDetailKey('FIFO Audit — A1'), 'FIFO Audit');
    assert.equal(taskDetailKey('PULL: Milk'), 'PULL:*');
});

test('computeActualMinutes measures from start_time to close', () => {
    const mins = computeActualMinutes({
        start_time: '2026-05-20T14:00:00.000Z',
        time_closed: '2026-05-20T14:22:00.000Z',
    });
    assert.equal(mins, 22);
});

test('computeActualMinutes returns null without a real start_time (no skew from load time)', () => {
    // Rhythm task created at 06:00, closed at 09:10 but only worked briefly:
    // without a start signal we must NOT treat load->close as the duration.
    const mins = computeActualMinutes({
        time_submitted: '2026-05-20T06:00:00.000Z',
        time_closed: '2026-05-20T09:10:00.000Z',
    });
    assert.equal(mins, null);
});

test('roundEstMinutes snaps to five minute buckets', () => {
    assert.equal(roundEstMinutes(22.4), 20);
    assert.equal(roundEstMinutes(23.1), 25);
});

test('suggestEstMinutes uses learned average after three samples', () => {
    const db = makeDb([
        { type: 'task', task_detail: 'FIFO Audit', actual_mins: 20, time_closed: '1' },
        { type: 'task', task_detail: 'FIFO Audit', actual_mins: 25, time_closed: '1' },
        { type: 'task', task_detail: 'FIFO Audit', actual_mins: 30, time_closed: '1' },
    ]);
    assert.equal(suggestEstMinutes(db, { detail: 'FIFO Audit', fallback: 15 }), 25);
});

test('suggestEstMinutes falls back to rhythm template before default', () => {
    const db = makeDb([
        { type: 'rhythm', detail: 'Store walk', est_mins: 35 },
    ]);
    assert.equal(suggestEstMinutes(db, { detail: 'Store walk', fallback: 15 }), 35);
});

test('suggestEstMinutes ignores AUTO-closed samples', () => {
    const db = makeDb([
        { type: 'task', task_detail: 'Store walk', actual_mins: 5, time_closed: '1', closed_by: 'AUTO' },
        { type: 'task', task_detail: 'Store walk', actual_mins: 5, time_closed: '1', closed_by: 'AUTO' },
        { type: 'task', task_detail: 'Store walk', actual_mins: 5, time_closed: '1', closed_by: 'AUTO' },
        { type: 'rhythm', detail: 'Store walk', est_mins: 20 },
    ]);
    assert.equal(suggestEstMinutes(db, { detail: 'Store walk', fallback: 15 }), 20);
});

test('refreshLearnedEstimate skips AUTO-closed task', () => {
    const rows = [
        { type: 'rhythm', detail: 'Store walk', est_mins: 15 },
    ];
    const db = makeDb(rows);
    const result = refreshLearnedEstimate(db, {
        task_detail: 'Store walk',
        closed_by: 'AUTO',
        time_submitted: '2026-05-20T14:00:00.000Z',
        time_closed: '2026-05-20T14:10:00.000Z',
    });
    assert.equal(result, null);
});

test('refreshLearnedEstimate updates rhythm_tasks when enough history exists', () => {
    const rows = [
        { type: 'rhythm', detail: 'Daily direction huddle', est_mins: 15 },
        { type: 'task', task_detail: 'Daily direction huddle', actual_mins: 8, time_closed: '1' },
        { type: 'task', task_detail: 'Daily direction huddle', actual_mins: 10, time_closed: '1' },
        { type: 'task', task_detail: 'Daily direction huddle', actual_mins: 12, time_closed: '1' },
    ];
    const db = makeDb(rows);
    const result = refreshLearnedEstimate(db, {
        task_detail: 'Daily direction huddle',
        start_time: '2026-05-20T14:00:00.000Z',
        time_closed: '2026-05-20T14:10:00.000Z',
    });
    assert.equal(result.est_mins, 10);
    assert.equal(rows.find((r) => r.type === 'rhythm').est_mins, 10);
});

test('refreshLearnedEstimate skips a task with no start_time (avoids load-time skew)', () => {
    const rows = [
        { type: 'rhythm', detail: 'Daily direction huddle', est_mins: 15 },
        { type: 'task', task_detail: 'Daily direction huddle', actual_mins: 8, time_closed: '1' },
        { type: 'task', task_detail: 'Daily direction huddle', actual_mins: 10, time_closed: '1' },
        { type: 'task', task_detail: 'Daily direction huddle', actual_mins: 12, time_closed: '1' },
    ];
    const db = makeDb(rows);
    const result = refreshLearnedEstimate(db, {
        task_detail: 'Daily direction huddle',
        time_submitted: '2026-05-20T06:00:00.000Z',
        time_closed: '2026-05-20T09:10:00.000Z',
    });
    assert.equal(result, null);
    assert.equal(rows.find((r) => r.type === 'rhythm').est_mins, 15);
});
