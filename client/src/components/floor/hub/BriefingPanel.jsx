import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';
import { isActiveKillRow, mgrKillZoneOwner, storeToday } from '../../../lib/floorUtils.js';

function Scorecard({ sc }) {
    if (!sc?.overall?.order_days) return null;
    const o = sc.overall;
    const top = (sc.by_weekday || []).filter((r) => r.order_days >= 2).slice(0, 3);
    return (
        <div style={{ background: 'rgba(255,170,0,0.08)', border: '1px solid rgba(255,170,0,0.35)', padding: 10, borderRadius: 8, fontSize: '0.82em', marginBottom: 10 }}>
            <div style={{ color: '#fa0', fontWeight: 'bold', marginBottom: 6 }}>ORDER SCORECARD — {o.order_days} FINISH days</div>
            <div>Avg pieces: <strong>{Math.round(o.avg_pieces || 0)}</strong> · Staff: <strong>{Number(o.avg_staff || 0).toFixed(1)}</strong> · Team PPH: <strong>{Number(o.avg_team_pph || 0).toFixed(1)}</strong></div>
            {top.length ? (
                <div style={{ marginTop: 6, fontSize: '0.75em', color: '#888' }}>
                    {top.map((r) => `${r.weekday}: ${r.avg_pieces} pcs (${r.order_days}d)`).join(' · ')}
                </div>
            ) : null}
        </div>
    );
}

