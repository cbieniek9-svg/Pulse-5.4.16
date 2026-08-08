import { fmtIso, mins } from '../lib/format.jsx';
import { groupByField, rangeLabelFromMeta, isMultiDay } from '../lib/reportHelpers.js';
import { useReportsContext } from '../context/ReportsContext.jsx';
import { SafetyFocusSection } from './DailyDirectionSection.jsx';
import DeliveriesSection, { ColdChainSection, SafetyInspectionsSection } from './DeliveriesSection.jsx';

function renderStaffShifts(staffShifts, multiDay) {
    if (!staffShifts.length) {
        return (
            <tr><td colSpan={7} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO STAFF SCHEDULE IMPORTED FOR THIS RANGE</td></tr>
        );
    }
    const row = (r) => (
        <tr key={`${r.shift_date}-${r.staff_name}-${r.start_time}`}>
            <td>{r.shift_date || ''}</td>
            <td style={{ color: 'var(--white)', fontWeight: 700 }}>{r.staff_name}</td>
            <td>{r.start_time || ''}</td>
            <td>{r.end_time || ''}</td>
            <td>{r.role || ''}</td>
            <td>{r.department || ''}</td>
            <td style={{ fontSize: '0.75rem', color: 'var(--text)' }}>{r.notes || ''}</td>
        </tr>
    );
    if (!multiDay) return staffShifts.map(row);
    return groupByField(staffShifts, 'shift_date').flatMap((g) => [
        <tr key={`div-${g.key}`} className="day-divider"><td colSpan={7}>— {g.key} —</td></tr>,
        ...g.rows.map(row),
    ]);
}

function renderCompletedTasks(completedTasks, multiDay) {
    if (!completedTasks.length) {
        return (
            <tr><td colSpan={6} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO TASKS COMPLETED FOR THIS RANGE</td></tr>
        );
    }
    const rowHtml = (t) => (
        <tr key={`${t.time_closed}-${t.task_detail}`}>
            <td style={{ fontSize: '0.72rem', color: 'var(--text)' }}>{fmtIso(t.time_closed)}</td>
            <td style={{ color: 'var(--white)' }}>{t.task_detail}</td>
            <td>{t.zone}</td>
            <td>{t.closed_by || t.assigned_to || ''}</td>
            <td>{t.est_mins || 0}m</td>
            <td><span className="pill">{mins(t.actual_mins || 0)}</span></td>
        </tr>
    );
    if (!multiDay) return completedTasks.map(rowHtml);
    return groupByField(completedTasks, 'closed_date').flatMap((g) => [
        <tr key={`div-${g.key}`} className="day-divider"><td colSpan={6}>— {g.key} ({g.rows.length} TASKS) —</td></tr>,
        ...g.rows.map(rowHtml),
    ]);
}

