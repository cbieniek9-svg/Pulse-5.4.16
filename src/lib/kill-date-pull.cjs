'use strict';

const { suggestEstMinutes } = require('./task-estimates.cjs');

/**
 * Persist urgent PULL tasks for active kill dates at or past store today.
 * @param {object} db
 * @param {string} today — YYYY-MM-DD store date
 * @returns {Array<{ action: 'insert'|'update', task_id: string }>}
 */
function ensureKillDatePullTasks(db, today) {
    const events = [];
    const due = db.all(
        `SELECT id, item, zone, kill_date FROM kill_dates WHERE status='Active' AND kill_date<=?`,
        today,
    );
    for (const k of due) {
        const taskId = `AUTO-PULL-${k.id}`;
        const row = db.get('SELECT status FROM tasks WHERE task_id = ?', taskId);
        if (!row) {
            db.run(
                `INSERT INTO tasks (task_id, task_detail, status, priority, zone, assigned_to, est_mins, time_submitted, related_id)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
                taskId,
                `PULL: ${k.item}`,
                'Open',
                'Urgent',
                k.zone || 'General',
                'Unassigned',
                suggestEstMinutes(db, { detail: `PULL: ${k.item}`, fallback: 15 }),
                `${k.kill_date}T12:00:00.000Z`,
                k.id,
            );
            events.push({ action: 'insert', task_id: taskId });
        } else if (row.status === 'Archived') {
            db.run(
                `UPDATE tasks SET status='Open', priority='Urgent', closed_by='', time_closed=NULL,
                 task_detail=?, zone=?, related_id=? WHERE task_id=?`,
                `PULL: ${k.item}`,
                k.zone || 'General',
                k.id,
                taskId,
            );
            events.push({ action: 'update', task_id: taskId });
        }
    }
    return events;
}

/**
 * Push SSE deltas for newly created or reopened AUTO-PULL tasks.
 * @param {object} db
 * @param {Array<{ action: string, task_id: string }>} events
 * @param {function} broadcastUpdate
 */
function broadcastPullTaskEvents(db, events, broadcastUpdate) {
    if (!events?.length || typeof broadcastUpdate !== 'function') return;
    for (const ev of events) {
        const task = db.get('SELECT * FROM tasks WHERE task_id = ?', ev.task_id);
        if (!task) continue;
        if (ev.action === 'insert') {
            broadcastUpdate({ table: 'tasks', action: 'insert', data: task });
        } else {
            broadcastUpdate({
                table: 'tasks',
                action: 'update',
                id_col: 'task_id',
                id_val: ev.task_id,
                data: task,
            });
        }
    }
}

/**
 * @param {object} db
 * @param {string} killDateId
 * @param {string} closer
 * @param {string} serverTime — ISO
 */
function resolveKillDateIdFromPullTask(db, taskId) {
    const task = db.get('SELECT related_id FROM tasks WHERE task_id = ?', taskId);
    if (task?.related_id) return task.related_id;
    if (String(taskId).startsWith('AUTO-PULL-')) return String(taskId).slice('AUTO-PULL-'.length);
    return null;
}

function closeKillDatePullTask(db, killDateId, closer, serverTime) {
    const taskId = `AUTO-PULL-${killDateId}`;
    db.run(
        `UPDATE tasks SET status='Closed', closed_by=?, time_closed=? WHERE task_id=? AND status='Open'`,
        closer,
        serverTime,
        taskId,
    );
}

/**
 * Close linked kill date + AUTO-PULL task together (idempotent on kill date).
 */
function closePullWorkflow(db, killDateId, closer, serverTime) {
    if (!killDateId) return;
    db.run(
        `UPDATE kill_dates SET status='Closed', closed_by=?, time_closed=? WHERE id=? AND status='Active'`,
        closer,
        serverTime,
        killDateId,
    );
    closeKillDatePullTask(db, killDateId, closer, serverTime);
}

module.exports = {
    ensureKillDatePullTasks,
    broadcastPullTaskEvents,
    closeKillDatePullTask,
    closePullWorkflow,
    resolveKillDateIdFromPullTask,
};
