import { memo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';

/** Today's safety focus blurb — stays above the scrollable task list. */
function SafetyFocusBannerInner() {
    const { syncData } = useSync();
    const focus = syncData?.daily_safety_focus;
    if (!focus?.message) return null;

    const label = focus.source === 'manual' ? 'MANAGER-SET' : 'DAILY ROTATION';

    return (
        <div className="floor-safety-focus-card" style={{ marginBottom: 16 }}>
            <div className="floor-safety-focus-label">
                SAFETY FOCUS · {label}
            </div>
            <div className="floor-safety-focus-body">{focus.message}</div>
        </div>
    );
}

export default memo(SafetyFocusBannerInner);
