import { useState } from 'react';
import { resolveUrl } from '../lib/api.js';
import {
    deptLabel,
    deptRequiresTemp,
    deptStorage,
    formatLicensePlatesInput,
    formatSpotLine,
    isTempInRange,
} from './recUtils.js';

function emptyDraft(department = 'grocery') {
    return {
        plate: '',
        department,
        temp: '',
        temp2: '',
        temp3: '',
        showSpots: false,
        editingId: null,
    };
}

export default function PalletPanel({
    expId,
    entry,
    departments,
    storeDate,
    token,
    onChanged,
    /** When true, allow edit/delete after time out (historical correction). */
    allowCorrection = false,
}) {
    const [draft, setDraft] = useState(() => emptyDraft());
    const [busy, setBusy] = useState(false);

    const updateDraft = (patch) => setDraft((d) => ({ ...d, ...patch }));
    const timedOut = !!(entry?.departed_at);
    const canMutateLive = !timedOut;
    const canCorrect = allowCorrection || canMutateLive;

    const beginEdit = (p) => {
        updateDraft({
            editingId: p.pallet_id,
            plate: p.license_plate || '',
            department: p.department || 'produce',
            temp: p.temp_c != null ? String(p.temp_c) : '',
            temp2: p.temp_spot_2 != null ? String(p.temp_spot_2) : '',
            temp3: p.temp_spot_3 != null ? String(p.temp_spot_3) : '',
            showSpots: p.temp_spot_2 != null && p.temp_spot_3 != null,
        });
    };

    const cancelEdit = () => setDraft(emptyDraft(draft.department));

    const buildTempPayload = () => {
        const plate = formatLicensePlatesInput(draft.plate.trim());
        const department = draft.department;
        if (!plate) {
            alert('Enter license plate.');
            return null;
        }
        if (!department) {
            alert('Select department.');
            return null;
        }
        const needsTemp = deptRequiresTemp(departments, department);
        let t1 = null;
        if (needsTemp) {
            if (draft.temp === '') {
                alert('Enter temperature (°C).');
                return null;
            }
            t1 = Number(draft.temp);
            if (!Number.isFinite(t1)) {
                alert('Enter a valid temperature (°C).');
                return null;
            }
        } else if (draft.temp !== '') {
            t1 = Number(draft.temp);
            if (!Number.isFinite(t1)) {
                alert('Enter a valid temperature (°C) or leave blank.');
                return null;
            }
        }

        const storage = deptStorage(departments, department);
        let tempSpots = null;
        if (needsTemp && storage !== 'ambient' && t1 != null && !isTempInRange(departments, department, t1)) {
            const t2 = Number(draft.temp2);
            const t3 = Number(draft.temp3);
            const haveExtras = Number.isFinite(t2) && Number.isFinite(t3) && draft.temp2 !== '' && draft.temp3 !== '';
            if (!haveExtras) {
                updateDraft({ plate, showSpots: true });
                alert('Out of range — take temps from 2 other spots on this pallet, then press ADD/SAVE again.');
                return null;
            }
            tempSpots = [t1, t2, t3];
        }

        const body = { exp_id: expId, license_plate: plate, department };
        if (t1 != null) body.temp_c = t1;
        if (tempSpots) body.temp_spots = tempSpots;
        if (storeDate) body.store_date = storeDate;
        if (timedOut && allowCorrection) body.correction = '1';
        return body;
    };

    const savePallet = async () => {
        if (!canCorrect) return alert('This truck is timed out — use correction mode from the day log date picker.');
        const body = buildTempPayload();
        if (!body) return;

        setBusy(true);
        try {
            const editing = !!draft.editingId;
            const url = editing
                ? resolveUrl(`/api/receiving/pallets/${encodeURIComponent(draft.editingId)}`)
                : resolveUrl('/api/receiving/pallets');
            const res = await fetch(url, {
                method: editing ? 'PATCH' : 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token || '' },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (data.code === 'NEED_MULTI_SPOT' || data.needs_more_spots) {
                    updateDraft({ showSpots: true });
                    alert(data.error || 'Out of range — take 2 more spot temps, then SAVE again.');
                    return;
                }
                throw new Error(data.error || (editing ? 'Could not update pallet' : 'Could not add pallet'));
            }
            setDraft(emptyDraft(body.department));
            await onChanged?.();
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy(false);
        }
    };

    const removePallet = async (palletId) => {
        if (!window.confirm('Remove this pallet line?')) return;
        if (!canCorrect) return alert('Cannot remove after time out without correction mode.');
        setBusy(true);
        try {
            const qs = new URLSearchParams({ exp_id: expId });
            if (timedOut && allowCorrection) qs.set('correction', '1');
            const res = await fetch(
                resolveUrl(`/api/receiving/pallets/${encodeURIComponent(palletId)}?${qs}`),
                { method: 'DELETE', headers: { 'x-session-token': token || '' } },
            );
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not remove pallet');
            if (draft.editingId === palletId) cancelEdit();
            await onChanged?.();
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy(false);
        }
    };

    const pallets = entry.pallets || [];
    const editing = !!draft.editingId;

    return (
        <div className="pallet-box">
            <div className="section-label" style={{ margin: '0 0 8px', fontSize: '0.7em', color: '#8cf' }}>
                TGP PALLET INTAKE {timedOut && allowCorrection ? '(CORRECTION)' : '(REQUIRED)'}
            </div>
            <p className="hint">
                Date {storeDate} · Perishables / chilled Produce 1–4°C · Frozen −18°C or below · Dry Grocery &amp; Produce (Ambient) — temp optional
                (bananas, onions, potatoes, tomatoes → Produce Ambient)
            </p>
            {!pallets.length ? (
                <div className="hint">No pallets logged yet — required before TGP time out.</div>
            ) : (
                <div className="pallet-list">
                    {pallets.map((p) => {
                        const bad = Number(p.in_range) === 0;
                        return (
                            <div className={`pallet-item ${bad ? 'bad' : ''}`} key={p.pallet_id}>
                                <div>
                                    <strong>{p.license_plate}</strong>
                                    {' · '}
                                    {deptLabel(departments, p.department)}
                                    {' · '}
                                    {formatSpotLine(p)}
                                    {bad ? ' OUT OF TEMP' : ''}
                                    <small>
                                        #{p.seq_num} · {p.captured_by || ''}
                                    </small>
                                </div>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    {canCorrect ? (
                                        <button type="button" className="btn btn-small" disabled={busy} onClick={() => beginEdit(p)}>
                                            EDIT
                                        </button>
                                    ) : null}
                                    {canCorrect ? (
                                        <button type="button" className="btn btn-small btn-warn" disabled={busy} onClick={() => removePallet(p.pallet_id)}>
                                            DEL
                                        </button>
                                    ) : null}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            {canCorrect ? (
                <div className="pallet-row">
                    {editing ? (
                        <p className="hint" style={{ color: '#8cf', margin: '0 0 6px', width: '100%' }}>
                            Editing pallet — change plate / dept / temp then SAVE.
                        </p>
                    ) : null}
                    <input
                        className="input"
                        placeholder="License plate(s) — scan or type"
                        value={draft.plate}
                        onChange={(e) => updateDraft({ plate: e.target.value })}
                        style={{ margin: 0 }}
                    />
                    <select className="input" value={draft.department} onChange={(e) => updateDraft({ department: e.target.value })} style={{ margin: 0 }}>
                        {(departments || []).map((d) => (
                            <option key={d.id} value={d.id}>{d.label}</option>
                        ))}
                    </select>
                    <input
                        className="input"
                        type="number"
                        step="0.1"
                        placeholder="Temp °C (optional for dry / ambient produce)"
                        value={draft.temp}
                        onChange={(e) => updateDraft({ temp: e.target.value })}
                        style={{ margin: 0 }}
                    />
                    {draft.showSpots ? (
                        <div>
                            <p className="hint" style={{ color: '#f90', margin: '0 0 6px' }}>
                                Out of range — enter 2 more spot temps, then SAVE again.
                            </p>
                            <input className="input" type="number" step="0.1" placeholder="Spot 2 °C" value={draft.temp2} onChange={(e) => updateDraft({ temp2: e.target.value })} style={{ margin: '0 0 6px' }} />
                            <input className="input" type="number" step="0.1" placeholder="Spot 3 °C" value={draft.temp3} onChange={(e) => updateDraft({ temp3: e.target.value })} style={{ margin: 0 }} />
                        </div>
                    ) : null}
                    <button type="button" className="btn btn-small" style={{ width: '100%' }} disabled={busy} onClick={savePallet}>
                        {busy ? '…' : (editing ? 'SAVE PALLET' : 'ADD PALLET')}
                    </button>
                    {editing ? (
                        <button type="button" className="btn btn-secondary btn-small" style={{ width: '100%' }} disabled={busy} onClick={cancelEdit}>
                            CANCEL EDIT
                        </button>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}
