import { useMemo, useState } from 'react';
import { resolveUrl } from '../lib/api.js';
import { datetimeLocalToIso, isoToDatetimeLocal } from './recUtils.js';

/** Split ISO → { date: YYYY-MM-DD, time: HH:mm } for separate inputs (avoids flaky datetime-local in Electron). */
function splitIso(iso) {
    const local = isoToDatetimeLocal(iso);
    if (!local || !local.includes('T')) return { date: '', time: '' };
    const [date, time] = local.split('T');
    return { date: date || '', time: (time || '').slice(0, 5) };
}

function joinLocal(date, time) {
    const d = String(date || '').trim();
    const t = String(time || '').trim();
    if (!d || !t) return '';
    return `${d}T${t}`;
}

export default function TimeEditPanel({ entry, token, showDeparted = true, showInvoice = true, onSaved }) {
    const initialIn = splitIso(entry.arrived_at);
    const initialOut = splitIso(entry.departed_at);
    const initialInvoice = entry.invoice_ref || '';
    const [arrivedDate, setArrivedDate] = useState(initialIn.date);
    const [arrivedTime, setArrivedTime] = useState(initialIn.time);
    const [departedDate, setDepartedDate] = useState(initialOut.date);
    const [departedTime, setDepartedTime] = useState(initialOut.time);
    const [invoice, setInvoice] = useState(initialInvoice);
    const [busy, setBusy] = useState(false);
    const [savedMsg, setSavedMsg] = useState('');

    const dirty = useMemo(() => {
        if (arrivedDate !== initialIn.date || arrivedTime !== initialIn.time) return true;
        if (showDeparted && (departedDate !== initialOut.date || departedTime !== initialOut.time)) return true;
        if (showInvoice && String(invoice || '') !== String(initialInvoice || '')) return true;
        return false;
    }, [
        arrivedDate, arrivedTime, departedDate, departedTime, invoice,
        initialIn.date, initialIn.time, initialOut.date, initialOut.time,
        initialInvoice, showDeparted, showInvoice,
    ]);

    const save = async () => {
        if (!token) return alert('Session expired — refresh /rec and sign in again.');
        if (!dirty) {
            setSavedMsg('No changes.');
            return;
        }
        const arrivedLocal = joinLocal(arrivedDate, arrivedTime);
        if (!arrivedLocal) return alert('Time in date and time are required.');
        const arrived_at = datetimeLocalToIso(arrivedLocal);
        if (!arrived_at) return alert('Invalid time in.');

        let departed_at;
        if (showDeparted) {
            const hasOut = !!(departedDate || departedTime);
            if (hasOut && (!departedDate || !departedTime)) {
                return alert('Time out needs both date and time (or clear both).');
            }
            const departedLocal = hasOut ? joinLocal(departedDate, departedTime) : '';
            departed_at = departedLocal ? datetimeLocalToIso(departedLocal) : '';
            if (departedLocal && !departed_at) return alert('Invalid time out.');
            if (departed_at && Date.parse(departed_at) < Date.parse(arrived_at)) {
                return alert('Time out must be on or after time in.');
            }
        }

        setBusy(true);
        setSavedMsg('');
        try {
            const body = { exp_id: entry.exp_id, arrived_at, token };
            if (showDeparted) {
                body.departed_at = departed_at;
                if (showInvoice) body.invoice_ref = invoice;
            }
            const res = await fetch(resolveUrl('/api/receiving-log-correction'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token || '' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not save times');
            setSavedMsg('Saved.');
            await onSaved?.();
        } catch (e) {
            alert(e.message || 'Could not save times');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="time-edit" data-time-edit-exp={entry.exp_id}>
            <div className="time-edit-grid">
                <div>
                    <label>TIME IN</label>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <input className="input" type="date" value={arrivedDate} onChange={(e) => setArrivedDate(e.target.value)} style={{ margin: 0, flex: 1.2 }} />
                        <input className="input" type="time" value={arrivedTime} onChange={(e) => setArrivedTime(e.target.value)} style={{ margin: 0, flex: 1 }} />
                    </div>
                </div>
                {showDeparted ? (
                    <div>
                        <label>TIME OUT</label>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <input className="input" type="date" value={departedDate} onChange={(e) => setDepartedDate(e.target.value)} style={{ margin: 0, flex: 1.2 }} />
                            <input className="input" type="time" value={departedTime} onChange={(e) => setDepartedTime(e.target.value)} style={{ margin: 0, flex: 1 }} />
                        </div>
                    </div>
                ) : null}
                {showInvoice ? (
                    <div>
                        <label>INVOICE / REF #</label>
                        <input className="input" type="text" maxLength={120} placeholder="Optional" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
                    </div>
                ) : null}
            </div>
            <div className="card-actions">
                <button type="button" className="btn btn-secondary btn-small" disabled={busy || !dirty} onClick={save}>
                    {busy ? 'SAVING…' : 'SAVE TIMES'}
                </button>
                {savedMsg ? <span className="hint" style={{ marginLeft: 8, color: '#8f8' }}>{savedMsg}</span> : null}
            </div>
        </div>
    );
}
