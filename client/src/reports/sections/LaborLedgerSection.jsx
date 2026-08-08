import { laborVerdictClass } from '../lib/reportHelpers.js';

export default function LaborLedgerSection({ data }) {
    const ll = data.labor_ledger;
    if (!ll) return null;
    const meta = data.meta || {};
    if (meta.isLiveToday === false && meta.reportStart !== meta.reportEnd) return null;

    const vCls = laborVerdictClass(ll.verdict);
    const sched = ll.scheduled || {};
    const committed = ll.committed || {};
    const drag = ll.fixed_drag || {};
    const svf = ll.schedule_vs_finish || {};
    const minBase = ll.minimum_baseline || {};

    const card = (label, val, sub) => (
        <div className={`sum-card ${vCls}`}>
            <div className="sum-label">{label}</div>
            <div className="sum-val" style={{ fontSize: '1.35rem' }}>{val}</div>
            {sub ? <div className="sum-sub">{sub}</div> : null}
        </div>
    );

    return (
        <div className="section" id="sec-labor-ledger">
            <div className="section-title">LABOR LEDGER — {ll.store_date || ''}</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-6px 0 12px', textTransform: 'none' }}>
                Scheduled person-hours vs committed workload (rhythm + order + fixed drag). Use before huddle on order days.
            </p>
            <div className="summary-grid" style={{ marginBottom: 12 }}>
                {card('VERDICT', String(ll.verdict || 'unknown').toUpperCase(), ll.verdict_detail || '')}
                {card('SCHEDULED HRS', sched.person_hours != null ? Number(sched.person_hours).toFixed(1) : '—', `${sched.complement || 0} people · ${sched.shift_rows || 0} rows`)}
                {card('COMMITTED HRS', committed.person_hours != null ? Number(committed.person_hours).toFixed(1) : '—', `Rhythm ${Number(committed.rhythm_hours || 0).toFixed(1)} + Order ${Number(committed.order_hours || 0).toFixed(1)} + Drag ${Number(committed.fixed_drag_hours || 0).toFixed(1)}`)}
                {card('SHIFT LEAD', ll.shift_lead || data.shift_lead || '—', ll.is_order_day ? 'ORDER DAY' : (ll.weekday || ''))}
            </div>
            {(sched.by_bucket || []).length ? (
                <div style={{ marginBottom: 10 }}>
                    {(sched.by_bucket || []).map((b, i) => (
                        <span key={i} className="chip">{b.label}: {Number(b.hours).toFixed(1)}h</span>
                    ))}
                </div>
            ) : null}
            {minBase.minimum_hours != null ? (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(100,140,255,0.06)', borderLeft: '3px solid var(--accent)', fontSize: '0.72rem', textTransform: 'none' }}>
                    <strong>Minimum hours baseline (Excel archive):</strong>
                    {' '}{Number(minBase.minimum_hours).toFixed(1)}h scheduled
                    · actual {sched.person_hours != null ? Number(sched.person_hours).toFixed(1) : '—'}h
                    {minBase.overage_pct != null ? ` · ${minBase.overage_pct > 0 ? '+' : ''}${minBase.overage_pct}% vs minimum` : ''}
                    {minBase.over_minimum ? ' · OVER SOFT THRESHOLD' : ''}
                </div>
            ) : null}
            {(ll.reasons || []).length ? (
                <ul style={{ fontSize: '0.72rem', color: 'var(--text)', textTransform: 'none', margin: '0 0 10px 18px' }}>
                    {(ll.reasons || []).map((r, i) => <li key={i}>{r}</li>)}
                </ul>
            ) : null}
            {svf.mismatch || svf.complement_vs_expected != null ? (
                <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: 'rgba(250,160,0,0.08)', borderLeft: '3px solid var(--warn)', fontSize: '0.72rem', textTransform: 'none' }}>
                    <strong>Schedule vs FINISH:</strong>
                    {' '}complement {svf.schedule_complement || '—'}
                    · FINISH staff {svf.finish_staff_archived ?? svf.finish_staff_live ?? '—'}
                    · typical {svf.expected_staff ?? '—'}
                    {Array.isArray(svf.finish_roster) && svf.finish_roster.length ? ` · roster: ${svf.finish_roster.join(', ')}` : ''}
                </div>
            ) : null}
            <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', fontSize: '0.72rem', color: 'var(--accent)', letterSpacing: 1 }}>FIXED DRAG BREAKDOWN</summary>
                <div className="tbl-wrap" style={{ marginTop: 8 }}>
                    <table>
                        <tbody>
                            <tr><th>ITEM</th><th>COUNT</th><th>EST MINS</th></tr>
                            <tr><td>Vendor rhythm tasks</td><td>{drag.vendor_count || 0}</td><td>{drag.vendor_rhythm_mins || 0}</td></tr>
                            <tr><td>Urgent/High open tasks</td><td>{drag.urgent_open_count || 0}</td><td>{drag.urgent_open_mins || 0}</td></tr>
                            <tr><td>Expiry pulls due</td><td>{drag.pulls_due_count || 0}</td><td>{drag.pulls_due_mins || 0}</td></tr>
                            <tr><td>Open customer orders</td><td>{drag.customer_orders_open || 0}</td><td>{drag.customer_orders_mins || 0}</td></tr>
                            <tr><td>Pending receiving</td><td>{drag.vendors_pending || 0}</td><td>{drag.receiving_pending_mins || 0}</td></tr>
                            <tr><td>Hardware not arrived</td><td>{drag.hardware_mins ? 1 : 0}</td><td>{drag.hardware_mins || 0}</td></tr>
                        </tbody>
                    </table>
                </div>
            </details>
        </div>
    );
}
