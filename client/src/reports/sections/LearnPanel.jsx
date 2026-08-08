import { fmtDate, Score, fmtIso, mins } from '../lib/format.jsx';
import { groupByField, rangeLabelFromMeta } from '../lib/reportHelpers.js';
import { useReportsContext } from '../context/ReportsContext.jsx';
import {
    ActionLogsSection,
    ExceptionRollupSection,
    FinishHealthSection,
    StaffCountCurveSection,
    TaskPlanningSection,
} from './LearnMetricsSections.jsx';
import TrendsSection from './LearnMetricsSections.jsx';
import OrderLearnSection from './OrderLearnSection.jsx';
import FloorShrinkSection from './FloorShrinkSection.jsx';

export default function LearnPanel({ data }) {
    const { reportMode } = useReportsContext();
    const meta = data.meta || {};
    const rd = meta.reportDate || data.today;
    const rangeLabel = rangeLabelFromMeta(data);
    const markdownRecords = data.markdown_records || [];
    const oosCompare = data.oos_daily_comparison || {};
    const oos30 = data.oos_hotspots_30d || [];

    return (
        <div className={`report-mode-panel${reportMode === 'learn' ? ' active' : ''}`} data-mode="learn">
            <p className="mode-panel-intro">Weekly improvement — planning, archive trust, trends, and strategic tools. Not for opening huddle.</p>
            <TaskPlanningSection data={data} rangeLabel={rangeLabel} />
            <FinishHealthSection data={data} />
            <OrderLearnSection data={data} />
            <ExceptionRollupSection data={data} />
            <StaffCountCurveSection data={data} />
            <ActionLogsSection data={data} />
            <TrendsSection data={data} />
            <FloorShrinkSection data={data} />

            {data.presence_summary?.enabled ? (
                <div className="section" id="sec-presence">
                    <div className="section-title">BLE PRESENCE — {(data.presence_summary.asset_mode || 'staff').toUpperCase()}</div>
                    <p style={{ fontSize: '0.75rem', color: '#888', textTransform: 'none', marginBottom: 8 }}>{data.presence_summary.disclaimer || ''}</p>
                    <p style={{ fontSize: '0.72rem', color: '#69c', textTransform: 'none', marginBottom: 10 }}>{data.presence_summary.architecture_note || ''}</p>
                    <div className="summary-grid" style={{ marginBottom: 10 }}>
                        <div className={`sum-card ${data.presence_summary.latest_snapshot ? 'ok' : 'warn'}`}>
                            <div className="sum-label">FINISH SNAPSHOT</div>
                            <div className="sum-val" style={{ fontSize: '1.1rem' }}>{data.presence_summary.latest_snapshot ? (data.presence_summary.latest_snapshot.inferred_staff ?? '—') : '—'}</div>
                            <div className="sum-sub">{data.presence_summary.latest_snapshot?.asset_mode ? data.presence_summary.latest_snapshot.asset_mode.toUpperCase() : 'AT RECEIVING'}</div>
                        </div>
                        <div className="sum-card">
                            <div className="sum-label">LIVE (NOW)</div>
                            <div className="sum-val" style={{ fontSize: '1.1rem' }}>{data.presence_summary.live_board?.order_hint ? data.presence_summary.live_board.order_hint.beacon_count : '—'}</div>
                            <div className="sum-sub">{data.presence_summary.live_board?.order_hint?.count_label || 'ORDER ZONE'}</div>
                        </div>
                        <div className={`sum-card ${(data.presence_summary.live_board?.alerts?.offline_count || 0) ? 'warn' : 'ok'}`}>
                            <div className="sum-label">OFFLINE GW</div>
                            <div className="sum-val" style={{ fontSize: '1.1rem' }}>{data.presence_summary.live_board?.alerts?.offline_count ?? 0}</div>
                            <div className="sum-sub">HUB + AISLE + CORNER</div>
                        </div>
                    </div>
                    {(data.presence_summary.zone_occupancy || data.presence_summary.live_board?.analytics?.zone_occupancy || []).length ? (
                        <div style={{ marginBottom: 10 }}>
                            {(data.presence_summary.zone_occupancy || data.presence_summary.live_board?.analytics?.zone_occupancy || []).map((z, i) => (
                                <span key={i} className="chip">{z.zone_key}: {z.count}</span>
                            ))}
                        </div>
                    ) : null}
                </div>
            ) : null}

            <div className="section" id="sec-oos">
                <div className="section-title">OOS TRENDS &amp; RECURRING HOTSPOTS</div>
                <div className="two-col">
                    <div>
                        <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>DAY COMPARISON — {rd}</div>
                        <div className="summary-grid">
                            <div className={`sum-card ${Number(oosCompare.today_holes || 0) > Number(oosCompare.previous_holes || 0) ? 'warn' : 'ok'}`}>
                                <div className="sum-label">TODAY HOLES</div>
                                <div className="sum-val">{oosCompare.today_holes || 0}</div>
                                <div className="sum-sub">{oosCompare.today_incidents || 0} INCIDENTS</div>
                            </div>
                            <div className="sum-card">
                                <div className="sum-label">PREVIOUS ({fmtDate(oosCompare.previous_date)})</div>
                                <div className="sum-val">{oosCompare.previous_holes || 0}</div>
                                <div className="sum-sub">{oosCompare.previous_incidents || 0} INCIDENTS</div>
                            </div>
                            <div className="sum-card purple">
                                <div className="sum-label">DIFFERENCE</div>
                                <div className="sum-val">{Number(oosCompare.today_holes || 0) - Number(oosCompare.previous_holes || 0)}</div>
                                <div className="sum-sub">HOLES VS PREVIOUS DAY</div>
                            </div>
                        </div>
                    </div>
                    <div>
                        <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>30-DAY ZONE HOTSPOTS</div>
                        <div className="tbl-wrap">
                            <table>
                                <tbody>
                                    <tr><th>ZONE</th><th>TOTAL HOLES</th><th>INCIDENTS</th></tr>
                                    {oos30.length ? oos30.map((r, i) => (
                                        <tr key={i}>
                                            <td>{r.zone}</td>
                                            <td><span className="pill" style={{ background: 'rgba(255,51,51,0.12)', color: 'var(--urgent)', borderColor: 'rgba(255,51,51,0.3)' }}>{r.total_holes}</span></td>
                                            <td>{r.incidents}</td>
                                        </tr>
                                    )) : (
                                        <tr><td colSpan={3} style={{ color: '#444', textAlign: 'center', padding: 20 }}>NO OOS IN LAST 30 DAYS</td></tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>

            <div className="section" id="sec-markdown">
                <div className="section-title">MARKDOWN / OUT-DATE RECORDS</div>
                <div className="tbl-wrap">
                    <table>
                        <tbody>
                            <tr><th>ITEM</th><th>CODE</th><th>ZONE</th><th>OUT DATE</th><th>STATUS</th><th>DAYS</th><th>CLOSED BY</th></tr>
                            {markdownRecords.length ? markdownRecords.map((k, i) => (
                                <tr key={i}>
                                    <td style={{ color: 'var(--white)', fontWeight: 700 }}>{k.item}</td>
                                    <td>{k.item_code || ''}</td>
                                    <td>{k.zone || ''}</td>
                                    <td>{fmtDate(k.kill_date)}</td>
                                    <td><span className="pill">{k.status}</span></td>
                                    <td>{k.days_until == null ? '' : k.days_until}</td>
                                    <td>{k.closed_by || ''}</td>
                                </tr>
                            )) : (
                                <tr><td colSpan={7} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO MARKDOWN RECORDS IN THIS WINDOW</td></tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {data.audit_scores?.length ? (
                <div className="section" id="sec-homebase">
                    <div className="section-title">HOMEBASE AUDIT SCORES — {rd}</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>ZONE</th><th>AUDITS</th><th>FRONT EDGE</th><th>TAG INTEGRITY</th><th>HOLE STRATEGY</th><th>CLEARANCES</th><th>OVERALL</th></tr>
                                {data.audit_scores.map((r) => {
                                    const avg = Math.round(((parseInt(r.front_edge || 0, 10) + parseInt(r.tag_integrity || 0, 10) + parseInt(r.hole_strategy || 0, 10) + parseInt(r.clearances || 0, 10)) / 4));
                                    return (
                                        <tr key={r.zone_name}>
                                            <td style={{ color: 'var(--white)', fontWeight: 700 }}>{r.zone_name}</td>
                                            <td>{r.total_audits}</td>
                                            <td><Score value={r.front_edge} /></td>
                                            <td><Score value={r.tag_integrity} /></td>
                                            <td><Score value={r.hole_strategy} /></td>
                                            <td><Score value={r.clearances} /></td>
                                            <td><Score value={avg} /></td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
