import { memo, useCallback, useMemo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorRole } from '../../hooks/useFloorRole.js';
import { useFloorUi } from '../shared/NoticeProvider.jsx';

function priorityClass(priority) {
    if (priority === 'Urgent') return 'data-urgent';
    if (priority === 'High') return 'data-high';
    return '';
}

function TaskListInner() {
    const { syncData, postAction } = useSync();
    const { canManageTasks, canCompleteTasks } = useFloorRole();
    const { actions, showNotice } = useFloorUi();
    const tasks = syncData?.tasks || [];

    const assignees = useMemo(() => {
        const activeNames = (syncData?.staff || []).filter((s) => s.active === 1 && s.name !== 'Unassigned').map((s) => s.name);
        const base = ['Unassigned', 'All Staff', ...activeNames];
        const known = new Set(base);
        for (const t of tasks) {
            const name = String(t.assigned_to || '').trim();
            if (name && !known.has(name)) {
                known.add(name);
                base.push(name);
            }
        }
        return base;
    }, [syncData?.staff, tasks]);

    const handleDone = useCallback(async (taskId, zone, btn) => {
        if (!taskId) return;
        btn.disabled = true;
        btn.style.opacity = '0.5';
        try {
            await postAction({
                table: 'tasks',
                action: 'update',
                data: { status: 'Closed', zone },
                id_col: 'task_id',
                id_val: taskId,
            });
        } catch (err) {
            console.error('[TASK]', err.message);
        } finally {
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    }, [postAction]);

    const handleAssign = useCallback(async (taskId, assignee) => {
        try {
            await actions.assignTask(taskId, assignee);
        } catch (e) {
            showNotice(e.message, 'error');
        }
    }, [actions, showNotice]);

    const handleDelete = useCallback(async (taskId) => {
        try {
            await actions.deleteTask(taskId);
        } catch (e) {
            showNotice(e.message, 'error');
        }
    }, [actions, showNotice]);

    if (!tasks.length) {
        return <div style={{ color: '#b0b0b0', textAlign: 'center', padding: '20px' }}>NO OPEN TASKS</div>;
    }

    return (
        <>
            {tasks.map((t) => (
                <div key={t.task_id} className={`data-card ${priorityClass(t.priority)}`}>
                    <div style={{ flex: 1 }}>
                        <span>[{t.zone}] {t.task_detail}</span>
                    </div>
                    <div className="card-meta">
                        {canManageTasks ? (
                            <select
                                className="st-input task-assignee-select"
                                aria-label={`Assign task ${t.task_detail || t.task_id}`}
                                value={t.assigned_to || 'Unassigned'}
                                onChange={(e) => handleAssign(t.task_id, e.target.value)}
                            >
                                {assignees.map((n) => (
                                    <option key={n} value={n}>{n}</option>
                                ))}
                            </select>
                        ) : (
                            <span className="task-assignee-name">{t.assigned_to || 'Unassigned'}</span>
                        )}
                        <br />
                        {canCompleteTasks ? (
                            <button
                                type="button"
                                className="done-btn"
                                data-task-id={t.task_id}
                                data-zone={t.zone}
                                onClick={(ev) => handleDone(t.task_id, t.zone, ev.currentTarget)}
                            >
                                DONE
                            </button>
                        ) : null}
                        {canManageTasks ? (
                            <button
                                type="button"
                                className="done-btn"
                                style={{ borderColor: '#f33', color: '#f33', marginTop: 4 }}
                                onClick={() => handleDelete(t.task_id)}
                            >
                                DEL
                            </button>
                        ) : null}
                    </div>
                </div>
            ))}
        </>
    );
}

const TaskList = memo(TaskListInner);
export default TaskList;
