import { useEffect, useState } from 'react';
import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';
import { DD_WALK_FLAGS, fmtIsoShort } from '../../../lib/floorUtils.js';

function WalkFlags({ flags, prefix, onChange }) {
    return DD_WALK_FLAGS.map(([key, label]) => (
        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.72em', margin: '4px 0', textTransform: 'none', color: '#ccc', cursor: 'pointer' }}>
            <input
                type="checkbox"
                checked={!!flags[key]}
                onChange={(e) => onChange(key, e.target.checked)}
            />
            {label}
        </label>
    ));
}

export default function DailyDirectionPanel() {
    const { syncData } = useSync();
    const { actions, showNotice } = useFloorUi();
    const dd = syncData?.manager_meta?.daily_direction;
    const posted = !!dd?.posted?.posted_at;

    const [statusOverride, setStatusOverride] = useState('');
    const [floorMessage, setFloorMessage] = useState('');
    const [managerNotes, setManagerNotes] = useState('');
    const [walkText, setWalkText] = useState('');
    const [walkFlags, setWalkFlags] = useState({});
    const [mustWins, setMustWins] = useState(['', '', '']);
    const [postedStatus, setPostedStatus] = useState('yellow');
    const [postedMessage, setPostedMessage] = useState('');
    const [postedManagerNotes, setPostedManagerNotes] = useState('');
    const [postedWalkText, setPostedWalkText] = useState('');
    const [postedWalkFlags, setPostedWalkFlags] = useState({});
    const [postedMustWins, setPostedMustWins] = useState(['', '', '']);
    const [seed, setSeed] = useState('');
    const [shiftEditing, setShiftEditing] = useState(false);
    const [shiftMessage, setShiftMessage] = useState('');
    const [shiftSeed, setShiftSeed] = useState('');

    useEffect(() => {
        if (!dd) return;
        const key = `${posted}-${dd.updated_at || dd.posted?.posted_at || ''}`;
        if (seed === key) return;
        if (posted) {
            setPostedStatus(String(dd.status || 'yellow').toLowerCase());
            setPostedMessage(dd.floor_message || '');
            setPostedManagerNotes(dd.manager_only_notes || '');
            setPostedWalkText(dd.walk_notes?.free_text || '');
            setPostedWalkFlags(dd.walk_notes?.flags || {});
            setPostedMustWins([0, 1, 2].map((i) => dd.must_wins?.[i]?.text || ''));
        } else {
            setStatusOverride(String(dd.status_override || '').toLowerCase());
            setFloorMessage(dd.floor_message || '');
            setManagerNotes(dd.manager_only_notes || '');
            setWalkText(dd.walk_notes?.free_text || '');
            setWalkFlags(dd.walk_notes?.flags || {});
            setMustWins([0, 1, 2].map((i) => dd.must_wins?.[i]?.text || ''));
        }
        setSeed(key);
    }, [dd, posted, seed]);

    useEffect(() => {
        if (!posted || !dd) return;
        const fp = dd.amendment_suggestion?.fingerprint
            || dd.shift_update_draft?.saved_at
            || '';
        const key = `${fp}|${dd.shift_update_draft?.message || ''}|${dd.amendment_suggestion?.suggested_message || ''}`;
        if (shiftSeed === key) return;
        if (!shiftEditing) {
            setShiftMessage(
                dd.shift_update_draft?.message
                || dd.amendment_suggestion?.suggested_message
                || '',
            );
        }
        setShiftSeed(key);
    }, [dd, posted, shiftEditing, shiftSeed]);

    if (!dd) {
        return <div style={{ opacity: 0.7, fontSize: '0.85em' }}>Daily Direction unavailable.</div>;
    }

    const buildPayload = (state) => ({
        status_override: state.status,
        floor_message: state.message,
        manager_only_notes: state.managerNotes,
        walk_notes: { free_text: state.walkText, flags: state.walkFlags },
        must_wins: state.mustWins.map((text) => ({ text: text.trim(), owner: '' })).filter((w) => w.text),
    });

    if (posted) {
        const ctx = dd.day_context || {};
        const amend = dd.amendment_suggestion;
        const updates = dd.shift_updates || [];
        return (
            <div style={{ fontSize: '0.85em' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ background: dd.status_color || '#fa0', color: '#000', padding: '2px 10px', borderRadius: 12, fontWeight: 'bold', fontSize: '0.75em' }}>
                        DAILY DIRECTION · {String(dd.status || '').toUpperCase()}
                    </span>
                    <span style={{ opacity: 0.8 }}>{ctx.weekday || ''}{ctx.is_order_day ? ' · TGP Order Day' : ''}</span>
                    <span style={{ opacity: 0.65, fontSize: '0.72em' }}>
                        Posted {fmtIsoShort(dd.posted.posted_at)} by {dd.posted.posted_by || ''}
                    </span>
                </div>
                <label className="section-label" style={{ fontSize: '0.7em' }}>STATUS</label>
                <select className="st-input" style={{ width: 'auto', minWidth: 110, margin: '0 0 10px', fontSize: '0.75em', padding: '4px 8px' }} value={postedStatus} onChange={(e) => setPostedStatus(e.target.value)}>
                    <option value="green">Green</option>
                    <option value="yellow">Yellow</option>
                    <option value="red">Red</option>
                </select>
                <label className="section-label" style={{ fontSize: '0.7em' }}>FLOOR MESSAGE</label>
                <textarea className="st-input" rows={6} style={{ fontSize: '0.78em', marginBottom: 8, textTransform: 'none', fontFamily: 'inherit', lineHeight: 1.35 }} value={postedMessage} onChange={(e) => setPostedMessage(e.target.value)} />
                <label className="section-label" style={{ fontSize: '0.7em' }}>MUST-WIN</label>
                {[0, 1, 2].map((i) => (
                    <input key={i} className="st-input" style={{ marginBottom: 6, fontSize: '0.8em' }} placeholder={`Must-win ${i + 1}`} value={postedMustWins[i]} onChange={(e) => { const n = [...postedMustWins]; n[i] = e.target.value; setPostedMustWins(n); }} />
                ))}
                <label className="section-label" style={{ fontSize: '0.7em', marginTop: 8 }}>WALK NOTES</label>
                <textarea className="st-input" rows={2} style={{ fontSize: '0.78em', marginBottom: 6, textTransform: 'none' }} value={postedWalkText} onChange={(e) => setPostedWalkText(e.target.value)} />
                <WalkFlags flags={postedWalkFlags} onChange={(k, v) => setPostedWalkFlags({ ...postedWalkFlags, [k]: v })} />
                <label className="section-label" style={{ fontSize: '0.7em', marginTop: 8 }}>MANAGER-ONLY NOTES</label>
                <textarea className="st-input" rows={2} style={{ fontSize: '0.78em', marginBottom: 8, textTransform: 'none' }} value={postedManagerNotes} onChange={(e) => setPostedManagerNotes(e.target.value)} />
                <button
                    type="button"
                    className="st-btn"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.75em', borderColor: '#0f8', color: '#0f8' }}
                    onClick={async () => {
                        try {
                            const ok = await actions.updatePostedDailyDirection(buildPayload({
                                status: postedStatus,
                                message: postedMessage,
                                managerNotes: postedManagerNotes,
                                walkText: postedWalkText,
                                walkFlags: postedWalkFlags,
                                mustWins: postedMustWins,
                            }));
                            if (ok !== false) showNotice('Daily Direction updated', 'success');
                        } catch (e) {
                            showNotice(e.message, 'error');
                        }
                    }}
                >
                    UPDATE DIRECTION
                </button>
                <p style={{ margin: '8px 0 0', fontSize: '0.68em', opacity: 0.65, textTransform: 'none' }}>
                    Update Direction replaces the full posted card (status, must-wins, walk notes, message).
                    Use Shift Update below for a quick TV message change with Reports history.
                </p>
                {updates.length ? (
                    <p style={{ margin: '10px 0 0', fontSize: '0.68em', opacity: 0.7, textTransform: 'none' }}>
                        {updates.length} huddle update(s) saved in Reports for today.
                    </p>
                ) : null}

                {amend ? (
                    <div style={{
                        marginTop: 14,
                        padding: 10,
                        borderLeft: '3px solid #fa0',
                        background: 'rgba(255,170,0,0.1)',
                        textTransform: 'none',
                    }}
                    >
                        <div style={{ fontWeight: 700, fontSize: '0.75em', color: '#fa0', letterSpacing: 1, marginBottom: 4 }}>
                            AMENDMENT SUGGESTED
                        </div>
                        <div style={{ fontSize: '0.78em', marginBottom: 8 }}>{amend.summary || amend.headline || ''}</div>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                className="st-btn subtle"
                                style={{ width: 'auto', padding: '6px 12px', fontSize: '0.72em' }}
                                onClick={async () => {
                                    try {
                                        await actions.ignoreDailyDirectionAmendment(120);
                                        showNotice('Suggestion hidden for 2 hours', 'success');
                                    } catch (e) {
                                        showNotice(e.message, 'error');
                                    }
                                }}
                            >
                                IGNORE 2H
                            </button>
                            <button
                                type="button"
                                className="st-btn subtle"
                                style={{ width: 'auto', padding: '6px 12px', fontSize: '0.72em' }}
                                onClick={async () => {
                                    try {
                                        await actions.dismissDailyDirectionAmendment(amend.fingerprint);
                                        setShiftEditing(false);
                                        showNotice('Suggestion dismissed', 'success');
                                    } catch (e) {
                                        showNotice(e.message, 'error');
                                    }
                                }}
                            >
                                DISMISS
                            </button>
                            <button
                                type="button"
                                className="st-btn"
                                style={{ width: 'auto', padding: '6px 12px', fontSize: '0.72em', borderColor: '#fa0', color: '#fa0' }}
                                onClick={() => {
                                    setShiftMessage(amend.suggested_message || shiftMessage || '');
                                    setShiftEditing(true);
                                }}
                            >
                                EDIT / POST UPDATE
                            </button>
                        </div>
                    </div>
                ) : null}

                <div style={{ marginTop: 14 }}>
                    <label className="section-label" style={{ fontSize: '0.7em' }}>SHIFT UPDATE (TV MESSAGE ONLY)</label>
                    {!shiftEditing ? (
                        <button
                            type="button"
                            className="st-btn subtle"
                            style={{ width: 'auto', padding: '6px 12px', fontSize: '0.72em', marginBottom: 8 }}
                            onClick={() => {
                                setShiftMessage(
                                    dd.shift_update_draft?.message
                                    || amend?.suggested_message
                                    || shiftMessage
                                    || '',
                                );
                                setShiftEditing(true);
                            }}
                        >
                            WRITE SHIFT UPDATE
                        </button>
                    ) : (
                        <>
                            <textarea
                                className="st-input"
                                rows={4}
                                style={{ fontSize: '0.78em', marginBottom: 8, textTransform: 'none', fontFamily: 'inherit', lineHeight: 1.35 }}
                                value={shiftMessage}
                                onChange={(e) => setShiftMessage(e.target.value)}
                                placeholder="Replace the visible Daily Direction message…"
                            />
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    className="st-btn subtle"
                                    style={{ width: 'auto', padding: '6px 12px', fontSize: '0.72em' }}
                                    onClick={async () => {
                                        try {
                                            await actions.saveDailyDirectionShiftUpdateDraft(shiftMessage);
                                            showNotice('Daily Direction update draft saved', 'success');
                                        } catch (e) {
                                            showNotice(e.message, 'error');
                                        }
                                    }}
                                >
                                    SAVE DRAFT
                                </button>
                                <button
                                    type="button"
                                    className="st-btn"
                                    style={{ width: 'auto', padding: '6px 12px', fontSize: '0.72em', borderColor: '#f90', color: '#f90' }}
                                    onClick={async () => {
                                        try {
                                            const ok = await actions.postDailyDirectionShiftUpdate({
                                                message: shiftMessage
                                                    || dd.shift_update_draft?.message
                                                    || amend?.suggested_message
                                                    || '',
                                                fingerprint: amend?.fingerprint,
                                                triggers: amend?.triggers,
                                            });
                                            if (ok !== false) {
                                                setShiftEditing(false);
                                                showNotice('Daily Direction updated', 'success');
                                            }
                                        } catch (e) {
                                            showNotice(e.message, 'error');
                                        }
                                    }}
                                >
                                    POST SHIFT UPDATE
                                </button>
                                <button
                                    type="button"
                                    className="st-btn subtle"
                                    style={{ width: 'auto', padding: '6px 12px', fontSize: '0.72em' }}
                                    onClick={() => setShiftEditing(false)}
                                >
                                    CANCEL
                                </button>
                            </div>
                        </>
                    )}
                    <p style={{ margin: '10px 0 0', fontSize: '0.68em', opacity: 0.65, textTransform: 'none' }}>
                        Shift updates replace the TV message only and stay in Reports → Daily Direction history.
                    </p>
                </div>
            </div>
        );
    }

    const risks = (dd.system_risks || []).slice(0, 12);
    const ctx = dd.day_context || {};

    return (
        <div style={{ fontSize: '0.85em' }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
                <span style={{ background: dd.status_color || '#fa0', color: '#000', padding: '2px 10px', borderRadius: 12, fontWeight: 'bold', fontSize: '0.75em' }}>
                    DRAFT · {String(dd.status || 'yellow').toUpperCase()}
                </span>
                <span style={{ opacity: 0.75, fontSize: '0.75em' }}>
                    {ctx.weekday || ''}{ctx.is_order_day ? ' · Order day' : ''}{(ctx.vendors || []).length ? ` · ${ctx.vendors.join(', ')}` : ''}
                </span>
                <select className="st-input" style={{ width: 'auto', minWidth: 110, margin: 0, fontSize: '0.75em', padding: '4px 8px' }} value={statusOverride} onChange={(e) => setStatusOverride(e.target.value)}>
                    <option value="">Suggest {String(dd.status_derived || dd.status || 'yellow').toUpperCase()} (inbox)</option>
                    <option value="green">Green — my call</option>
                    <option value="yellow">Yellow — my call</option>
                    <option value="red">Red — my call</option>
                </select>
            </div>
            <label className="section-label" style={{ fontSize: '0.7em', marginTop: 4 }}>SYSTEM-DETECTED RISKS</label>
            <div style={{ maxHeight: 180, overflow: 'auto', marginBottom: 10 }}>
                {risks.length ? risks.map((r, i) => (
                    <div key={i} style={{ background: 'rgba(0,0,0,0.25)', padding: 8, marginBottom: 6, borderLeft: `3px solid ${r.severity === 'urgent' ? '#f44' : (r.severity === 'warn' ? '#fa0' : '#0cf')}`, fontSize: '0.78em' }}>
                        <div style={{ fontWeight: 'bold', fontSize: '0.72em', color: '#ccc' }}>{r.title}</div>
                        <div style={{ marginTop: 3 }}>{r.detail}</div>
                    </div>
                )) : <div style={{ opacity: 0.7, fontSize: '0.82em', marginBottom: 8 }}>No system risks detected — still confirm on your walk.</div>}
            </div>
            <label className="section-label" style={{ fontSize: '0.7em' }}>WALK NOTES</label>
            <WalkFlags flags={walkFlags} onChange={(k, v) => setWalkFlags({ ...walkFlags, [k]: v })} />
            <textarea className="st-input" rows={2} style={{ fontSize: '0.8em', marginBottom: 10, textTransform: 'none' }} placeholder="What you saw on the walk…" value={walkText} onChange={(e) => setWalkText(e.target.value)} />
            <label className="section-label" style={{ fontSize: '0.7em' }}>MUST-WIN OUTCOMES (MAX 3)</label>
            {[0, 1, 2].map((i) => (
                <input key={i} className="st-input" style={{ marginBottom: 6, fontSize: '0.8em' }} placeholder={`Must-win ${i + 1}`} value={mustWins[i]} onChange={(e) => { const n = [...mustWins]; n[i] = e.target.value; setMustWins(n); }} />
            ))}
            <label className="section-label" style={{ fontSize: '0.7em' }}>FLOOR MESSAGE (POSTED VERSION)</label>
            <textarea className="st-input" rows={5} style={{ fontSize: '0.78em', marginBottom: 8, textTransform: 'none', fontFamily: 'inherit', lineHeight: 1.35 }} value={floorMessage} onChange={(e) => setFloorMessage(e.target.value)} />
            <label className="section-label" style={{ fontSize: '0.7em' }}>MANAGER-ONLY NOTES</label>
            <textarea className="st-input" rows={2} style={{ fontSize: '0.78em', marginBottom: 10, textTransform: 'none' }} placeholder="Scorecard context, not for the floor…" value={managerNotes} onChange={(e) => setManagerNotes(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                    type="button"
                    className="st-btn subtle"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.75em' }}
                    onClick={async () => {
                        try {
                            await actions.saveDailyDirectionDraft(buildPayload({
                                status: statusOverride,
                                message: floorMessage,
                                managerNotes,
                                walkText,
                                walkFlags,
                                mustWins,
                            }));
                            showNotice('Daily Direction draft saved', 'success');
                        } catch (e) {
                            showNotice(e.message, 'error');
                        }
                    }}
                >
                    SAVE DRAFT
                </button>
                <button
                    type="button"
                    className="st-btn"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.75em', borderColor: '#0f8', color: '#0f8' }}
                    onClick={async () => {
                        try {
                            const ok = await actions.approveDailyDirection(buildPayload({
                                status: statusOverride,
                                message: floorMessage,
                                managerNotes,
                                walkText,
                                walkFlags,
                                mustWins,
                            }));
                            if (ok !== false) showNotice('Daily Direction posted', 'success');
                        } catch (e) {
                            showNotice(e.message, 'error');
                        }
                    }}
                >
                    APPROVE &amp; POST
                </button>
            </div>
        </div>
    );
}
