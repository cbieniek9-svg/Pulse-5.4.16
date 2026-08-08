import { useState } from 'react';
import { fmtIso, mins } from '../lib/format.jsx';
import { isOrderDayActive } from '../lib/reportHelpers.js';
import { useReportsContext } from '../context/ReportsContext.jsx';
import RosterSuggestionsSection from './RosterSuggestionsSection.jsx';

export default function OrderTodaySection({ data }) {
    const { setReportMode, runAction, api } = useReportsContext();
    const [deferBusy, setDeferBusy] = useState(false);

    if (!isOrderDayActive(data)) return null;

    const meta = data.meta || {};
    const rd = meta.reportDate || data.today;
    const ot = data.order_today || { start: '', end: '' };
    const odb = data.order_day_briefing || {};
    const om = data.order_metrics || {};
    const advisor = data.rhythm_load_advisor || {};
    const omArchiveMissing = om.archive_missing;

    const exp = odb.expected_pieces || {};
    const band = exp.avg != null
        ? `${exp.avg}${exp.min != null && exp.max != null ? ` (${exp.min}–${exp.max})` : ''}`
        : '—';

    const handleDefer = async () => {
        const deferIds = (advisor.defer_candidates || []).map((t) => t.id).filter(Boolean);
        if (!deferIds.length) return;
        setDeferBusy(true);
        try {
            await runAction(() => api.deferRhythmFromReport(advisor.store_date || rd, deferIds));
        } finally {
            setDeferBusy(false);
        }
    };

    return (
        <div className="section" id="sec-orders-today">
            <div className="section-title">ORDER DAY — LIVE</div>
            {omArchiveMissing ? (
                <div style={{ marginBottom: 12, padding: '10px 12px', border: '1px solid rgba(255,170,0,0.4)', borderRadius: 8, background: 'rgba(255,170,0,0.08)', fontSize: '0.78rem', color: 'var(--warn)', textTransform: 'none' }}>
                    No FINISH archive for this date yet — live clock shown; full history is in LEARN.
                </div>
            ) : null}
            <div className="summary-grid" style={{ marginBottom: 12 }}>
                <div className="sum-card ok"><div className="sum-label">ORDER START</div><div className="sum-val" style={{ fontSize: '1.1rem' }}>{fmtIso(ot.start)}</div></div>
                <div className="sum-card warn"><div className="sum-label">ORDER END</div><div className="sum-val" style={{ fontSize: '1.1rem' }}>{fmtIso(ot.end)}</div></div>
                <div className="sum-card purple">
                    <div className="sum-label">ACTUAL ORDER TIME</div>
                    <div className="sum-val" style={{ fontSize: '1.5rem' }}>{omArchiveMissing ? '—' : mins(om.actual_order_minutes || 0)}</div>
                    <div className="sum-sub">
                        {omArchiveMissing ? 'NO ARCHIVE' : `TEAM ${Number(om.team_pph || om.actual_pieces_per_hour || 0).toFixed(1)} PPH · ADJ ${Number(om.adjusted_per_person_pph || 0).toFixed(1)} · ${om.staff_count || 1} STAFF`}
                    </div>
                </div>
                <div className="sum-card ok"><div className="sum-label">PIECES</div><div className="sum-val" style={{ fontSize: '1.5rem' }}>{omArchiveMissing ? '—' : (om.total_pieces || 0)}</div></div>
            </div>
            {odb.is_order_day ? (
                <div style={{ marginTop: 4 }}>
                    <div className="section-title" style={{ marginBottom: 10 }}>ORDER-DAY BRIEFING — {odb.weekday || 'TODAY'}</div>
                    <div className="summary-grid" style={{ marginBottom: 12 }}>
                        <div className="sum-card ok"><div className="sum-label">EXPECTED PIECES</div><div className="sum-val">{band}</div><div className="sum-sub">{odb.sample_count || 0} PRIOR {odb.weekday || ''} SAMPLES</div></div>
                        <div className="sum-card warn"><div className="sum-label">TYPICAL DURATION</div><div className="sum-val">{odb.expected_duration_minutes ? mins(Math.round(odb.expected_duration_minutes)) : '—'}</div></div>
                        <div className="sum-card purple"><div className="sum-label">TYPICAL STAFF</div><div className="sum-val">{odb.expected_staff ?? '—'}</div></div>
                        <div className="sum-card ok"><div className="sum-label">TYPICAL ADJ PPH</div><div className="sum-val">{odb.expected_team_pph != null ? Number(odb.expected_team_pph).toFixed(1) : '—'}</div></div>
                    </div>
                    {(odb.recent_same_weekday || []).length ? (
                        <div className="tbl-wrap">
                            <table>
                                <tbody>
                                    <tr><th>DATE</th><th>PIECES</th><th>STAFF</th><th>DURATION</th></tr>
                                    {(odb.recent_same_weekday || []).map((r, i) => (
                                        <tr key={i}>
                                            <td>{r.store_date}</td>
                                            <td>{r.total_pieces}</td>
                                            <td>{r.staff_count}</td>
                                            <td>{r.actual_order_minutes ? mins(r.actual_order_minutes) : '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                    <RosterSuggestionsSection data={data} highlightWeekday={odb.weekday} compact />
                    {advisor.message ? (
                        <div style={{ marginTop: 14, padding: 12, border: '1px solid rgba(250,160,0,0.35)', borderRadius: 8, background: 'rgba(250,160,0,0.06)' }}>
                            <div style={{ fontSize: '0.72rem', color: 'var(--warn)', letterSpacing: 1, marginBottom: 6 }}>
                                RHYTHM LOAD ADVISOR — {advisor.piece_band?.label || 'ORDER DAY'}
                            </div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--white)', textTransform: 'none', lineHeight: 1.4 }}>{advisor.message}</div>
                            {(advisor.defer_candidates || []).length ? (
                                <div style={{ fontSize: '0.68rem', color: '#888', marginTop: 8, textTransform: 'none' }}>
                                    Defer candidates if heavy: {(advisor.defer_candidates || []).map((t) => t.detail).join(', ')}
                                </div>
                            ) : null}
                            {(advisor.defer_candidates || []).some((t) => t.id) ? (
                                <div style={{ marginTop: 10 }}>
                                    <button type="button" className="btn warn" style={{ padding: '6px 14px', fontSize: '0.72rem' }} disabled={deferBusy} onClick={handleDefer}>
                                        DEFER {(advisor.defer_candidates || []).filter((t) => t.id).length} ROUTINE TASK(S)
                                    </button>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
            <p style={{ fontSize: '0.68rem', color: '#b0b0b0', marginTop: 10, textTransform: 'none' }}>
                90-day history, scorecard, and cadence simulator are in{' '}
                <button type="button" className="btn" style={{ padding: '2px 10px', fontSize: '0.62rem', verticalAlign: 'baseline' }} onClick={() => setReportMode('learn')}>LEARN</button>.
            </p>
        </div>
    );
}
