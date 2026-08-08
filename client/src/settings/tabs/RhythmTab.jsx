import { useState } from 'react';
import { useSettings } from '../context/SettingsContext.jsx';
import {
    RHYTHM_DAYS, RHYTHM_ASSIGN_BUCKET_OPTIONS, ZONES,
    genId, sortRhythmTasks,
} from '../lib/settingsHelpers.js';
import { loadDailyRhythm } from '../lib/settingsApi.js';

const PRIORITIES = ['Routine', 'High', 'Urgent'];
const RHYTHM_DAY_OPTIONS = RHYTHM_DAYS;

function RhythmRow({ row, onSave, onDelete }) {
    const [draft, setDraft] = useState({
        day: row.day,
        detail: row.detail,
        zone: row.zone,
        priority: row.priority,
        est_mins: row.est_mins || 15,
        assign_bucket: row.assign_bucket || '',
    });

    return (
        <tr data-rhythm-id={row.id}>
            <td>
                <select className="st-input" aria-label="Day" value={draft.day} onChange={(e) => setDraft({ ...draft, day: e.target.value })}>
                    {RHYTHM_DAY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
            </td>
            <td>
                <input className="st-input" aria-label="Task detail" value={draft.detail} style={{ minWidth: 180 }} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} />
            </td>
            <td>
                <select className="st-input" aria-label="Zone" value={draft.zone} onChange={(e) => setDraft({ ...draft, zone: e.target.value })}>
                    {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
            </td>
            <td>
                <select className="st-input" aria-label="Priority" value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
            </td>
            <td>
                <input className="st-input" type="number" min={1} max={999} aria-label="Estimated minutes" value={draft.est_mins} style={{ width: 70 }} onChange={(e) => setDraft({ ...draft, est_mins: parseInt(e.target.value, 10) || 15 })} />
            </td>
            <td>
                <select className="st-input" aria-label="Assign to" value={draft.assign_bucket} onChange={(e) => setDraft({ ...draft, assign_bucket: e.target.value })}>
                    {RHYTHM_ASSIGN_BUCKET_OPTIONS.map((opt) => (
                        <option key={opt.value || 'auto'} value={opt.value}>{opt.label}</option>
                    ))}
                </select>
            </td>
            <td className="mgr-row-actions">
                <button type="button" className="st-btn" onClick={() => onSave(row.id, draft)}>SAVE</button>
                <button type="button" className="st-btn" style={{ borderColor: '#f33', color: '#f33' }} onClick={() => onDelete(row.id)}>DEL</button>
            </td>
        </tr>
    );
}

export default function RhythmTab() {
    const {
        syncData, action, refresh, showNotice, appConfirm, token,
    } = useSettings();
    const [newTask, setNewTask] = useState({
        day: 'Monday',
        zone: 'General',
        priority: 'Routine',
        est_mins: 15,
        assign_bucket: '',
        detail: '',
    });

    const tasks = sortRhythmTasks(syncData?.rhythm_tasks);

    const addTask = async () => {
        const detail = newTask.detail.trim();
        if (!detail) {
            showNotice('Task detail is required.', 'error');
            return;
        }
        try {
            await action('rhythm_tasks', 'insert', {
                id: genId('R'),
                day: newTask.day,
                detail,
                zone: newTask.zone,
                priority: newTask.priority,
                est_mins: newTask.est_mins,
                assign_bucket: newTask.assign_bucket,
            });
            setNewTask({ ...newTask, detail: '', assign_bucket: '' });
            showNotice('Rhythm task added.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const saveRow = async (id, draft) => {
        if (!draft.detail.trim()) {
            showNotice('Task detail is required.', 'error');
            return;
        }
        try {
            await action('rhythm_tasks', 'update', {
                day: draft.day,
                detail: draft.detail.trim(),
                zone: draft.zone,
                priority: draft.priority,
                est_mins: draft.est_mins,
                assign_bucket: draft.assign_bucket,
            }, 'id', id);
            await refresh();
            showNotice('Rhythm task saved.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const deleteRow = async (id) => {
        if (!(await appConfirm('Delete this rhythm task?'))) return;
        try {
            await action('rhythm_tasks', 'delete', {}, 'id', id);
            showNotice('Rhythm task deleted.', 'success');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const loadRhythm = async () => {
        if (!(await appConfirm("Load today's schedule onto the board?"))) return;
        try {
            let res = await loadDailyRhythm(token);
            if (res.alreadyLoaded && !res.success) {
                if (await appConfirm('Schedule already marked loaded. Force add any missing rhythm tasks?')) {
                    res = await loadDailyRhythm(token, true);
                }
            }
            if (res.inserted === false && res.reason) showNotice(res.reason, 'info');
            else if (res.success) {
                const n = res.tasks || 0;
                const top = res.toppedUp ? ' (top-up)' : '';
                showNotice(n ? `Schedule loaded — ${n} task${n === 1 ? '' : 's'}${top}` : 'Nothing scheduled for today', n ? 'success' : 'info');
            } else if (res.skipped) showNotice(res.reason || 'Schedule already on board', 'info');
            else if (res.alreadyLoaded) showNotice(`Schedule already loaded (${res.openTasks || 0} open tasks)`, 'info');
            else if (res.error) showNotice(res.error, 'error');
            await refresh();
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const tableBusy = syncData == null;

    return (
        <>
            <div className="mgr-section-title">DAILY RHYTHM TEMPLATE</div>
            <p className="mgr-hint">
                These tasks load onto the board when you run <strong>Load Daily Rhythm</strong>.
                Set <strong>Assign to</strong> to pin a task to a schedule tag.
            </p>
            <div className="mgr-card">
                <div className="mgr-section-title" style={{ border: 'none', marginBottom: 12, fontSize: '0.72rem' }}>ADD NEW TASK</div>
                <div className="mgr-form-grid">
                    <div>
                        <label className="mgr-field-label" htmlFor="rhythm-new-day">DAY</label>
                        <select id="rhythm-new-day" className="st-input" value={newTask.day} onChange={(e) => setNewTask({ ...newTask, day: e.target.value })}>
                            {RHYTHM_DAY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="mgr-field-label" htmlFor="rhythm-new-zone">ZONE</label>
                        <select id="rhythm-new-zone" className="st-input" value={newTask.zone} onChange={(e) => setNewTask({ ...newTask, zone: e.target.value })}>
                            {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="mgr-field-label" htmlFor="rhythm-new-priority">PRIORITY</label>
                        <select id="rhythm-new-priority" className="st-input" value={newTask.priority} onChange={(e) => setNewTask({ ...newTask, priority: e.target.value })}>
                            {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="mgr-field-label" htmlFor="rhythm-new-mins">EST MINS</label>
                        <input id="rhythm-new-mins" className="st-input" type="number" min={1} max={999} value={newTask.est_mins} onChange={(e) => setNewTask({ ...newTask, est_mins: parseInt(e.target.value, 10) || 15 })} />
                    </div>
                    <div>
                        <label className="mgr-field-label" htmlFor="rhythm-new-assign">ASSIGN TO</label>
                        <select id="rhythm-new-assign" className="st-input" value={newTask.assign_bucket} onChange={(e) => setNewTask({ ...newTask, assign_bucket: e.target.value })}>
                            {RHYTHM_ASSIGN_BUCKET_OPTIONS.map((opt) => (
                                <option key={opt.value || 'auto'} value={opt.value}>{opt.label}</option>
                            ))}
                        </select>
                    </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                    <label className="mgr-field-label" htmlFor="rhythm-new-detail">TASK DETAIL</label>
                    <input id="rhythm-new-detail" className="st-input" placeholder="e.g. FIFO Audit A3" value={newTask.detail} onChange={(e) => setNewTask({ ...newTask, detail: e.target.value })} />
                </div>
                <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 20px', borderColor: 'var(--ok)', color: 'var(--ok)' }} onClick={addTask}>➕ ADD RHYTHM TASK</button>
                <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '8px 20px', marginLeft: 8 }} onClick={loadRhythm}>⚡ LOAD TODAY&apos;S SCHEDULE</button>
            </div>
            <div className="mgr-table-wrap" aria-busy={tableBusy || undefined}>
                <table className="mgr-table">
                    <thead>
                        <tr>
                            <th scope="col">DAY</th>
                            <th scope="col">DETAIL</th>
                            <th scope="col">ZONE</th>
                            <th scope="col">PRIORITY</th>
                            <th scope="col">EST</th>
                            <th scope="col">ASSIGN TO</th>
                            <th scope="col">ACTIONS</th>
                        </tr>
                    </thead>
                    <tbody>
                        {tableBusy ? (
                            <tr>
                                <td colSpan={7} style={{ color: '#8cf', textAlign: 'center', padding: 24 }}>
                                    Loading rhythm tasks…
                                </td>
                            </tr>
                        ) : tasks.length ? tasks.map((r) => (
                            <RhythmRow key={r.id} row={r} onSave={saveRow} onDelete={deleteRow} />
                        )) : (
                            <tr>
                                <td colSpan={7} style={{ color: '#b0b0b0', textAlign: 'center', padding: 24 }}>
                                    No rhythm tasks yet — add one above.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>
        </>
    );
}
