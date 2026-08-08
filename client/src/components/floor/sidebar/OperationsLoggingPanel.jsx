import { useState } from 'react';
import { TASK_ZONES, OOS_ZONES } from '../../../lib/floorUtils.js';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';

export default function OperationsLoggingPanel() {
    const { actions, showNotice } = useFloorUi();
    const [desc, setDesc] = useState('');
    const [priority, setPriority] = useState('Routine');
    const [zone, setZone] = useState('General');
    const [oosZone, setOosZone] = useState('A1');
    const [oosCount, setOosCount] = useState('1');
    const [oosNotes, setOosNotes] = useState('');

    const deployTask = async () => {
        try {
            const ok = await actions.manualTask({ desc, priority, zone });
            if (!ok) return;
            setDesc('');
            showNotice('Task deployed', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const logOos = async () => {
        try {
            await actions.logOos({ zone: oosZone, count: oosCount, notes: oosNotes });
            setOosNotes('');
            showNotice('OOS logged', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    return (
        <>
            <details className="st-expander" style={{ border: 'none', background: 'none', marginBottom: 15 }}>
                <summary style={{ color: '#8cf', fontSize: '0.85em', cursor: 'pointer', marginBottom: 10 }}>
                    ➕ MANUAL TASK OVERRIDE
                </summary>
                <input className="st-input" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Task Description" />
                <select className="st-input" value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option>Routine</option>
                    <option>High</option>
                    <option>Urgent</option>
                </select>
                <select className="st-input" value={zone} onChange={(e) => setZone(e.target.value)}>
                    {TASK_ZONES.map((z) => <option key={z}>{z}</option>)}
                </select>
                <button type="button" className="st-btn" onClick={deployTask}>DEPLOY TASK</button>
            </details>

            <details className="st-expander" style={{ border: 'none', background: 'none' }}>
                <summary style={{ color: '#8cf', fontSize: '0.85em', cursor: 'pointer', marginBottom: 10 }}>
                    🕳️ LOG SHELF HOLES (OOS)
                </summary>
                <div style={{ display: 'flex', gap: 5, marginBottom: 5 }}>
                    <select className="st-input" style={{ flex: 2 }} value={oosZone} onChange={(e) => setOosZone(e.target.value)}>
                        {OOS_ZONES.map((z) => <option key={z}>{z}</option>)}
                    </select>
                    <input className="st-input" type="number" value={oosCount} onChange={(e) => setOosCount(e.target.value)} style={{ flex: 1 }} />
                </div>
                <input className="st-input" value={oosNotes} onChange={(e) => setOosNotes(e.target.value)} placeholder="Notes (Optional)" />
                <button type="button" className="st-btn" style={{ borderColor: '#f33', color: '#f33' }} onClick={logOos}>LOG OOS</button>
            </details>
        </>
    );
}
