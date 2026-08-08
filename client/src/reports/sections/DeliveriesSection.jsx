import { useState } from 'react';
import { fmtIso, isoToDatetimeLocal, mins, orderDurationMin } from '../lib/format.jsx';
import { useReportsContext } from '../context/ReportsContext.jsx';

function DeliveryRow({ row, onSave }) {
    const [draft, setDraft] = useState({
        arrivedAt: isoToDatetimeLocal(row.arrived_at),
        departedAt: isoToDatetimeLocal(row.departed_at),
        invoiceRef: row.invoice_ref || '',
    });
    const [busy, setBusy] = useState(false);
    const editable = !!(row.arrived_at || row.departed_at);
    const durMins = (row.arrived_at && row.departed_at)
        ? orderDurationMin(row.arrived_at, row.departed_at)
        : '—';

    if (!editable) {
        return (
            <tr>
                <td style={{ color: 'var(--white)', fontWeight: 700 }}>{row.vendor}</td>
                <td><span className="pill">{row.status}</span></td>
                <td colSpan={2} style={{ color: '#b0b0b0', fontSize: '0.72rem', textTransform: 'none' }}>No dock times logged</td>
                <td>{row.invoice_ref || ''}</td>
                <td>—</td>
                <td>{row.arrived_by || row.departed_by || row.closed_by || ''}</td>
                <td>—</td>
            </tr>
        );
    }

    return (
        <tr data-exp-id={row.exp_id || ''}>
            <td style={{ color: 'var(--white)', fontWeight: 700 }}>
                {row.vendor}
                <div className="piece-hint">
                    {row.expected_day || ''}{row.pieces ? ` · ${row.pieces} pcs` : ''}{row.category ? ` · ${row.category}` : ''}
                </div>
            </td>
            <td><span className="pill">{row.status}</span></td>
            <td><input className="hist-input hist-input-time recv-arrived-at" type="datetime-local" value={draft.arrivedAt} onChange={(e) => setDraft({ ...draft, arrivedAt: e.target.value })} /></td>
            <td><input className="hist-input hist-input-time recv-departed-at" type="datetime-local" value={draft.departedAt} onChange={(e) => setDraft({ ...draft, departedAt: e.target.value })} /></td>
            <td><input className="hist-input hist-input-note recv-invoice-ref" type="text" maxLength={120} value={draft.invoiceRef} placeholder="Invoice / ref #" onChange={(e) => setDraft({ ...draft, invoiceRef: e.target.value })} /></td>
            <td><span className="pill recv-duration-preview">{durMins}</span></td>
            <td style={{ fontSize: '0.72rem', color: 'var(--text)' }}>{row.departed_by || row.arrived_by || row.closed_by || ''}</td>
            <td>
                <button
                    type="button"
                    className="btn ok order-history-actions btn"
                    style={{ padding: '4px 10px', fontSize: '0.65rem' }}
                    disabled={busy}
                    onClick={async () => {
                        if (!draft.arrivedAt) return alert('Time in is required.');
                        setBusy(true);
                        try {
                            await onSave({
                                expId: row.exp_id,
                                arrivedAt: draft.arrivedAt,
                                departedAt: draft.departedAt,
                                invoiceRef: draft.invoiceRef,
                            });
                        } catch (e) {
                            alert(e.message || 'Could not save receiving times');
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    SAVE
                </button>
            </td>
        </tr>
    );
}

export default function DeliveriesSection({ data, rangeLabel }) {
    const { runAction, api } = useReportsContext();
    const deliveries = data.deliveries || [];

    return (
        <div className="section" id="sec-deliveries">
            <div className="section-title">
                DELIVERY RECEIPTS — {rangeLabel}
                <span style={{ float: 'right', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="btn" onClick={() => api.openFileMaintenanceReceivingLog('print').catch((e) => alert(e.message))}>PRINT REC LOG</button>
                    <button type="button" className="btn" onClick={() => api.openFileMaintenanceReceivingLog('csv').catch((e) => alert(e.message))}>CSV</button>
                </span>
            </div>
            <p style={{ fontSize: '0.68rem', color: '#b0b0b0', margin: '0 0 10px', textTransform: 'none' }}>
                Managers can correct time in/out and invoice/ref # when a late time out skews receiving stats or the invoice arrives after checkout. SAVE rebuilds dock duration.
            </p>
            <div className="tbl-wrap">
                <table className="order-history-table">
                    <tbody>
                        <tr><th>VENDOR</th><th>STATUS</th><th>TIME IN</th><th>TIME OUT</th><th>INVOICE / REF #</th><th>DUR</th><th>BY</th><th>SAVE</th></tr>
                        {deliveries.length ? deliveries.map((r) => (
                            <DeliveryRow
                                key={r.exp_id || `${r.vendor}-${r.arrived_at}`}
                                row={r}
                                onSave={(payload) => runAction(() => api.saveReceivingLogCorrection(payload))}
                            />
                        )) : (
                            <tr><td colSpan={8} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO DELIVERIES RECORDED FOR THIS DATE</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export function ColdChainSection({ data, rangeLabel }) {
    const { api, runAction } = useReportsContext();
    const rows = data.tgp_cold_chain || [];
    const departments = data.receiving_pallet_departments || [];

    return (
        <div className="section" id="sec-tgp-cold-chain">
            <div className="section-title">
                TGP COLD CHAIN — {rangeLabel}
                <span style={{ float: 'right', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button type="button" className="btn" onClick={() => api.printTgpColdChain('print').catch((e) => alert(e.message))}>PRINT COLD CHAIN</button>
                    <button type="button" className="btn" onClick={() => api.printTgpColdChain('csv').catch((e) => alert(e.message))}>CSV</button>
                </span>
            </div>
            <p style={{ fontSize: '0.75rem', color: '#888', textTransform: 'none', margin: '0 0 12px' }}>
                Pallet license plates and temperatures logged at TGP receiving. Out-of-range rows are flagged for vendor credit conversations — no floor tasks are auto-created.
                Use Produce (Ambient) for bananas, onions, potatoes, and tomatoes. SAVE corrects plate / dept / temp after time out.
            </p>
            <div className="tbl-wrap">
                <table>
                    <tbody>
                        <tr><th>DATE</th><th>PLATE</th><th>DEPARTMENT</th><th>TEMP °C</th><th>RANGE</th><th>INVOICE</th><th>BY</th><th>SAVE</th></tr>
                        {rows.length ? rows.map((r) => (
                            <ColdChainRow
                                key={r.pallet_id || `${r.license_plate}-${r.store_date}-${r.seq_num}`}
                                row={r}
                                departments={departments}
                                onSave={(payload) => runAction(() => api.saveReceivingPalletCorrection(payload))}
                            />
                        )) : (
                            <tr><td colSpan={8} style={{ color: '#444', textAlign: 'center', padding: 20 }}>NO TGP PALLET LOGS IN THIS RANGE</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function ColdChainRow({ row, departments, onSave }) {
    const [draft, setDraft] = useState({
        plate: row.license_plate || '',
        department: row.department || 'produce',
        temp: row.temp_c != null ? String(row.temp_c) : '',
    });
    const [busy, setBusy] = useState(false);

    return (
        <tr style={Number(row.in_range) === 0 ? { background: 'rgba(255,68,68,0.08)' } : undefined}>
            <td style={{ fontSize: '0.72rem' }}>{row.store_date || ''}</td>
            <td>
                <input
                    className="hist-input"
                    value={draft.plate}
                    onChange={(e) => setDraft({ ...draft, plate: e.target.value })}
                    style={{ minWidth: 90 }}
                />
            </td>
            <td>
                <select
                    className="hist-input"
                    value={draft.department}
                    onChange={(e) => setDraft({ ...draft, department: e.target.value })}
                >
                    {(departments.length ? departments : [{ id: draft.department, label: draft.department }]).map((d) => (
                        <option key={d.id} value={d.id}>{d.label || d.id}</option>
                    ))}
                </select>
            </td>
            <td>
                <input
                    className="hist-input hist-input-time"
                    type="number"
                    step="0.1"
                    value={draft.temp}
                    onChange={(e) => setDraft({ ...draft, temp: e.target.value })}
                    style={{ width: 72 }}
                />
            </td>
            <td>{Number(row.in_range) === 0 ? <span className="pill" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>OUT</span> : <span className="pill" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>OK</span>}</td>
            <td>{row.invoice_ref || ''}</td>
            <td>{row.captured_by || ''}</td>
            <td>
                <button
                    type="button"
                    className="btn ok"
                    style={{ padding: '4px 10px', fontSize: '0.65rem' }}
                    disabled={busy || !row.pallet_id}
                    onClick={async () => {
                        setBusy(true);
                        try {
                            await onSave({
                                palletId: row.pallet_id,
                                expId: row.exp_id,
                                licensePlate: draft.plate,
                                department: draft.department,
                                tempC: draft.temp,
                            });
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    SAVE
                </button>
            </td>
        </tr>
    );
}

export function SafetyInspectionsSection({ data, rangeLabel }) {
    const { api } = useReportsContext();
    const rows = data.safety_inspections || [];

    return (
        <div className="section" id="sec-safety-inspections">
            <div className="section-title">SAFETY INSPECTIONS — {rangeLabel}</div>
            <p style={{ fontSize: '0.75rem', color: '#888', textTransform: 'none', margin: '0 0 12px' }}>
                Submitted monthly committee walk-throughs from <a href="/safe" style={{ color: 'var(--accent)' }}>/safe</a>. Findings are logged for review — no tasks are auto-created.
            </p>
            <div className="tbl-wrap">
                <table>
                    <tbody>
                        <tr><th>DATE</th><th>SUBMITTED</th><th>BY</th><th>FINDINGS (NO)</th><th>PRINT</th></tr>
                        {rows.length ? rows.map((r) => (
                            <tr key={r.run_id}>
                                <td style={{ fontWeight: 700, color: 'var(--white)' }}>{r.inspection_date || ''}</td>
                                <td style={{ fontSize: '0.72rem' }}>{r.submitted_at ? new Date(r.submitted_at).toLocaleString() : '—'}</td>
                                <td>{r.submitted_by || ''}</td>
                                <td>{Number(r.no_count) > 0 ? <span className="pill" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }}>{r.no_count}</span> : <span className="pill" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>0</span>}</td>
                                <td><button type="button" className="pill" style={{ cursor: 'pointer', background: 'transparent' }} onClick={() => api.printSafetyInspection(r.run_id).catch((e) => alert(e.message))}>PRINT</button></td>
                            </tr>
                        )) : (
                            <tr><td colSpan={5} style={{ color: '#444', textAlign: 'center', padding: 20 }}>NO SUBMITTED INSPECTIONS IN THIS RANGE</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
