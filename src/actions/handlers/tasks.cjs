'use strict';

const {
    closePullWorkflow, resolveKillDateIdFromPullTask,
} = require('../../lib/kill-date-pull.cjs');
const { suggestEstMinutes, refreshLearnedEstimate } = require('../../lib/task-estimates.cjs');
const { writeReceivingStat } = require('../../lib/receiving-flow.cjs');
const { isTaskWorkTimingEnabled } = require('../../lib/task-work-timing.cjs');

/**
 * tasks action handlers for POST /api/action.
 * @param {object} deps
 */
function createTasksHandlers({ db, broadcastUpdate, getStoreDateStamp, actionHandlers }) {
    return {
        tasks_insert(ctx) {
            if (ctx.workingData.est_mins == null || ctx.workingData.est_mins === '') {
                ctx.workingData.est_mins = suggestEstMinutes(db, {
                    detail: ctx.workingData.task_detail,
                    fallback: 15,
                });
            }
            actionHandlers.generic_insert(ctx);
        },

        tasks_delete(ctx) {
            if (String(ctx.id_val).startsWith('AUTO-PULL-')) {
                const killDateId = ctx.id_val.replace('AUTO-PULL-', '');
                db.run(
                    'UPDATE kill_dates SET status = ?, closed_by = ?, time_closed = ? WHERE id = ?',
                    'Deleted', ctx.actorName, ctx.serverTime, killDateId
                );
                broadcastUpdate({ table: 'tasks', action: 'delete', id_col: 'task_id', id_val: ctx.id_val });
                broadcastUpdate({ table: 'kill_dates', action: 'update', id_col: 'id', id_val: killDateId, data: { status: 'Deleted', closed_by: ctx.actorName, time_closed: ctx.serverTime } });
                return;
            }
            actionHandlers.generic_delete(ctx);
        },

        tasks_update(ctx) {
            if (String(ctx.id_val).startsWith('AUTO-PULL-')) {
                if (ctx.workingData.status === 'Closed') {
                    const killDateId = resolveKillDateIdFromPullTask(db, ctx.id_val);
                    const trow = db.get('SELECT assigned_to FROM tasks WHERE task_id = ?', ctx.id_val);
                    const closer = (trow?.assigned_to && trow.assigned_to !== 'Unassigned') ? trow.assigned_to : ctx.actorName;
                    db.transaction(() => {
                        closePullWorkflow(db, killDateId, closer, ctx.serverTime);
                    })();
                    broadcastUpdate({
                        table: 'tasks', action: 'update', id_col: 'task_id', id_val: ctx.id_val,
                        data: { status: 'Closed', closed_by: closer, time_closed: ctx.serverTime },
                    });
                    if (killDateId) {
                        broadcastUpdate({
                            table: 'kill_dates', action: 'update', id_col: 'id', id_val: killDateId,
                            data: { status: 'Closed', closed_by: closer, time_closed: ctx.serverTime },
                        });
                    }
                    try {
                        const { syncMustWinsWithOpenBoard } = require('../../lib/daily-direction.cjs');
                        const synced = syncMustWinsWithOpenBoard(db, getStoreDateStamp(), {
                            settings: db.getSettings ? db.getSettings() : {},
                            actorName: closer || ctx.actorName || 'system',
                        });
                        if (synced?.changed) {
                            broadcastUpdate({ table: 'daily_direction', action: 'must_wins_sync' });
                        }
                    } catch (_) { /* non-fatal */ }
                } else {
                    actionHandlers.generic_update(ctx);
                }
                return;
            }

            // Work timing (start_time + learned estimates) is off by default — unreliable on floor.
            const timingOn = isTaskWorkTimingEnabled(db.getSettings ? db.getSettings() : {});
            const assignee = ctx.workingData.assigned_to;
            if (timingOn && assignee && assignee !== 'Unassigned' && ctx.workingData.start_time == null) {
                const cur = db.get('SELECT start_time FROM tasks WHERE task_id = ?', ctx.id_val);
                if (cur && (cur.start_time == null || cur.start_time === '')) {
                    ctx.workingData.start_time = ctx.serverTime || new Date().toISOString();
                }
            }

            actionHandlers.generic_update(ctx);
            if (timingOn && (ctx.workingData.status === 'Closed' || ctx.workingData.status === 'Archived')) {
                const closedTask = db.get('SELECT * FROM tasks WHERE task_id = ?', ctx.id_val);
                refreshLearnedEstimate(db, closedTask);
            }
            if (ctx.workingData.status === 'Closed') {
                const task = db.get('SELECT * FROM tasks WHERE task_id = ?', ctx.id_val);
                if (task?.related_id) {
                    const order = db.get('SELECT * FROM expected_orders WHERE exp_id = ?', task.related_id);
                    if (order?.departed_at) {
                        // still sync must-wins below
                    } else {
                        const arrivalTime = order?.arrived_at || task.start_time;
                        if (arrivalTime) {
                            writeReceivingStat(
                                db,
                                order || { exp_id: task.related_id, vendor: task.task_detail.replace('Work ', '').replace(' Order', '') },
                                arrivalTime,
                                ctx.serverTime,
                                ctx.actorName,
                            );
                        }
                    }
                }
                try {
                    const { syncMustWinsWithOpenBoard } = require('../../lib/daily-direction.cjs');
                    const synced = syncMustWinsWithOpenBoard(db, getStoreDateStamp(), {
                        settings: db.getSettings ? db.getSettings() : {},
                        actorName: ctx.actorName || 'system',
                    });
                    if (synced?.changed) {
                        broadcastUpdate({ table: 'daily_direction', action: 'must_wins_sync' });
                    }
                } catch (_) { /* non-fatal */ }
            }
        },
    };
}

module.exports = { createTasksHandlers };