export default function HandoffPanel({ data }) {
    const { reportMode } = useReportsContext();
    const meta = data.meta || {};
    const rd = meta.reportDate || data.today;
    const rangeLabel = rangeLabelFromMeta(data);
    const multiDay = isMultiDay(data);
    const s = data.shift || {};
    const tZone = data.task_closed_by_zone || [];
    const tPri = data.task_closed_by_priority || [];
    const tOpenZ = data.tasks_open_by_zone || [];
    const completedTasks = data.completed_tasks || [];
    const customerOrders = data.customer_orders || [];
    const staffShifts = data.staff_shifts || [];
    const finishRoster = data.order_finish_roster || [];
    const handoff = data.comms_handoff;

    return (
        <div className={`report-mode-panel${reportMode === 'handoff' ? ' active' : ''}`} data-mode="handoff">
            <p className="mode-panel-intro">End-of-shift continuity — summary, comms archive, staff, receiving. Use Print Handoff for documentation.</p>

            <div className="section" id="sec-summary">
                <div className="section-title">SHIFT SUMMARY — {rangeLabel}</div>
                <div className="summary-grid">
                    <div className="sum-card ok"><div className="sum-label">TASKS COMPLETED</div><div className="sum-val">{s.tasks_completed}</div><div className="sum-sub">{s.tasks_open} STILL OPEN</div></div>
                    <div className={`sum-card ${s.oos_logged > 0 ? 'warn' : 'ok'}`}><div className="sum-label">OOS LOGGED</div><div className="sum-val">{s.oos_logged}</div><div className="sum-sub">{s.oos_cleared} CLEARED</div></div>
                    <div className="sum-card purple"><div className="sum-label">SPECIAL ORDERS</div><div className="sum-val">{s.orders_filled}</div><div className="sum-sub">{s.orders_open} STILL OPEN</div></div>
                    <div className="sum-card ok"><div className="sum-label">VENDORS IN</div><div className="sum-val">{s.vendors_received}</div><div className="sum-sub">{s.vendors_pending} PENDING</div></div>
                    <div className={`sum-card ${s.kill_dates_due > 0 ? 'urgent' : 'ok'}`}><div className="sum-label">PULLS DUE</div><div className="sum-val">{s.kill_dates_due}</div><div className="sum-sub">ACTIVE KILL DATES</div></div>
                    <div className="sum-card ok"><div className="sum-label">SHIFT LEAD</div><div className="sum-val" style={{ fontSize: '1rem', textTransform: 'none' }}>{data.shift_lead || '—'}</div><div className="sum-sub">ACTIVE PREMIUM / SHIFT LEAD</div></div>
                </div>
            </div>

            <SafetyFocusSection data={data} />

            {finishRoster.length ? (
                <div className="section" id="sec-order-roster">
                    <div className="section-title">ORDER CREW (FINISH) — {rd}</div>
                    <p style={{ fontSize: '0.78rem', color: 'var(--white)', textTransform: 'none', margin: 0 }}>{finishRoster.join(' · ')}</p>
                </div>
            ) : null}

            {handoff && Array.isArray(handoff.messages) && handoff.messages.length ? (
                <div className="section" id="sec-comms">
                    <div className="section-title">COMMS HANDOFF — EOD ARCHIVE ({handoff.store_date || rd})</div>
                    <p style={{ fontSize: '0.78rem', color: '#888', margin: '0 0 12px', textTransform: 'none' }}>
                        Messages archived at {fmtIso(handoff.archived_at)} when the store day rolled.
                    </p>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>LANE</th><th>PRIORITY</th><th>SOURCE</th><th>BY</th><th>POSTED</th><th>BODY</th></tr>
                                {handoff.messages.map((m, i) => (
                                    <tr key={i}>
                                        <td>{m.lane || ''}</td>
                                        <td>{m.priority || ''}</td>
                                        <td>{m.source || ''}</td>
                                        <td>{m.posted_by || ''}</td>
                                        <td style={{ fontSize: '0.72rem' }}>{fmtIso(m.posted_at)}</td>
                                        <td>{m.body || ''}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : null}

            <div className="section" id="sec-staff">
                <div className="section-title">STAFF ON SHIFT — {rangeLabel}</div>
                <div className="tbl-wrap">
                    <table>
                        <tbody>
                            <tr><th>DATE</th><th>NAME</th><th>START</th><th>END</th><th>ROLE</th><th>DEPT</th><th>NOTES</th></tr>
                            {renderStaffShifts(staffShifts, multiDay)}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="section" id="sec-tasks">
                <div className="section-title">TASKS — {rangeLabel}</div>
                <div className="section" style={{ marginBottom: 0 }}>
                    <div className="section-title">TASK LEADERBOARD</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>#</th><th>TEAM MEMBER</th><th>TASKS COMPLETED</th></tr>
                                {data.task_leaderboard?.length ? data.task_leaderboard.map((r, i) => {
                                    const top = i < 3 && r.count > 0;
                                    return (
                                        <tr key={r.name} className={top ? 'leader-top' : (r.count === 0 ? 'leader-zero' : '')}>
                                            <td className="rank">{top ? (i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉') : i + 1}</td>
                                            <td>{r.name}</td>
                                            <td><span className="pill">{r.count}</span></td>
                                        </tr>
                                    );
                                }) : (
                                    <tr><td colSpan={3} style={{ color: '#444', textAlign: 'center', padding: 20 }}>NO DATA YET</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 14, marginTop: 16 }}>
                    <div className="tbl-wrap">
                        <table>
                            <caption style={{ captionSide: 'top', textAlign: 'left', padding: '0 0 8px 4px', fontSize: '0.7rem', color: 'var(--accent)', letterSpacing: 1 }}>CLOSED BY ZONE</caption>
                            <tbody>
                                <tr><th>ZONE</th><th>COUNT</th></tr>
                                {tZone.length ? tZone.map((r) => (
                                    <tr key={r.zone}><td>{r.zone}</td><td><span className="pill">{r.cnt}</span></td></tr>
                                )) : <tr><td colSpan={2} style={{ color: '#444' }}>NONE</td></tr>}
                            </tbody>
                        </table>
                    </div>
                    <div className="tbl-wrap">
                        <table>
                            <caption style={{ captionSide: 'top', textAlign: 'left', padding: '0 0 8px 4px', fontSize: '0.7rem', color: 'var(--accent)', letterSpacing: 1 }}>CLOSED BY PRIORITY</caption>
                            <tbody>
                                <tr><th>PRIORITY</th><th>COUNT</th></tr>
                                {tPri.length ? tPri.map((r) => (
                                    <tr key={r.priority}><td>{r.priority}</td><td><span className="pill">{r.cnt}</span></td></tr>
                                )) : <tr><td colSpan={2} style={{ color: '#444' }}>NONE</td></tr>}
                            </tbody>
                        </table>
                    </div>
                    <div className="tbl-wrap">
                        <table>
                            <caption style={{ captionSide: 'top', textAlign: 'left', padding: '0 0 8px 4px', fontSize: '0.7rem', color: 'var(--accent)', letterSpacing: 1 }}>OPEN BY ZONE</caption>
                            <tbody>
                                <tr><th>ZONE</th><th>OPEN</th></tr>
                                {tOpenZ.length ? tOpenZ.map((r) => (
                                    <tr key={r.zone}><td>{r.zone}</td><td><span className="pill">{r.cnt}</span></td></tr>
                                )) : <tr><td colSpan={2} style={{ color: '#444' }}>NONE</td></tr>}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <details className="handoff-details section">
                <summary>COMPLETED TASK DETAIL ({completedTasks.length} TASKS)</summary>
                <div className="tbl-wrap">
                    <table>
                        <tbody>
                            <tr><th>CLOSED</th><th>TASK</th><th>ZONE</th><th>BY</th><th>EST</th><th>ACTUAL</th></tr>
                            {renderCompletedTasks(completedTasks, multiDay)}
                        </tbody>
                    </table>
                </div>
            </details>

            <div className="section" id="sec-customer-orders">
                <div className="section-title">CUSTOMER ORDERS — {rangeLabel}</div>
                <div className="tbl-wrap">
                    <table>
                        <tbody>
                            <tr><th>STATUS</th><th>CUSTOMER</th><th>ITEM</th><th>LOCATION</th><th>CONTACT</th><th>LOGGED</th><th>CLOSED</th><th>AGE</th></tr>
                            {customerOrders.length ? customerOrders.map((o, i) => (
                                <tr key={i}>
                                    <td><span className="pill">{o.status}</span></td>
                                    <td style={{ color: 'var(--white)', fontWeight: 700 }}>{o.customer}</td>
                                    <td>{o.item}</td>
                                    <td>{o.location}</td>
                                    <td>{o.contact}</td>
                                    <td style={{ fontSize: '0.72rem', color: 'var(--text)' }}>{fmtIso(o.time_logged)}</td>
                                    <td style={{ fontSize: '0.72rem', color: 'var(--text)' }}>{fmtIso(o.time_closed)}</td>
                                    <td>{mins(o.age_mins || 0)}</td>
                                </tr>
                            )) : (
                                <tr><td colSpan={8} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO CUSTOMER ORDERS FOUND</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <div className="section" id="sec-receiving">
                <div className="section-title">RECEIVING PERFORMANCE — BY VENDOR</div>
                <div className="tbl-wrap">
                    <table>
                        <tbody>
                            <tr><th>VENDOR</th><th>RUNS</th><th>AVG TIME</th><th>BEST</th><th>WORST</th><th>LAST ARRIVAL</th></tr>
                            {data.receiving_by_vendor?.length ? data.receiving_by_vendor.map((r) => (
                                <tr key={r.vendor}>
                                    <td style={{ color: 'var(--white)', fontWeight: 700 }}>{r.vendor}</td>
                                    <td>{r.runs}</td>
                                    <td>{mins(r.avg_mins)}</td>
                                    <td style={{ color: 'var(--ok)' }}>{mins(r.best_mins)}</td>
                                    <td style={{ color: 'var(--warn)' }}>{mins(r.worst_mins)}</td>
                                    <td style={{ fontSize: '0.75rem', color: 'var(--text)' }}>{r.last_arrival ? new Date(r.last_arrival).toLocaleDateString() : '—'}</td>
                                </tr>
                            )) : (
                                <tr><td colSpan={6} style={{ color: '#444', textAlign: 'center', padding: 20 }}>NO RECEIVING DATA YET</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="two-col">
                    <div className="section">
                        <div className="section-title">RECEIVING — BY TEAM MEMBER</div>
                        <div className="tbl-wrap">
                            <table>
                                <tbody>
                                    <tr><th>#</th><th>TEAM MEMBER</th><th>RUNS</th><th>AVG</th><th>BEST</th></tr>
                                    {data.receiving_by_person?.length ? data.receiving_by_person.map((r, i) => (
                                        <tr key={r.processed_by}>
                                            <td className="rank">{i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td>
                                            <td>{r.processed_by}</td>
                                            <td>{r.runs}</td>
                                            <td>{mins(r.avg_mins)}</td>
                                            <td style={{ color: 'var(--ok)' }}>{mins(r.best_mins)}</td>
                                        </tr>
                                    )) : (
                                        <tr><td colSpan={5} style={{ color: '#444', textAlign: 'center', padding: 20 }}>NO DATA YET</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

            <ColdChainSection data={data} rangeLabel={rangeLabel} />
            <SafetyInspectionsSection data={data} rangeLabel={rangeLabel} />

            <div className="section" id="sec-receiving-recent">
                <div className="section-title">RECENT RECEIVING RUNS</div>
                <div className="tbl-wrap">
                    <table>
                        <tbody>
                            <tr><th>VENDOR</th><th>BY</th><th>TIME</th><th>DATE</th></tr>
                            {(data.receiving_recent || []).slice(0, 15).length ? (data.receiving_recent || []).slice(0, 15).map((r, i) => (
                                <tr key={i}>
                                    <td>{r.vendor}</td>
                                    <td style={{ color: 'var(--text)' }}>{r.processed_by}</td>
                                    <td><span className="pill">{mins(r.duration_mins)}</span></td>
                                    <td style={{ fontSize: '0.72rem', color: 'var(--text)' }}>{r.arrival_time ? new Date(r.arrival_time).toLocaleDateString() : '—'}</td>
                                </tr>
                            )) : (
                                <tr><td colSpan={4} style={{ color: '#444', textAlign: 'center', padding: 20 }}>NO RECENT RUNS</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            <DeliveriesSection data={data} rangeLabel={rangeLabel} />
        </div>
    );
}