function OrderBriefing({ b }) {
    if (!b?.is_order_day) return null;
    const exp = b.expected_pieces;
    const band = exp?.avg != null
        ? `${exp.avg}${exp.min != null && exp.max != null ? ` (${exp.min}–${exp.max})` : ''} pieces`
        : '—';
    const recent = (b.recent_same_weekday || []).slice(0, 3);
    return (
        <div style={{ background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.35)', padding: 10, borderRadius: 8, fontSize: '0.82em', marginBottom: 10 }}>
            <div style={{ color: '#0cf', fontWeight: 'bold', letterSpacing: '0.04em', marginBottom: 6 }}>ORDER-DAY BRIEFING — {b.weekday || ''}</div>
            <div>Expected size: <strong>{band}</strong></div>
            <div>Typical duration: <strong>{b.expected_duration_minutes ? `${Math.round(b.expected_duration_minutes)} min` : '—'}</strong> · Staff: <strong>{b.expected_staff ?? '—'}</strong></div>
            {recent.length ? (
                <table style={{ width: '100%', marginTop: 8, fontSize: '0.75em', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ color: '#b0b0b0' }}><th align="left">DATE</th><th>PCS</th><th>STAFF</th><th>TIME</th></tr></thead>
                    <tbody>
                        {recent.map((r) => (
                            <tr key={r.store_date}><td>{r.store_date}</td><td>{r.total_pieces}</td><td>{r.staff_count}</td><td>{r.actual_order_minutes ? `${r.actual_order_minutes}m` : '—'}</td></tr>
                        ))}
                    </tbody>
                </table>
            ) : null}
        </div>
    );
}

function RhythmAdvisor({ adv, onDefer }) {
    if (!adv?.message) return null;
    const deferIds = (adv.defer_candidates || []).map((c) => c.id).filter(Boolean);
    return (
        <div style={{ padding: 8, background: 'rgba(168,85,247,0.12)', borderLeft: '3px solid #a855f7', borderRadius: 4, marginBottom: 10 }}>
            <strong>Rhythm hint:</strong> {adv.message}
            {adv.defer_non_critical_suggested && deferIds.length ? (
                <button type="button" className="st-btn" style={{ marginTop: 6, padding: '4px 10px', fontSize: '0.75em', borderColor: '#fa0', color: '#fa0' }} onClick={() => onDefer(adv.store_date, deferIds)}>
                    DEFER {deferIds.length} ROUTINE(S)
                </button>
            ) : null}
        </div>
    );
}

function ExceptionInbox({ syncData, onAck }) {
    const meta = syncData?.manager_meta || {};
    const actions = meta.report_actions;
    if (Array.isArray(actions)) {
        if (!actions.length) return <div style={{ color: '#0f8', fontSize: '0.9em', textAlign: 'center', padding: 12 }}>✓ No actions — inbox clear</div>;
        return actions.map((a) => (
            <div key={a.action_id || a.title} style={{ background: 'rgba(0,0,0,0.35)', padding: 10, marginBottom: 8, borderLeft: `4px solid ${a.priority === 'urgent' ? '#f44' : (a.priority === 'warn' ? '#fa0' : '#0cf')}`, fontSize: '0.85em' }}>
                <div style={{ fontWeight: 'bold', fontSize: '0.75em', letterSpacing: '0.05em', color: a.priority === 'urgent' ? '#f44' : '#fa0' }}>{a.title}</div>
                <div style={{ marginTop: 4 }}>{a.detail}</div>
                {a.dismissible !== false && a.action_id ? (
                    <button type="button" className="st-btn" style={{ marginTop: 6, padding: '4px 10px', fontSize: '0.7em' }} onClick={() => onAck(a.action_id)}>ACK</button>
                ) : null}
            </div>
        ));
    }

    const items = Array.isArray(meta.manager_exceptions) ? meta.manager_exceptions : null;
    if (items) {
        if (!items.length) return <div style={{ color: '#0f8', fontSize: '0.9em', textAlign: 'center', padding: 12 }}>✓ No exceptions right now</div>;
        return items.map((it, i) => (
            <div key={i} style={{ background: 'rgba(0,0,0,0.35)', padding: 10, marginBottom: 8, borderLeft: `4px solid ${it.color}`, fontSize: '0.85em' }}>
                <div style={{ color: it.color, fontWeight: 'bold', fontSize: '0.75em', letterSpacing: '0.05em' }}>{it.title}</div>
                <div style={{ marginTop: 4 }}>{it.detail}</div>
            </div>
        ));
    }

    const today = storeToday(syncData);
    const fallback = [];
    (syncData?.tasks || []).filter((t) => !String(t.task_id || '').startsWith('AUTO-PULL'))
        .filter((t) => t.priority === 'Urgent' || t.priority === 'High')
        .forEach((t) => fallback.push({ color: '#f44', title: `${t.priority} TASK`, detail: `${t.zone}: ${(t.task_detail || '').slice(0, 80)}`, meta: t.assigned_to || 'Unassigned' }));
    (syncData?.kill_dates || []).filter(isActiveKillRow).filter((k) => k.kill_date && k.kill_date <= today)
        .forEach((k) => fallback.push({ color: '#f44', title: 'EXPIRY PULL TODAY', detail: `${k.zone}: ${k.item}`, meta: mgrKillZoneOwner(k.zone, syncData?.settings) || 'No zone owner set' }));

    if (!fallback.length) return <div style={{ color: '#0f8', fontSize: '0.9em', textAlign: 'center', padding: 12 }}>✓ No exceptions right now</div>;
    return fallback.map((it, i) => (
        <div key={i} style={{ background: 'rgba(0,0,0,0.35)', padding: 10, marginBottom: 8, borderLeft: `4px solid ${it.color}`, fontSize: '0.85em' }}>
            <div style={{ color: it.color, fontWeight: 'bold', fontSize: '0.75em', letterSpacing: '0.05em' }}>{it.title}</div>
            <div style={{ marginTop: 4 }}>{it.detail}</div>
            {it.meta ? <div style={{ opacity: 0.75, fontSize: '0.8em', marginTop: 4 }}>{it.meta}</div> : null}
        </div>
    ));
}

export default function BriefingPanel() {
    const { syncData } = useSync();
    const { actions, showNotice } = useFloorUi();
    const meta = syncData?.manager_meta || {};

    return (
        <>
            <Scorecard sc={meta.order_weekly_scorecard} />
            <OrderBriefing b={meta.order_day_briefing} />
            <RhythmAdvisor
                adv={meta.rhythm_load_advisor}
                onDefer={async (storeDate, rhythmIds) => {
                    try {
                        await actions.deferRhythm(storeDate || storeToday(syncData), rhythmIds);
                        showNotice('Rhythm deferred', 'success');
                    } catch (e) {
                        showNotice(e.message, 'error');
                    }
                }}
            />
            <ExceptionInbox
                syncData={syncData}
                onAck={async (actionId) => {
                    try {
                        await actions.ackReportAction(actionId);
                        showNotice('Action dismissed', 'success');
                    } catch (e) {
                        showNotice(e.message, 'error');
                    }
                }}
            />
        </>
    );
}
