import { memo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';

function fmtIsoShort(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_) {
        return String(iso).slice(11, 16);
    }
}

function DailyDirectionBannerInner() {
    const { syncData } = useSync();
    const floor = syncData?.daily_direction_floor;
    if (!floor?.posted_at && !floor?.daily_direction?.posted_at) return null;

    const dd = floor.daily_direction || floor;
    const updateCount = Number(dd.update_count || floor.update_count || 0);
    const postedAt = dd.posted_at || floor.posted_at;
    const postedBy = dd.posted_by || floor.posted_by || '';
    const updatedAt = dd.updated_at || floor.updated_at || postedAt;
    const updatedBy = dd.updated_by || floor.updated_by || postedBy;
    const meta = updateCount > 0
        ? `Updated ${fmtIsoShort(updatedAt)} by ${updatedBy || ''}`
        : `Posted ${fmtIsoShort(postedAt)} by ${postedBy || ''}`;
    const statusColor = dd.status_color || '#fa0';
    const mustWins = (dd.must_wins || floor.must_wins || []).filter((w) => w.text);

    return (
        <div className="daily-direction-floor-card" style={{ '--dd-status': statusColor, marginBottom: 16 }}>
            <div className="daily-direction-floor-label">
                DAILY DIRECTION · {String(dd.status || 'yellow').toUpperCase()}
            </div>
            <div className="daily-direction-floor-body">{dd.floor_message || floor.floor_message || ''}</div>
            {mustWins.length ? (
                <div className="daily-direction-floor-wins">
                    Must-win: {mustWins.map((w) => w.text).join(' · ')}
                </div>
            ) : null}
            <div className="daily-direction-floor-meta">{meta}</div>
        </div>
    );
}

export default memo(DailyDirectionBannerInner);
