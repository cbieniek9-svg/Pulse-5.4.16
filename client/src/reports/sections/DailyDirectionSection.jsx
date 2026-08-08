import { actionInboxCount } from '../lib/reportHelpers.js';
import { useReportsContext } from '../context/ReportsContext.jsx';

export default function DailyDirectionSection({ data }) {
    const dd = data.daily_direction;
    if (!dd) return null;

    const meta = data.meta || {};
    const isHistorical = meta.isLiveToday === false || dd.archived === true || dd.source === 'posted_archive';
    const color = dd.status_color || 'var(--warn)';
    const posted = dd.posted || (dd.posted_at ? { posted_at: dd.posted_at, posted_by: dd.posted_by } : null);
    const inboxN = actionInboxCount(data);
    const wins = (dd.must_wins || []).filter((w) => w.text);
    const updates = dd.shift_updates || [];
    const amend = dd.amendment_suggestion;
    const intro = isHistorical
        ? 'Saved from the manager-posted Daily Direction. The visible direction reflects the latest update; the update history is retained below.'
        : 'System drafts from live data. Manager walks, amends, and posts — not auto-posted.';

    return (
        <div className="section" id="sec-daily-direction">
            <div className="section-title">DAILY DIRECTION{isHistorical ? ' — ARCHIVE' : ''}</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-6px 0 12px', textTransform: 'none' }}>{intro}</p>
            <div className="sum-card warn" style={{ borderLeftColor: color, marginBottom: 12 }}>
                <div className="sum-label">STORE DAY STATUS</div>
                <div className="sum-val" style={{ color, fontSize: '1.6rem' }}>{String(dd.status || 'yellow').toUpperCase()}</div>
                <div className="sum-sub" style={{ textTransform: 'none' }}>
                    {(dd.day_context || {}).weekday || ''}
                    {(dd.day_context || {}).is_order_day ? ' · TGP Order Day' : ''}
                </div>
            </div>
            {posted?.posted_at ? (
                <p style={{ fontSize: '0.75rem', color: 'var(--ok)', textTransform: 'none', margin: '8px 0' }}>
                    Daily Direction posted {String(posted.posted_at).slice(11, 16)} by {posted.posted_by || ''}
                </p>
            ) : (
                <p style={{ fontSize: '0.75rem', color: '#888', textTransform: 'none', margin: '8px 0' }}>
                    Draft — amend and post from Management Hub → Daily Direction.
                </p>
            )}
            {isHistorical ? (
                <p style={{ fontSize: '0.75rem', color: '#888', textTransform: 'none', margin: '0 0 12px' }}>
                    Saved manager-posted Daily Direction for {meta.reportDate || dd.store_date || data.today || ''}. Historical reports show the final visible direction plus the update history, not a regenerated draft.
                </p>
            ) : inboxN ? (
                <p style={{ fontSize: '0.75rem', color: 'var(--warn)', textTransform: 'none', margin: '0 0 12px' }}>
                    <a
                        href="#sec-actions"
                        onClick={(e) => {
                            e.preventDefault();
                            document.getElementById('sec-actions')?.scrollIntoView({ behavior: 'smooth' });
                        }}
                    >
                        {inboxN} operational signal{inboxN === 1 ? '' : 's'} in Action Inbox below
                    </a>
                    {' '}— risks are not duplicated here.
                </p>
            ) : (
                <p style={{ fontSize: '0.75rem', color: 'var(--ok)', textTransform: 'none', margin: '0 0 12px' }}>
                    No urgent operational signals — confirm on walk.
                </p>
            )}
            <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: '0.7rem', letterSpacing: 2, color: 'var(--accent)', marginBottom: 6 }}>MUST-WIN</div>
                <ul style={{ fontSize: '0.78rem', textTransform: 'none', lineHeight: 1.45, paddingLeft: 18, margin: 0 }}>
                    {wins.length ? wins.map((w, i) => <li key={i}>{w.text}</li>) : (
                        <li style={{ opacity: 0.7 }}>Set after walk (Management Hub → Daily Direction)</li>
                    )}
                </ul>
            </div>
            <div style={{ background: 'var(--panel)', padding: 12, borderRadius: 8, fontSize: '0.82rem', textTransform: 'none', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                {dd.floor_message || ''}
            </div>
            {updates.length ? (
                <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: '0.7rem', letterSpacing: 2, color: 'var(--warn)', marginBottom: 6 }}>DAILY DIRECTION UPDATE HISTORY</div>
                    {updates.map((u, i) => (
                        <div key={i} style={{ background: 'rgba(255,170,0,0.08)', borderLeft: '3px solid var(--warn)', padding: 8, marginBottom: 8, fontSize: '0.78rem', textTransform: 'none', whiteSpace: 'pre-wrap' }}>
                            {u.message}
                            <div style={{ fontSize: '0.68rem', opacity: 0.65, marginTop: 4 }}>
                                {String(u.posted_at || '').slice(11, 16)} · {u.posted_by || ''}
                            </div>
                        </div>
                    ))}
                </div>
            ) : null}
            {amend ? (
                <div style={{ background: 'rgba(255,170,0,0.1)', borderLeft: '3px solid var(--warn)', padding: 8, marginTop: 10, fontSize: '0.78rem', textTransform: 'none' }}>
                    <strong>Amendment suggested:</strong> {amend.summary || ''}
                    <div style={{ marginTop: 4, opacity: 0.75 }}>
                        Act from the floor Management Hub → Daily Direction (ignore, dismiss, edit, or post Shift Update).
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export function SafetyFocusSection({ data }) {
    const focus = data.daily_safety_focus || null;
    if (!focus || !focus.message) return null;
    const meta = data.meta || {};
    const label = focus.source === 'manual' ? 'MANAGER-SET' : 'DAILY ROTATION';
    const selected = focus.selected_at ? ` · selected ${new Date(focus.selected_at).toLocaleString()}` : '';

    return (
        <div className="section" id="sec-safety-focus">
            <div className="section-title">DAILY SAFETY FOCUS — {meta.reportDate || focus.store_date || data.today || ''}</div>
            <div className="sum-card warn" style={{ borderLeftColor: 'var(--warn)', marginBottom: 0 }}>
                <div className="sum-label">{label}</div>
                <div className="sum-val" style={{ fontSize: '1.1rem', lineHeight: 1.35, textTransform: 'none' }}>{focus.message}</div>
                <div className="sum-sub" style={{ textTransform: 'none' }}>{focus.selected_by || 'AUTO'}{selected}</div>
            </div>
        </div>
    );
}

export function ActionInboxSection({ data }) {
    const { runAction, api } = useReportsContext();
    const actions = data.report_actions || [];
    const meta = data.meta || {};
    const exportPull = (
        <div style={{ marginBottom: 10 }}>
            <a className="btn" href={api.killDatesExportUrl('print')} target="_blank" rel="noopener">PRINT PULL LIST</a>
            <a className="btn" style={{ marginLeft: 8 }} href={api.killDatesExportUrl('csv')}>CSV PULL + 7 DAY</a>
        </div>
    );

    if (!actions.length) {
        return (
            <div className="section" id="sec-actions">
                <div className="section-title">ACTION INBOX — {meta.reportDate || data.today}</div>
                {exportPull}
                <div className="action-card ok">
                    <span className="action-pri" style={{ color: 'var(--ok)' }}>CLEAR</span>
                    <div className="action-body">
                        <div className="action-title">NO URGENT MANAGER ACTIONS</div>
                        <div className="action-detail">Floor exceptions and operational gaps look clear for this report view.</div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="section" id="sec-actions">
            <div className="section-title">ACTION INBOX — DO THIS NEXT</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-6px 0 12px', textTransform: 'none' }}>
                Same signals as the floor Management Hub — use this at huddle open or shift handoff.
            </p>
            {exportPull}
            <div className="action-inbox">
                {actions.map((a) => {
                    const pri = a.priority === 'urgent' ? 'urgent' : (a.priority === 'warn' ? 'warn' : 'info');
                    const priColor = pri === 'urgent' ? 'var(--urgent)' : (pri === 'warn' ? 'var(--warn)' : 'var(--accent)');
                    return (
                        <div key={a.action_id || a.title} className={`action-card ${pri}`}>
                            <span className="action-pri" style={{ color: priColor }}>{String(a.priority || 'info').toUpperCase()}</span>
                            <div className="action-body">
                                <div className="action-title">{a.title}</div>
                                <div className="action-detail">{a.detail}</div>
                                {a.meta ? <div className="action-meta">{a.meta}</div> : null}
                                {a.dismissible !== false && a.action_id ? (
                                    <div className="action-btns">
                                        <button
                                            type="button"
                                            className="btn"
                                            onClick={() => runAction(() => api.ackReportAction(a.action_id))}
                                        >
                                            ACK / DISMISS
                                        </button>
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
