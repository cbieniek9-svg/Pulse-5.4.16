import { useState } from 'react';
import { useSettings } from '../context/SettingsContext.jsx';
import { datetimeLocalToIso, isoToDatetimeLocal } from '../lib/settingsHelpers.js';
import { saveManagerTaskTimes } from '../lib/settingsApi.js';

function AuditRow({ task, onSave }) {
    const [fields, setFields] = useState({
        time_submitted: isoToDatetimeLocal(task.time_submitted),
        start_time: isoToDatetimeLocal(task.start_time),
        time_closed: isoToDatetimeLocal(task.time_closed),
        est_mins: task.est_mins != null && task.est_mins !== '' ? String(task.est_mins) : '',
    });

    const update = (key, val) => setFields({ ...fields, [key]: val });

    return (
        <div className="audit-row mgr-card" data-task-id={task.task_id} style={{ borderLeft: '4px solid #8cf' }}>
            <div style={{ marginBottom: 8 }}>
                <strong>{task.task_id}</strong>
                {' '}
                <span style={{ opacity: 0.85 }}>{task.status}</span>
                {' · '}
                {task.zone}
            </div>
            <div style={{ opacity: 0.9, marginBottom: 10, fontSize: '0.82em', textTransform: 'none' }}>
                {(task.task_detail || '').slice(0, 160)}
                {(task.task_detail || '').length > 160 ? '…' : ''}
            </div>
            <div className="mgr-form-grid-2" style={{ fontSize: '0.78em' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: '#aac', textTransform: 'none' }}>
                    Submitted
                    <input type="datetime-local" className="st-input" value={fields.time_submitted} onChange={(e) => update('time_submitted', e.target.value)} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: '#aac', textTransform: 'none' }}>
                    Started
                    <input type="datetime-local" className="st-input" value={fields.start_time} onChange={(e) => update('start_time', e.target.value)} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: '#aac', textTransform: 'none' }}>
                    Closed
                    <input type="datetime-local" className="st-input" value={fields.time_closed} onChange={(e) => update('time_closed', e.target.value)} />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: '#aac', textTransform: 'none' }}>
                    Est (min)
                    <input type="number" min={0} max={9999} className="st-input" value={fields.est_mins} onChange={(e) => update('est_mins', e.target.value)} />
                </label>
            </div>
            <button type="button" className="st-btn" style={{ width: 'auto', marginTop: 10 }} onClick={() => onSave(task.task_id, fields)}>SAVE</button>
        </div>
    );
}

export default function TaskTimesTab() {
    const { syncData, refresh, showNotice, token } = useSettings();

    const openRows = (syncData?.tasks || []).filter((t) => t && !String(t.task_id || '').startsWith('AUTO-PULL'));
    const closedRows = syncData?.tasks_audit || [];

    const saveRow = async (taskId, fields) => {
        const payload = { task_id: taskId };
        if (fields.est_mins !== '' && fields.est_mins != null) {
            const n = parseInt(fields.est_mins, 10);
            if (!Number.isNaN(n)) payload.est_mins = n;
        }
        payload.time_submitted = datetimeLocalToIso(fields.time_submitted);
        payload.start_time = datetimeLocalToIso(fields.start_time);
        payload.time_closed = datetimeLocalToIso(fields.time_closed);

        if (Object.keys(payload).length <= 1) {
            showNotice('Change at least one time or estimate before saving.', 'info');
            return;
        }
        try {
            await saveManagerTaskTimes(payload, token);
            showNotice('Task times saved.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    return (
        <>
            <div className="mgr-section-title">TASK TIMES (AUDIT)</div>
            <p className="mgr-hint">Correct submitted, started, closed times and estimates after an audit.</p>
            <div id="task-audit-list">
                {openRows.length ? (
                    <>
                        <div style={{ color: '#0f8', fontSize: '0.78em', margin: '0 0 10px', fontWeight: 'bold' }}>OPEN TASKS</div>
                        {openRows.map((t) => <AuditRow key={t.task_id} task={t} onSave={saveRow} />)}
                    </>
                ) : null}
                {closedRows.length ? (
                    <>
                        <div style={{ color: '#8cf', fontSize: '0.78em', margin: '16px 0 10px', fontWeight: 'bold' }}>RECENT CLOSED / ARCHIVED</div>
                        {closedRows.map((t) => <AuditRow key={t.task_id} task={t} onSave={saveRow} />)}
                    </>
                ) : null}
                {!openRows.length && !closedRows.length ? (
                    <div className="mgr-card" style={{ color: '#b0b0b0' }}>No tasks in audit lists.</div>
                ) : null}
            </div>
        </>
    );
}
