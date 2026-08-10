import { useEffect, useRef, useState } from 'react';

export const ORDER_FINISH_REASON_OPTIONS = [
    { value: '', label: 'Normal day — nothing to flag' },
    { value: 'Truck late / early', label: 'Truck late / early' },
    { value: 'Short-staffed (call-in)', label: 'Short-staffed (call-in)' },
    { value: 'Oversized order', label: 'Oversized order' },
    { value: 'Light / undersized order', label: 'Light / undersized order' },
    { value: 'Equipment down', label: 'Equipment down (baler / forklift / freezer)' },
    { value: 'Heavy customer traffic', label: 'Heavy customer traffic' },
    { value: 'Training / new staff', label: 'Training / new staff' },
    { value: 'Other', label: 'Other (see note)' },
];

export function defaultOrderFinishStaff(syncData, clockKind = 'dry') {
    const counts = syncData?.counts || {};
    const kpis = syncData?.kpis || {};
    if (clockKind === 'frozen') {
        const fromFrozen = Number(counts.frozen_staff || 0);
        if (fromFrozen > 0) return fromFrozen;
    }
    const fromCounts = Number(counts.staff || 0);
    if (fromCounts > 0) return fromCounts;
    const fromKpi = Number(kpis.order_staff || kpis.staff || 0);
    if (fromKpi > 0) return fromKpi;
    const active = (syncData?.staff || []).filter((s) => s.active === 1 && s.name !== 'Unassigned').length;
    return active > 0 ? active : 1;
}

export function buildExceptionReason(reasonSel, reasonNote) {
    const note = String(reasonNote || '').trim();
    const sel = String(reasonSel || '').trim();
    let exception_reason = '';
    if (sel === 'Other') exception_reason = note;
    else if (sel) exception_reason = note ? `${sel} — ${note}` : sel;
    else if (note) exception_reason = note;
    return exception_reason.slice(0, 200);
}

/**
 * FINISH ORDER modal — mirrors legacy showOrderFinishGate.
 */
export default function OrderFinishGateModal({ syncData, clockKind = 'dry', onCancel, onConfirm }) {
    const isFrozen = clockKind === 'frozen';
    const [staff, setStaff] = useState(() => String(defaultOrderFinishStaff(syncData, clockKind)));
    const [hardware, setHardware] = useState(() => syncData?.settings?.Hardware_Arrived === '1');
    const [reasonSel, setReasonSel] = useState('');
    const [reasonNote, setReasonNote] = useState('');
    const [error, setError] = useState('');
    const seededKindRef = useRef(null);

    useEffect(() => {
        // Seed once per open/clockKind — do not overwrite edits when syncData identity churns.
        if (seededKindRef.current === clockKind) return;
        seededKindRef.current = clockKind;
        setStaff(String(defaultOrderFinishStaff(syncData, clockKind)));
        setHardware(syncData?.settings?.Hardware_Arrived === '1');
    }, [syncData, clockKind]);

    const elapsedMins = Number(
        isFrozen
            ? (syncData?.kpis?.frozen_elapsed_mins || 0)
            : (syncData?.kpis?.shift_elapsed_mins || 0),
    );
    const presenceHint = syncData?.manager_meta?.presence_board?.order_hint;

    const submit = () => {
        const n = parseInt(staff, 10);
        if (Number.isNaN(n) || n < 1 || n > 99) {
            setError('Staff on order must be 1–99');
            return;
        }
        onConfirm({
            staff_count: n,
            hardware_arrived: isFrozen ? false : !!hardware,
            exception_reason: buildExceptionReason(reasonSel, reasonNote),
            clock_kind: isFrozen ? 'frozen' : 'dry',
        });
    };

    return (
        <div className="confirm-backdrop" role="presentation" style={{ display: 'flex' }}>
            <div
                className="confirm-panel"
                role="dialog"
                aria-modal="true"
                style={{ width: 'min(100%, 440px)', borderColor: isFrozen ? '#6cf' : '#f90' }}
            >
                <div className="confirm-header" style={{ color: isFrozen ? '#6cf' : '#f90' }}>
                    {isFrozen ? 'FINISH FROZEN ORDER' : 'FINISH DRY ORDER'}
                </div>
                <div className="confirm-body" style={{ textTransform: 'none' }}>
                    <p style={{ margin: '0 0 14px', color: '#c7d7ec', fontSize: '0.9em' }}>
                        {isFrozen
                            ? 'Enter the frozen crew headcount before archiving frozen clock metrics.'
                            : 'Confirm dry (grocery) headcount and hardware before archiving dry clock metrics.'}
                    </p>
                    {elapsedMins >= 120 ? (
                        <div style={{ color: '#f90', fontSize: '0.82em', marginBottom: 12, textAlign: 'left' }}>
                            Long shift — confirm staff on order (avoid leaving at 1 unless solo).
                        </div>
                    ) : null}
                    {!isFrozen && presenceHint && presenceHint.beacon_count > 0 ? (
                        <div style={{
                            color: '#0cf',
                            fontSize: '0.82em',
                            marginBottom: 12,
                            textAlign: 'left',
                            border: '1px solid rgba(0,229,255,0.35)',
                            padding: 8,
                            borderRadius: 6,
                        }}
                        >
                            BLE hint:
                            {' '}
                            {presenceHint.count_label || `~${presenceHint.beacon_count} at receiving`}
                            {presenceHint.display_names?.length ? ` (${presenceHint.display_names.join(', ')})` : ''}
                            . Confirm headcount — BLE is not proof.
                        </div>
                    ) : null}
                    <label className="section-label" style={{ fontSize: '0.75em' }}>
                        {isFrozen ? 'FROZEN CREW HEADCOUNT' : 'DRY STAFF ON ORDER'}
                    </label>
                    <input
                        className="st-input"
                        type="number"
                        min={1}
                        max={99}
                        value={staff}
                        onChange={(e) => setStaff(e.target.value)}
                        style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }}
                        autoFocus
                    />
                    {!isFrozen ? (
                        <label style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: '0.85em',
                            color: '#fff',
                            marginBottom: 16,
                            cursor: 'pointer',
                            textTransform: 'none',
                        }}
                        >
                            <input type="checkbox" checked={hardware} onChange={(e) => setHardware(e.target.checked)} />
                            Hardware delivery arrived today (include in dry archived totals)
                        </label>
                    ) : null}
                    <label className="section-label" style={{ fontSize: '0.75em' }}>DAY NOTE — anything unusual? (optional)</label>
                    <select
                        className="st-input"
                        value={reasonSel}
                        onChange={(e) => setReasonSel(e.target.value)}
                        style={{ width: '100%', marginBottom: 8, boxSizing: 'border-box' }}
                    >
                        {ORDER_FINISH_REASON_OPTIONS.map((o) => (
                            <option key={o.value || 'normal'} value={o.value}>{o.label}</option>
                        ))}
                    </select>
                    <input
                        className="st-input"
                        type="text"
                        maxLength={160}
                        value={reasonNote}
                        onChange={(e) => setReasonNote(e.target.value)}
                        placeholder="Optional detail…"
                        style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box', textTransform: 'none' }}
                    />
                    {error ? <div style={{ color: '#f44', fontSize: '0.82em', marginBottom: 10 }}>{error}</div> : null}
                </div>
                <div className="confirm-actions">
                    <button type="button" className="st-btn subtle" onClick={onCancel}>CANCEL</button>
                    <button type="button" className="st-btn" style={{ borderColor: '#0f8', color: '#0f8' }} onClick={submit}>
                        FINISH &amp; ARCHIVE
                    </button>
                </div>
            </div>
        </div>
    );
}
