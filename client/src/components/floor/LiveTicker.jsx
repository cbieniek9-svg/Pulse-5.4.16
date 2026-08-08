import { memo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';

function LiveTickerInner() {
    const { syncData } = useSync();
    const comms = syncData?.comms || {};
    let text = '';

    if (comms.enabled && comms.ticker?.length) {
        text = comms.ticker.map((m) => m.body).filter(Boolean).join(' | ');
    } else if (syncData?.ticker?.length) {
        text = syncData.ticker.map((t) => t.message).filter(Boolean).map((m) => `NOTICE: ${m}`).join(' | ');
    }

    if (!text) return null;

    return (
        <div id="ticker-wrap" style={{ display: 'block', marginBottom: 12 }}>
            <div id="live-ticker" className="live-ticker">{text}</div>
        </div>
    );
}

export default memo(LiveTickerInner);
