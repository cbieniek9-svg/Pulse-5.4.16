import { useMemo, useState } from 'react';
import { fmtIso, isoToDatetimeLocal, mins, orderDurationMin } from '../lib/format.jsx';
import { simulateOrderCadence } from '../lib/orderCadenceSim.js';
import { useReportsContext } from '../context/ReportsContext.jsx';
import RosterSuggestionsSection, { RosterPerformanceSection } from './RosterSuggestionsSection.jsx';

function CadenceSimulator({ ows }) {
    const [staff, setStaff] = useState('');
    const [overhead, setOverhead] = useState('0');
    const [maxDays, setMaxDays] = useState('');

    const opts = useMemo(() => ({
        staff: staff !== '' ? Number(staff) : undefined,
        overhead_hours_per_order_day: overhead !== '' ? Number(overhead) : 0,
        max_days: maxDays !== '' ? Number(maxDays) : undefined,
    }), [staff, overhead, maxDays]);

    const sim = useMemo(() => simulateOrderCadence(ows, opts), [ows, opts]);

    if (!sim || !sim.ok) {
        const have = (sim?.baseline?.sample_days) || (ows?.order_days || 0);
        return (
            <div style={{ fontSize: '0.75rem', color: '#b0b0b0', padding: '8px 0' }}>
                NOT ENOUGH ARCHIVED ORDER DAYS YET TO SIMULATE (have {have}). Finish a few order clocks and this fills in.
            </div>
        );
    }

    const b = sim.baseline;
    const best = sim.best;

    const fmtDelta = (s) => {
        if (s.is_current) return <span className="pill">CURRENT</span>;
        const up = s.delta_pph > 0;
        const flat = s.delta_pph === 0;
        const color = flat ? 'var(--text)' : (up ? 'var(--ok,#27e0a0)' : 'var(--urgent,#ff5a5a)');
        const sign = s.delta_pph_pct > 0 ? '+' : '';
        return <span style={{ color, fontWeight: 700 }}>{sign}{s.delta_pph_pct}%</span>;
    };

    const pphs = sim.scenarios.map((s) => s.effective_pph);
    const minP = Math.min(...pphs);
    const maxP = Math.max(...pphs);
    const range = maxP - minP;

    return (
        <>
            {best ? (
                best.is_current ? (
                    <div style={{ border: '1px solid var(--ok,#27e0a0)', background: 'rgba(39,224,160,0.08)', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: '0.8rem', color: 'var(--white)' }}>
                        ✓ <b>Your current cadence ({best.days_per_week}/wk) is already the most efficient</b> in this range — at the assumptions above, adding order days wouldn&apos;t lift effective PPH.
                    </div>
                ) : (
                    <div style={{ border: '1px solid var(--accent,#5aa0ff)', background: 'rgba(90,160,255,0.08)', borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: '0.8rem', color: 'var(--white)' }}>
                        ▲ <b>Best in this sweep: {best.days_per_week} order days/week</b> → effective {best.effective_pph.toFixed(1)} PPH
                        ({best.delta_pph >= 0 ? '+' : ''}{best.delta_pph_pct}% vs current {sim.current?.days_per_week}/wk)
                    </div>
                )
            ) : null}
            <div style={{ fontSize: '0.72rem', color: '#9aa', textTransform: 'none', marginBottom: 10 }}>
                Holds your weekly volume (~<b>{b.weekly_pieces}</b> pieces, from {b.avg_pieces}/day × {b.days_per_week} order days),
                work rate (<b>{b.rate_pp_hour}</b> pieces / productive person-hour, break-adjusted) and staff/day constant.
                Sample: {b.sample_days} order days / {b.window_days}d.
            </div>
            <div style={{ margin: '4px 0 12px' }}>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 120, padding: '6px 4px', borderBottom: '1px solid #2a3142' }}>
                    {sim.scenarios.map((s) => {
                        const h = range > 0 ? Math.round(28 + (72 * (s.effective_pph - minP)) / range) : 60;
                        const isBest = best && s.days_per_week === best.days_per_week;
                        const barColor = s.is_current ? 'var(--accent,#5aa0ff)' : (isBest ? 'var(--ok,#27e0a0)' : '#46506a');
                        return (
                            <div key={s.days_per_week} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%', minWidth: 34 }}>
                                <div style={{ fontSize: '0.6rem', color: '#cdd', marginBottom: 2 }}>{s.effective_pph.toFixed(1)}</div>
                                <div title={`${s.days_per_week}/wk · ${s.effective_pph.toFixed(1)} PPH`} style={{ width: '62%', height: `${h}%`, background: barColor, borderRadius: '4px 4px 0 0' }} />
                                <div style={{ fontSize: '0.6rem', color: '#9aa', marginTop: 4 }}>{s.days_per_week}{s.is_current ? '*' : ''}</div>
                            </div>
                        );
                    })}
                </div>
            </div>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
                <label style={{ fontSize: '0.68rem', color: '#9aa' }}>
                    STAFF / ORDER DAY
                    <input id="cad-staff" type="number" min={1} max={30} step={1} value={staff || Math.round(b.avg_staff)} onChange={(e) => setStaff(e.target.value)} style={{ display: 'block', width: 90, marginTop: 3, background: '#0d1017', border: '1px solid #2a3142', color: 'var(--white)', padding: 5, borderRadius: 6 }} />
                </label>
                <label style={{ fontSize: '0.68rem', color: '#9aa' }}>
                    SETUP HRS / ORDER DAY
                    <input id="cad-overhead" type="number" min={0} max={20} step={0.5} value={overhead} onChange={(e) => setOverhead(e.target.value)} style={{ display: 'block', width: 90, marginTop: 3, background: '#0d1017', border: '1px solid #2a3142', color: 'var(--white)', padding: 5, borderRadius: 6 }} />
                </label>
                <label style={{ fontSize: '0.68rem', color: '#9aa' }}>
                    MAX ORDER DAYS / WK
                    <input id="cad-maxdays" type="number" min={1} max={7} step={1} value={maxDays || (b.days_per_week + 3)} onChange={(e) => setMaxDays(e.target.value)} style={{ display: 'block', width: 90, marginTop: 3, background: '#0d1017', border: '1px solid #2a3142', color: 'var(--white)', padding: 5, borderRadius: 6 }} />
                </label>
            </div>
            <div className="tbl-wrap">
                <table>
                    <tbody>
                        <tr><th>ORDER DAYS</th><th>PIECES/DAY</th><th>ORDER LENGTH</th><th>BREAK/PERSON</th><th>WEEKLY LABOR (P-HRS)</th><th>EFFECTIVE PPH</th><th>Δ vs CURRENT</th></tr>
                        {sim.scenarios.map((s) => (
                            <tr key={s.days_per_week} style={s.is_current ? { background: 'rgba(120,180,255,0.08)' } : undefined}>
                                <td style={{ fontWeight: 700, color: 'var(--white)' }}>{s.days_per_week}/wk</td>
                                <td>{s.pieces_per_day}</td>
                                <td>{mins(s.day_length_mins)}</td>
                                <td>{s.break_per_person_hours.toFixed(2)}h</td>
                                <td>{s.weekly_clock_person_hours}</td>
                                <td><span className="pill">{s.effective_pph.toFixed(1)}</span></td>
                                <td>{fmtDelta(s)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

function OrderHistoryRow({ row, reportDate, orderToday, onSave, onMoveClock, onDelete }) {
    const { api } = useReportsContext();
    const [draft, setDraft] = useState({
        orderStart: isoToDatetimeLocal(row.order_start),
        orderEnd: isoToDatetimeLocal(row.order_end),
        staffCount: row.staff_count || 1,
        roster: Array.isArray(row.staff_roster) && row.staff_roster.length ? row.staff_roster.join(', ') : '',
        totalPieces: row.total_pieces || 0,
        exceptionReason: row.exception_reason || '',
    });
    const [busy, setBusy] = useState(false);

    const teamPph = Number(row.team_pph || row.actual_pieces_per_hour || 0);
    const adjPerson = Number(row.adjusted_per_person_pph || 0);
    const staff = Number(row.staff_count || 1);
    const storeMins = Number(row.actual_order_minutes || 0);
    const rawMins = Number(row.raw_clock_minutes || 0);
    const spansDay = Number(row.spans_calendar_day || 0) === 1;
    const durationLabel = storeMins ? mins(storeMins) : orderDurationMin(row.order_start, row.order_end);
    const pieceHint = `G ${Number(row.grocery_pieces || 0)} · F ${Number(row.frozen_pieces || 0)} · H ${Number(row.hardware_pieces || 0)}`;
    const staffWarn = staff <= 1 && adjPerson > teamPph;

    const handleRosterChange = (value) => {
        const next = { ...draft, roster: value };
        const synced = api.syncStaffCountFromRoster(value);
        if (synced) next.staffCount = synced;
        setDraft(next);
    };

    const run = async (fn) => {
        setBusy(true);
        try { await fn(); } finally { setBusy(false); }
    };

    return (
        <tr data-store-date={row.store_date} style={staffWarn ? { background: 'rgba(255,170,0,0.12)' } : undefined} title={staffWarn ? 'Staff is 1 — break-adjusted rate can exceed team PPH. Add order crew names and SAVE.' : undefined}>
            <td style={{ fontWeight: 700, color: 'var(--white)', whiteSpace: 'nowrap' }}>
                {row.store_date}
                {spansDay ? <span className="pill" style={{ fontSize: '0.58rem', marginLeft: 4 }}>X-DAY</span> : null}
            </td>
            <td><input className="hist-input hist-input-time hist-order-start" type="datetime-local" value={draft.orderStart} onChange={(e) => setDraft({ ...draft, orderStart: e.target.value })} /></td>
            <td><input className="hist-input hist-input-time hist-order-end" type="datetime-local" value={draft.orderEnd} onChange={(e) => setDraft({ ...draft, orderEnd: e.target.value })} /></td>
            <td>
                <span className="pill">{durationLabel}</span>
                {(spansDay || (rawMins > storeMins && storeMins > 0)) ? (
                    <div className="order-history-detail">
                        {spansDay ? 'Cross-day' : ''}
                        {spansDay && rawMins > storeMins ? ' · ' : ''}
                        {rawMins > storeMins ? `Clock ${mins(rawMins)}` : ''}
                    </div>
                ) : null}
            </td>
            <td><input className="hist-input hist-input-staff hist-staff-count" type="number" min={1} max={99} value={draft.staffCount} onChange={(e) => setDraft({ ...draft, staffCount: e.target.value })} title="Head count on order" /></td>
            <td><input className="hist-input hist-input-roster hist-staff-roster" type="text" value={draft.roster} placeholder="Name1, Name2, Name3" title="Comma-separated order crew — SAVE updates head count from names" onChange={(e) => handleRosterChange(e.target.value)} /></td>
            <td>
                <input className="hist-input hist-input-pieces hist-total-pieces" type="number" min={0} max={99999} value={draft.totalPieces} title={pieceHint} onChange={(e) => setDraft({ ...draft, totalPieces: e.target.value })} />
                <div className="piece-hint">{pieceHint}</div>
            </td>
            <td>
                <div className="pph-stack">
                    <strong>{teamPph.toFixed(1)}</strong>
                    <span>team · {adjPerson.toFixed(1)} adj/person</span>
                </div>
            </td>
            <td><input className="hist-input hist-input-note hist-exception-reason" type="text" maxLength={200} value={draft.exceptionReason} placeholder="—" onChange={(e) => setDraft({ ...draft, exceptionReason: e.target.value })} /></td>
            <td>
                <div className="order-history-actions">
                    <button type="button" className="btn ok" disabled={busy} onClick={() => run(() => onSave(draft))}>SAVE</button>
                    {(row.store_date === reportDate && orderToday.start && orderToday.end) ? (
                        <button type="button" className="btn warn" disabled={busy} onClick={() => run(onMoveClock)}>MOVE CLOCK</button>
                    ) : null}
                    <button type="button" className="btn warn" disabled={busy} onClick={() => run(onDelete)}>DEL</button>
                </div>
                <div className="order-history-detail">Archived {fmtIso(row.recorded_at)}</div>
            </td>
        </tr>
    );
}

export default function OrderLearnSection({ data }) {
    const { runAction, api } = useReportsContext();
    const meta = data.meta || {};
    const rd = meta.reportDate || data.today;
    const ot = data.order_today || { start: '', end: '' };
    const osh = data.order_shift_history || [];
    const ows = data.order_weekly_scorecard || {};
    const om = data.order_metrics || {};
    const omArchiveMissing = om.archive_missing;

    const handleSave = (row) => async (draft) => {
        const roster = draft.roster.split(/[,;|]/).map((n) => n.trim()).filter(Boolean);
        const staffFromRoster = api.syncStaffCountFromRoster(draft.roster);
        await api.saveOrderHistoryCorrection({
            storeDate: row.store_date,
            totalPieces: draft.totalPieces,
            staffCount: staffFromRoster || draft.staffCount,
            staffRoster: roster,
            orderStart: draft.orderStart,
            orderEnd: draft.orderEnd,
            exceptionReason: draft.exceptionReason,
        });
    };

    const overall = ows.overall;
    const byDay = ows.by_weekday || [];
    const card = (label, val, sub) => (
        <div className="sum-card ok">
            <div className="sum-label">{label}</div>
            <div className="sum-val" style={{ fontSize: '1.35rem' }}>{val}</div>
            {sub ? <div className="sum-sub">{sub}</div> : null}
        </div>
    );

    return (
        <div className="section" id="sec-orders-learn">
            <div className="section-title">ORDER HISTORY &amp; SCORECARD</div>
            {omArchiveMissing ? (
                <p style={{ fontSize: '0.75rem', color: '#888', textTransform: 'none', marginBottom: 10 }}>
                    Archive gaps for this report date — correct rows below after FINISH runs.
                </p>
            ) : null}
            <div className="tbl-wrap">
                <table className="order-history-table">
                    <tbody>
                        <tr><th>DATE</th><th>START</th><th>END</th><th>DUR</th><th>#</th><th>ORDER CREW</th><th>PCS</th><th>PPH</th><th>DAY NOTE</th><th>ACTIONS</th></tr>
                        {osh.length ? osh.map((r) => (
                            <OrderHistoryRow
                                key={r.store_date}
                                row={r}
                                reportDate={rd}
                                orderToday={ot}
                                onSave={(draft) => runAction(() => handleSave(r)(draft))}
                                onMoveClock={() => api.attachLiveClockToHistory(r.store_date)}
                                onDelete={() => api.deleteOrderHistoryRow(r.store_date)}
                            />
                        )) : (
                            <tr><td colSpan={10} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO ARCHIVED ORDER TIMES YET</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
            <p style={{ fontSize: '0.68rem', color: '#b0b0b0', marginTop: 8, textTransform: 'none' }}>
                Edit order crew names to compare teams in the roster rollup below. Piece breakdown (G/F/H) shows under PCS. PPH recalculates on SAVE.
            </p>
            <RosterSuggestionsSection data={data} />
            <RosterPerformanceSection data={data} />
            {overall && ows.order_days ? (
                <div style={{ marginTop: 18 }}>
                    <div className="section-title" style={{ marginBottom: 10 }}>WEEKLY ORDER SCORECARD — LAST {ows.window_days || 90} DAYS</div>
                    <div className="summary-grid" style={{ marginBottom: 12 }}>
                        {card('ORDER DAYS', ows.order_days, 'FINISH / CLOSED CLOCK ONLY')}
                        {card('AVG PIECES', overall.avg_pieces, 'PER ORDER DAY')}
                        {card('AVG DURATION', overall.avg_minutes ? mins(Math.round(overall.avg_minutes)) : '—', 'PER ORDER DAY')}
                        {card('AVG STAFF', overall.avg_staff, 'AT FINISH')}
                        {card('AVG TEAM PPH', Number(overall.avg_team_pph || 0).toFixed(1), 'TEAM RATE')}
                        {card('AVG ADJ/PERSON', Number(overall.avg_adj_pph || 0).toFixed(1), 'BREAK-ADJUSTED')}
                    </div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>WEEKDAY</th><th>ORDER DAYS</th><th>AVG PIECES</th><th>AVG DURATION</th><th>AVG STAFF</th><th>AVG TEAM PPH</th><th>AVG ADJ/PERSON</th></tr>
                                {byDay.length ? byDay.map((row) => (
                                    <tr key={row.weekday}>
                                        <td style={{ fontWeight: 700, color: 'var(--white)' }}>{row.weekday}</td>
                                        <td>{row.order_days}</td>
                                        <td>{row.avg_pieces ?? '—'}</td>
                                        <td>{row.avg_minutes ? mins(Math.round(row.avg_minutes)) : '—'}</td>
                                        <td>{row.avg_staff ?? '—'}</td>
                                        <td>{row.avg_team_pph != null ? Number(row.avg_team_pph).toFixed(1) : '—'}</td>
                                        <td>{row.avg_adj_pph != null ? Number(row.avg_adj_pph).toFixed(1) : '—'}</td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={7} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO WEEKDAY PATTERN YET</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : (
                <div style={{ marginTop: 14, fontSize: '0.75rem', color: '#b0b0b0' }}>WEEKLY SCORECARD — NEED AT LEAST ONE ARCHIVED ORDER DAY</div>
            )}
            {ows.overall ? (
                <div style={{ marginTop: 18 }}>
                    <div className="section-title" style={{ marginBottom: 4 }}>ORDER CADENCE SIMULATOR</div>
                    <div id="cadence-sim-out"><CadenceSimulator ows={ows} /></div>
                </div>
            ) : null}
        </div>
    );
}
