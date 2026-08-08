import { memo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';

function RecentActivityListInner() {
    const { syncData } = useSync();
    const audit = syncData?.audit || [];

    if (!audit.length) {
        return <div style={{ color: '#b0b0b0' }}>NO RECENT ACTIVITY</div>;
    }

    return (
        <>
            {audit.map((a, i) => (
                <div key={`${a.time}-${i}`} style={{ marginBottom: 8, borderBottom: '1px solid #1f3b5c', fontSize: '0.9em' }}>
                    <small>{new Date(a.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small>
                    {' — '}{a.user}: {a.event}
                </div>
            ))}
        </>
    );
}

export default memo(RecentActivityListInner);
