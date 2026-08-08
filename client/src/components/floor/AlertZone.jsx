import { memo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorRole } from '../../hooks/useFloorRole.js';
import { filterCommsRows } from '../../lib/floorUtils.js';

function AlertZoneInner() {
    const { syncData } = useSync();
    const { isManager } = useFloorRole();
    const comms = syncData?.comms || {};
    const settings = syncData?.settings || {};

    if (comms.enabled) {
        const pinned = filterCommsRows(comms.pinned || [], isManager);
        if (!pinned.length) return null;
        return (
            <div className="comms-pinned-banner">
                {pinned.map((m) => (
                    <div key={m.msg_id} className={`comms-pinned-item comms-pri-${m.priority || 'warn'}`}>
                        {m.zone && m.zone !== 'General' ? <span className="comms-zone-chip">{m.zone}</span> : null}
                        {m.body}
                    </div>
                ))}
            </div>
        );
    }

    if (settings.Critical_Alert === '1') {
        return <div className="alert-banner">🚨 CRITICAL ALERT: {settings.Shift_Notes || ''}</div>;
    }
    if (settings.Shift_Notes) {
        return <div className="shift-note"><strong>COMMAND NOTES:</strong> {settings.Shift_Notes}</div>;
    }
    return null;
}

export default memo(AlertZoneInner);
