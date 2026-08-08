import { useEffect, useMemo, useRef, useState } from 'react';
import { useSync } from '../../../providers/SyncProvider.jsx';
import { useFloorRole } from '../../../hooks/useFloorRole.js';
import { useFloorUi } from '../../shared/NoticeProvider.jsx';
import { getCommsZoneOptions } from '../../../lib/floorUtils.js';

function laneLabel(lane) {
    if (lane === 'pinned') return 'PINNED';
    if (lane === 'ticker') return 'TICKER';
    if (lane === 'feed') return 'FEED';
    return String(lane || '').toUpperCase();
}

function CommsAdminItem({ msg, canDismiss, canPromote, onDismiss, onPromote }) {
    const pri = msg.priority === 'urgent' ? 'comms-pri-urgent' : msg.priority === 'warn' ? 'comms-pri-warn' : 'comms-pri-info';
    return (
        <div className={`comms-feed-item ${pri}`}>
            <div className="comms-feed-body">
                {msg.zone && msg.zone !== 'General' ? <span className="comms-zone-chip">{msg.zone}</span> : null}
                {msg.body}
            </div>
            <div className="comms-feed-meta">
                {[laneLabel(msg.lane), msg.source === 'system' ? 'AUTO' : msg.posted_by, msg.posted_at ? new Date(msg.posted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')}
            </div>
            <div className="comms-item-actions">
                {canDismiss && msg.msg_id ? (
                    <button type="button" className="comms-dismiss-btn" onClick={() => onDismiss(msg.msg_id)}>DISMISS</button>
                ) : null}
                {canPromote && msg.msg_id && msg.lane !== 'pinned' ? (
                    <button type="button" className="comms-promote-btn" onClick={() => onPromote(msg.msg_id)}>PIN</button>
                ) : null}
            </div>
        </div>
    );
}

export default function MessageCenterPanel() {
    const { syncData } = useSync();
    const { isManager, showComms } = useFloorRole();
    const { actions, showNotice } = useFloorUi();
    const comms = syncData?.comms || {};
    const settings = syncData?.settings || {};
    const zones = useMemo(() => getCommsZoneOptions(syncData?.settings), [syncData?.settings]);

    const [notes, setNotes] = useState('');
    const [critical, setCritical] = useState(false);
    const notesDirty = useRef(false);
    const [ticker, setTicker] = useState('');
    const [pinBody, setPinBody] = useState('');
    const [pinPri, setPinPri] = useState('warn');
    const [pinZone, setPinZone] = useState('');
    const [tickerBody, setTickerBody] = useState('');
    const [tickerZone, setTickerZone] = useState('');
    const [feedBody, setFeedBody] = useState('');
    const [feedZone, setFeedZone] = useState('');
    const [msgCenter, setMsgCenter] = useState(settings.Message_Center_Enabled === '1');
    const [sysMsgs, setSysMsgs] = useState(settings.Comms_System_Messages !== '0');

    useEffect(() => {
        if (notesDirty.current) return;
        setNotes(settings.Shift_Notes || '');
        setCritical(settings.Critical_Alert === '1');
    }, [settings.Shift_Notes, settings.Critical_Alert]);

    useEffect(() => {
        setMsgCenter(settings.Message_Center_Enabled === '1');
        setSysMsgs(settings.Comms_System_Messages !== '0');
    }, [settings.Message_Center_Enabled, settings.Comms_System_Messages]);

    const adminMessages = useMemo(() => (
        [...(comms.pinned || []), ...(comms.ticker || []), ...(comms.feed || [])]
            .sort((a, b) => Date.parse(b.posted_at || 0) - Date.parse(a.posted_at || 0))
    ), [comms.pinned, comms.ticker, comms.feed]);

    const saveNotes = async () => {
        try {
            await actions.saveShiftNotes({ notes, critical });
            notesDirty.current = false;
            showNotice('Notes saved', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const sendTicker = async () => {
        try {
            const ok = await actions.sendTicker(ticker);
            if (!ok) return;
            setTicker('');
            showNotice('Ticker sent', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const clearTickers = async () => {
        try {
            const ok = await actions.clearAllTickers();
            if (ok) showNotice('Ticker cleared.', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const postLane = async (lane, body, extra) => {
        try {
            await actions.postComms(lane, body, extra);
            showNotice('Posted', 'success');
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    const toggleCenter = async (enabled) => {
        const ok = await actions.toggleMessageCenter(enabled, sysMsgs);
        if (ok) setMsgCenter(enabled);
        else setMsgCenter(!enabled);
    };

    const toggleSys = async (enabled) => {
        setSysMsgs(enabled);
        try {
            await actions.setCommsSystemMode(enabled, msgCenter);
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    if (!showComms) return null;

    return (
        <>
            {!comms.enabled ? (
                <div id="comms-legacy-panel">
                    <textarea
                        className="st-input"
                        rows={3}
                        value={notes}
                        onChange={(e) => { notesDirty.current = true; setNotes(e.target.value); }}
                        placeholder="Pass the baton..."
                    />
                    <label style={{ color: '#fff', fontSize: '0.9em', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <input
                            type="checkbox"
                            checked={critical}
                            onChange={(e) => { notesDirty.current = true; setCritical(e.target.checked); }}
                        />
                        Mark as Critical Alert
                    </label>
                    <button type="button" className="st-btn" onClick={saveNotes}>SAVE NOTES</button>
                    <hr style={{ borderColor: '#1f3b5c', margin: '15px 0' }} />
                    <input className="st-input" value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="Broadcast Live Ticker Message" />
                    <button type="button" className="st-btn" onClick={sendTicker}>SEND TO TICKER</button>
                    <label className="section-label" style={{ marginTop: 12 }}>ACTIVE TICKER MESSAGES</label>
                    <div style={{ marginBottom: 8 }}>
                        {(syncData?.ticker || []).map((t) => (
                            <div key={t.msg_id} className="data-card" style={{ fontSize: '0.85em' }}>
                                {t.message}
                                <button type="button" className="done-btn" style={{ marginTop: 6 }} onClick={() => actions.deleteTicker(t.msg_id)}>DEL</button>
                            </div>
                        ))}
                    </div>
                    <button type="button" className="st-btn" style={{ background: '#633' }} onClick={clearTickers}>CLEAR ALL TICKERS</button>
                </div>
            ) : (
                <div id="comms-center-panel">
                    <label className="section-label">PIN TO BOARD</label>
                    <textarea className="st-input" rows={2} value={pinBody} onChange={(e) => setPinBody(e.target.value)} placeholder="Everyone must see this until cleared…" />
                    <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
                        <select className="st-input" style={{ flex: 1, minWidth: 120 }} value={pinPri} onChange={(e) => setPinPri(e.target.value)}>
                            <option value="warn">WARN</option>
                            <option value="urgent">URGENT</option>
                            <option value="info">INFO</option>
                        </select>
                        <select className="st-input" style={{ flex: 1, minWidth: 120 }} value={pinZone} onChange={(e) => setPinZone(e.target.value)}>
                            {zones.map((z) => <option key={z || 'all'} value={z}>{z || 'Store-wide'}</option>)}
                        </select>
                        <button type="button" className="st-btn" style={{ flex: 1 }} onClick={() => { postLane('pinned', pinBody, { priority: pinPri, zone: pinZone }); setPinBody(''); }}>PIN TO BOARD</button>
                    </div>
                    <hr style={{ borderColor: '#1f3b5c', margin: '12px 0' }} />
                    <label className="section-label">TICKER SCROLL</label>
                    <input className="st-input" value={tickerBody} onChange={(e) => setTickerBody(e.target.value)} placeholder="Short rolling notice…" />
                    <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
                        <select className="st-input" style={{ flex: 1, minWidth: 120 }} value={tickerZone} onChange={(e) => setTickerZone(e.target.value)}>
                            {zones.map((z) => <option key={z || 'all'} value={z}>{z || 'Store-wide'}</option>)}
                        </select>
                        <button type="button" className="st-btn" style={{ flex: 1 }} onClick={() => { postLane('ticker', tickerBody, { zone: tickerZone }); setTickerBody(''); }}>SEND TICKER</button>
                    </div>
                    <hr style={{ borderColor: '#1f3b5c', margin: '12px 0' }} />
                    <label className="section-label">FEED POST</label>
                    <input className="st-input" value={feedBody} onChange={(e) => setFeedBody(e.target.value)} placeholder="Message for the comms feed…" />
                    <div style={{ display: 'flex', gap: 8, margin: '8px 0', flexWrap: 'wrap' }}>
                        <select className="st-input" style={{ flex: 1, minWidth: 120 }} value={feedZone} onChange={(e) => setFeedZone(e.target.value)}>
                            {zones.map((z) => <option key={z || 'all'} value={z}>{z || 'Store-wide'}</option>)}
                        </select>
                        <button type="button" className="st-btn" style={{ flex: 1 }} onClick={() => { postLane('feed', feedBody, { zone: feedZone }); setFeedBody(''); }}>POST TO FEED</button>
                    </div>
                    <label className="section-label" style={{ marginTop: 14 }}>ACTIVE MESSAGES</label>
                    <div style={{ marginBottom: 8 }}>
                        {adminMessages.length
                            ? adminMessages.map((m) => (
                                <CommsAdminItem
                                    key={m.msg_id}
                                    msg={m}
                                    canDismiss
                                    canPromote={isManager}
                                    onDismiss={(id) => actions.dismissComms(id)}
                                    onPromote={(id) => actions.promoteComms(id)}
                                />
                            ))
                            : <div style={{ color: '#69c', fontSize: '0.85em' }}>No active messages.</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '8px 12px', fontSize: '0.75em' }} onClick={() => actions.clearCommsLane('ticker')}>CLEAR TICKER</button>
                        <button type="button" className="st-btn subtle" style={{ width: 'auto', padding: '8px 12px', fontSize: '0.75em' }} onClick={() => actions.clearCommsLane('feed')}>CLEAR FEED</button>
                        <button type="button" className="st-btn" style={{ width: 'auto', padding: '8px 12px', fontSize: '0.75em', background: '#633' }} onClick={() => actions.clearCommsLane('pinned')}>CLEAR PINNED</button>
                    </div>
                    {isManager ? (
                        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #1f3b5c' }}>
                            <label className="section-label">ROLLBACK / OPTIONS</label>
                            <label style={{ color: '#ccc', fontSize: '0.82em', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                <input type="checkbox" checked={msgCenter} onChange={(e) => toggleCenter(e.target.checked)} />
                                Message Center enabled (uncheck = legacy comms)
                            </label>
                            <label style={{ color: '#ccc', fontSize: '0.82em', display: 'flex', alignItems: 'center', gap: 8 }}>
                                <input type="checkbox" checked={sysMsgs} onChange={(e) => toggleSys(e.target.checked)} />
                                Auto system messages (dock, pulls, rhythm)
                            </label>
                        </div>
                    ) : null}
                </div>
            )}
        </>
    );
}
