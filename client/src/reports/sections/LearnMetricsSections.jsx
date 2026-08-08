import { fmtIso, fmtDeltaPct, mins, Na } from '../lib/format.jsx';
import { trendCardClass } from '../lib/reportHelpers.js';
import { useReportsContext } from '../context/ReportsContext.jsx';
import RhythmActionCell from '../components/RhythmActionCell.jsx';

export default function TrendsSection({ data }) {
    const { api } = useReportsContext();
    const t = data.trends || {};
    const cards = t.cards || [];
    const insights = t.insights || [];
    const rows = t.daily_rows || [];

    return (
        <div className="section" id="sec-trends">
            <div className="section-title">LONG-TERM TRENDS &amp; INSIGHTS — {t.start_date || ''} → {t.end_date || ''}</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-6px 0 12px', textTransform: 'none' }}>
                Rule-based, explainable store trends from daily snapshots. Outdated Items uses the old internal shrink_log table but is reported as outdated/out-of-date work.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <button type="button" className="btn ok" onClick={() => api.downloadTrendCsv(365).catch((e) => alert(e.message))}>EXPORT TREND CSV</button>
                <button type="button" className="btn warn" onClick={() => api.downloadFullHistoryZip().catch((e) => alert(e.message))}>EXPORT FULL HISTORY ZIP (MANAGER)</button>
            </div>
            <div className="summary-grid" style={{ marginBottom: 14 }}>
                {cards.length ? cards.slice(0, 10).map((c, i) => (
                    <div key={i} className={`sum-card ${trendCardClass(c)}`}>
                        <div className="sum-label">{c.label || c.key || ''}</div>
                        <div className="sum-val" style={{ fontSize: '1.25rem' }}><Na value={c.current} /></div>
                        <div className="sum-sub">{fmtDeltaPct(c)} VS PREV · <Na value={c.previous} /></div>
                    </div>
                )) : <div style={{ color: '#b0b0b0', fontSize: '0.75rem' }}>NO TREND CARDS YET</div>}
            </div>
            <div className="two-col">
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>EXPLAINABLE INSIGHTS</div>
                    <div className="action-inbox">
                        {insights.length ? insights.map((ins, i) => {
                            const cls = ins.severity === 'warn' ? 'warn' : (ins.severity === 'ok' ? 'ok' : '');
                            const color = ins.severity === 'warn' ? 'var(--warn)' : (ins.severity === 'ok' ? 'var(--ok)' : 'var(--accent)');
                            return (
                                <div key={i} className={`action-card ${cls}`}>
                                    <span className="action-pri" style={{ color }}>{String(ins.severity || 'info').toUpperCase()}</span>
                                    <div className="action-body">
                                        <div className="action-title">{ins.title || ''}</div>
                                        <div className="action-detail">{ins.detail || ''}</div>
                                    </div>
                                </div>
                            );
                        }) : <div style={{ fontSize: '0.75rem', color: '#b0b0b0' }}>NO INSIGHTS YET</div>}
                    </div>
                </div>
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>RECENT DAILY SNAPSHOTS</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>DATE</th><th>TASK IN</th><th>TASK DONE</th><th>OOS</th><th>OUTDATED</th><th>EXPIRY</th><th>PIECES</th><th>ADJ PPH</th><th>DD</th><th>UPD</th><th>LEAD</th></tr>
                                {rows.length ? rows.slice(-14).reverse().map((r) => (
                                    <tr key={r.store_date}>
                                        <td>{r.store_date}</td>
                                        <td>{r.tasks_created || 0}</td>
                                        <td>{r.tasks_closed || 0}</td>
                                        <td>{r.oos_opened || 0}/{r.oos_closed || 0}</td>
                                        <td>{r.outdated_item_logs || 0}</td>
                                        <td>{r.expiry_pull_logs || 0}</td>
                                        <td>{r.order_pieces || 0}</td>
                                        <td>{r.adjusted_pph == null ? '—' : Number(r.adjusted_pph).toFixed(1)}</td>
                                        <td>{r.daily_direction_posted ? 'YES' : 'NO'}</td>
                                        <td>{r.shift_updates_posted || 0}</td>
                                        <td style={{ fontSize: '0.68rem', color: 'var(--text)', textTransform: 'none' }}>{r.manager_on_duty || '—'}</td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={11} style={{ color: '#444', textAlign: 'center', padding: 16 }}>SNAPSHOTS WILL FILL IN AFTER EOD OR CSV EXPORT</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function TaskPlanningSection({ data, rangeLabel }) {
    const tps = data.task_planning_summary || {};
    const overall = tps.overall;
    const rows = tps.by_type || [];

    if (!tps.sample_count || !overall) {
        return (
            <div className="section" id="sec-planning">
                <div className="section-title">TASK PLANNING ACCURACY — {rangeLabel}</div>
                <p style={{ fontSize: '0.75rem', color: '#b0b0b0', textTransform: 'none' }}>Close tasks with est + actual times to build planning accuracy metrics.</p>
            </div>
        );
    }

    const biasLabel = overall.bias_pct > 15 ? 'UNDER-ESTIMATED'
        : (overall.bias_pct < -15 ? 'OVER-ESTIMATED' : 'ON TRACK');
    const card = (label, val, sub) => (
        <div className="sum-card ok">
            <div className="sum-label">{label}</div>
            <div className="sum-val" style={{ fontSize: '1.35rem' }}>{val}</div>
            {sub ? <div className="sum-sub">{sub}</div> : null}
        </div>
    );

    return (
        <div className="section" id="sec-planning">
            <div className="section-title">TASK PLANNING ACCURACY — {rangeLabel}</div>
            <div className="summary-grid" style={{ marginBottom: 12 }}>
                {card('SAMPLES', tps.sample_count, 'HUMAN-CLOSED TASKS')}
                {card('AVG EST', `${overall.avg_est_mins}M`, 'PLANNED')}
                {card('AVG ACTUAL', `${overall.avg_actual_mins}M`, 'COMPLETED')}
                {card('BIAS', `${overall.bias_mins >= 0 ? '+' : ''}${overall.bias_mins}M`, biasLabel)}
            </div>
            <div className="tbl-wrap">
                <table>
                    <tbody>
                        <tr><th>TASK TYPE</th><th>SAMPLES</th><th>AVG EST</th><th>AVG ACTUAL</th><th>BIAS</th><th>STATUS</th><th>RHYTHM</th></tr>
                        {rows.map((r) => (
                            <tr key={r.task_type}>
                                <td style={{ color: 'var(--white)', fontWeight: 700 }}>{r.task_type}</td>
                                <td>{r.sample_count}</td>
                                <td>{r.avg_est_mins}m</td>
                                <td>{r.avg_actual_mins}m</td>
                                <td>{r.bias_mins >= 0 ? '+' : ''}{r.bias_mins}m ({r.bias_pct >= 0 ? '+' : ''}{r.bias_pct}%)</td>
                                <td><span className={`plan-status ${r.status}`}>{String(r.status || '').replace(/_/g, ' ').toUpperCase()}</span></td>
                                <td><RhythmActionCell row={r} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p style={{ fontSize: '0.68rem', color: '#b0b0b0', marginTop: 10, textTransform: 'none' }}>
                Apply updates an existing rhythm template. Add to rhythm promotes recurring work (3+ samples) with the learned estimate.
            </p>
        </div>
    );
}

export function FinishHealthSection({ data }) {
    if (!data.finish_archive_health) return null;
    const f = data.finish_archive_health;
    const gaps = (f.missing_finish_days || []).slice(0, 5).map((g) => g.store_date).join(', ');

    return (
        <div className="section" id="sec-finish-health">
            <div className="section-title">FINISH ARCHIVE HEALTH</div>
            <div className="summary-grid" style={{ marginBottom: 10 }}>
                <div className={`sum-card ${f.phase0_ready ? 'ok' : 'warn'}`}>
                    <div className="sum-label">COMPLETE ORDER DAYS</div>
                    <div className="sum-val">{f.complete_order_days}</div>
                    <div className="sum-sub">{String(f.scorecard_trust || 'building').toUpperCase()}</div>
                </div>
                <div className="sum-card">
                    <div className="sum-label">RECENT GAPS</div>
                    <div className="sum-val" style={{ fontSize: '1.1rem' }}>{(f.missing_finish_days || []).length}</div>
                    <div className="sum-sub">{gaps || 'NONE IN WINDOW'}</div>
                </div>
                <div className="sum-card">
                    <div className="sum-label">INCOMPLETE ROWS</div>
                    <div className="sum-val" style={{ fontSize: '1.1rem' }}>{(f.incomplete_rows || []).length}</div>
                    <div className="sum-sub">FIX IN ORDER HISTORY</div>
                </div>
            </div>
            <p style={{ fontSize: '0.75rem', color: '#888', textTransform: 'none' }}>{f.message || ''}</p>
        </div>
    );
}

export function ExceptionRollupSection({ data }) {
    const rollup = data.exception_reason_rollup;
    if (!rollup || !(rollup.reasons || []).length) {
        return (
            <div className="section" id="sec-exception-rollup">
                <div className="section-title">ORDER DAY NOTES — 90 DAY ROLLUP</div>
                <p style={{ fontSize: '0.75rem', color: '#b0b0b0', textTransform: 'none' }}>Add day notes in order history when FINISH runs off-plan — patterns appear here.</p>
            </div>
        );
    }

    return (
        <div className="section" id="sec-exception-rollup">
            <div className="section-title">ORDER DAY NOTES — 90 DAY ROLLUP</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-6px 0 12px', textTransform: 'none' }}>
                {rollup.tagged_order_days} of {rollup.total_order_days} archived order days tagged with a day note.
            </p>
            <div className="tbl-wrap">
                <table>
                    <tbody>
                        <tr><th>REASON</th><th>TIMES</th><th>AVG STAFF</th><th>AVG PIECES</th><th>RECENT DATES</th></tr>
                        {rollup.reasons.map((r, i) => (
                            <tr key={i}>
                                <td style={{ color: 'var(--white)', fontWeight: 700, textTransform: 'none' }}>{r.reason}</td>
                                <td><span className="pill">{r.count}</span></td>
                                <td>{r.avg_staff ?? '—'}</td>
                                <td>{r.avg_pieces ?? '—'}</td>
                                <td style={{ fontSize: '0.68rem', color: 'var(--text)', textTransform: 'none' }}>{(r.recent_dates || []).join(', ')}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export function StaffCountCurveSection({ data }) {
    const curve = data.staff_count_curve || [];
    if (!curve.length) return null;
    const wd = (data.order_day_briefing || {}).weekday || '';

    return (
        <div className="section" id="sec-staff-curve">
            <div className="section-title">STAFF COUNT vs ORDER PERFORMANCE{wd ? ` — ${wd}` : ''}</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-6px 0 12px', textTransform: 'none' }}>From FINISH archives — use when staffing order days.</p>
            <div className="tbl-wrap">
                <table>
                    <tbody>
                        <tr><th>STAFF ON ORDER</th><th>SAMPLES</th><th>AVG ADJ PPH</th><th>AVG DURATION</th></tr>
                        {curve.map((r, i) => (
                            <tr key={i}>
                                <td>{r.staff_count}</td>
                                <td>{r.samples}</td>
                                <td>{r.avg_adj_pph != null ? Number(r.avg_adj_pph).toFixed(1) : '—'}</td>
                                <td>{r.avg_minutes != null ? mins(Math.round(r.avg_minutes)) : '—'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export function ActionLogsSection({ data }) {
    const acks = data.action_ack_log || [];
    const defers = data.rhythm_defer_log || [];

    if (!acks.length && !defers.length) {
        return (
            <div className="section" id="sec-action-logs">
                <div className="section-title">INBOX ACK &amp; RHYTHM DEFER LOG</div>
                <p style={{ fontSize: '0.75rem', color: '#b0b0b0', textTransform: 'none' }}>Dismissed inbox items and deferred rhythm tasks will appear here.</p>
            </div>
        );
    }

    return (
        <div className="section" id="sec-action-logs">
            <div className="section-title">INBOX ACK &amp; RHYTHM DEFER LOG</div>
            <div className="two-col">
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>INBOX DISMISSALS</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>WHEN</th><th>BY</th><th>KIND</th><th>ACTION</th></tr>
                                {acks.length ? acks.slice(0, 25).map((a, i) => (
                                    <tr key={i}>
                                        <td style={{ fontSize: '0.72rem' }}>{fmtIso(a.acked_at)}</td>
                                        <td>{a.acked_by || ''}</td>
                                        <td>{a.kind || ''}</td>
                                        <td style={{ fontSize: '0.68rem', color: 'var(--text)', textTransform: 'none' }}>{a.action_id || ''}</td>
                                    </tr>
                                )) : <tr><td colSpan={4} style={{ color: '#444', textAlign: 'center', padding: 12 }}>NONE YET</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </div>
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>RHYTHM DEFERRALS</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>DATE</th><th>WHEN</th><th>BY</th><th>TEMPLATES</th><th>CLOSED</th></tr>
                                {defers.length ? defers.slice(0, 25).map((e, i) => (
                                    <tr key={i}>
                                        <td>{e.store_date || ''}</td>
                                        <td style={{ fontSize: '0.72rem' }}>{e.deferred_at ? fmtIso(e.deferred_at) : '—'}</td>
                                        <td>{e.deferred_by || (e.backfilled ? 'backfill' : '')}</td>
                                        <td style={{ fontSize: '0.68rem', color: 'var(--text)', textTransform: 'none' }}>{(e.templates || []).join('; ') || '—'}</td>
                                        <td>{e.closed_board_tasks || 0}</td>
                                    </tr>
                                )) : <tr><td colSpan={5} style={{ color: '#444', textAlign: 'center', padding: 12 }}>NONE YET</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </div>
    );
}
