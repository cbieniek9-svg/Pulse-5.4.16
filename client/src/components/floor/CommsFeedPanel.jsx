import { memo, useMemo, useState } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorRole } from '../../hooks/useFloorRole.js';
import { useFloorUi } from '../shared/NoticeProvider.jsx';
import { getCommsZoneOptions } from '../../lib/floorUtils.js';

function FeedItem({ msg, canDismiss, canPromote, onDismiss, onPromote }) {
    const pri = msg.priority === 'urgent' ? 'comms-pri-urgent' : msg.priority === 'warn' ? 'comms-pri-warn' : 'comms-pri-info';
    return (
        <div className={`comms-feed-item ${pri}`}>
            <div className="comms-feed-body">
                {msg.zone && msg.zone !== 'General' ? <span className="comms-zone-chip">{msg.zone}</span> : null}
                {msg.body}
            </div>
            <div className="comms-feed-meta">
                {[msg.lane?.toUpperCase(), msg.posted_by, msg.posted_at ? new Date(msg.posted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ')}
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

function CommsFeedPanelInner() {
    const { syncData } = useSync();
    const { isManager, perms } = useFloorRole();
    const { actions } = useFloorUi();
    const comms = syncData?.comms || {};
    const zones = useMemo(() => getCommsZoneOptions(syncData?.settings), [syncData?.settings]);
    const [viewZone, setViewZone] = useState(() => {
        try { return sessionStorage.getItem('tgp_comms_view_zone') || ''; } catch (_) { return ''; }
    });

    const rows = useMemo(() => {
        if (!comms.enabled) return [];
        const all = comms.feed || [];
        if (isManager) return all.slice(0, 12);
        return all.filter((m) => {
            const z = m.zone || '';
            if (!z || z === 'General') return true;
            if (!viewZone) return false;
            return z === viewZone;
        }).slice(0, 12);
    }, [comms.enabled, comms.feed, isManager, viewZone]);

    if (!comms.enabled || !rows.length) return null;

    const onZoneChange = (zone) => {
        setViewZone(zone);
        try {
            if (zone) sessionStorage.setItem('tgp_comms_view_zone', zone);
            else sessionStorage.removeItem('tgp_comms_view_zone');
        } catch (_) { /* ignore */ }
    };

    return (
        <div className="floor-comms-panel" style={{ marginBottom: 14 }}>
            <div className="sect-header sect-header-secondary">LIVE NOTICES</div>
            <label className="section-label" style={{ marginBottom: 6, fontSize: '0.72em' }}>MY ZONE (optional)</label>
            <select className="st-input" style={{ marginBottom: 10 }} value={viewZone} onChange={(e) => onZoneChange(e.target.value)}>
                {zones.map((z) => <option key={z || 'all'} value={z}>{z || 'Store-wide'}</option>)}
            </select>
            {rows.map((m) => (
                <FeedItem
                    key={m.msg_id}
                    msg={m}
                    canDismiss={isManager || perms.includes('comms')}
                    canPromote={isManager}
                    onDismiss={(id) => actions.dismissComms(id)}
                    onPromote={(id) => actions.promoteComms(id)}
                />
            ))}
        </div>
    );
}

export default memo(CommsFeedPanelInner);
