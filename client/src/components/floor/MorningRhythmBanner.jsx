import { useFloorRole } from '../../hooks/useFloorRole.js';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorUi } from '../shared/NoticeProvider.jsx';

/**
 * Visible when morning rhythm missed the 06:30 deadline.
 * Auto-heal also runs on sync/watchdog — this is the manual backup + clarity.
 */
export default function MorningRhythmBanner() {
    const { syncData } = useSync();
    const { isManager, isPremium } = useFloorRole();
    const { actions, showNotice } = useFloorUi();
    const morning = syncData?.morning_rhythm;

    if (!morning?.needs_attention) return null;
    if (!isManager && !isPremium) return null;

    const load = async () => {
        try {
            await actions.loadRhythm();
        } catch (e) {
            showNotice(e.message || 'Load rhythm failed', 'error');
        }
    };

    return (
        <div
            style={{
                marginBottom: 14,
                padding: '12px 14px',
                borderRadius: 6,
                border: '1px solid #0cf',
                background: 'rgba(0, 229, 255, 0.1)',
                color: '#eef5ff',
            }}
        >
            <div style={{ fontWeight: 700, letterSpacing: 1, color: '#0cf', fontSize: '0.8em', marginBottom: 6 }}>
                {morning.deferral_lookup_failed
                    ? 'MORNING RHYTHM — DEFERRAL ERROR'
                    : (morning.incomplete ? 'MORNING RHYTHM INCOMPLETE' : 'MORNING RHYTHM NOT LOADED')}
            </div>
            <div style={{ fontSize: '0.85em', textTransform: 'none', lineHeight: 1.4, marginBottom: 10 }}>
                Store time {morning.store_time || '—'} · stamp {morning.stamp || 'none'} · expected {morning.store_date}
                {morning.deferral_lookup_failed
                    ? ' · could not read deferred rhythm list (seed refused to guess).'
                    : (morning.incomplete
                        ? ` · ${morning.missing_rhythm_count || '?'} schedule item(s) still missing.`
                        : '.')}
                {' '}
                Auto-heal runs on sync and every 15 minutes until 11:00.
                {morning.deferral_lookup_failed
                    ? ' Fix deferrals storage, then load again.'
                    : (morning.incomplete
                        ? ' If items are still missing, load now to top up.'
                        : ' If the board is still empty, load now.')}
            </div>
            <button
                type="button"
                className="st-btn"
                style={{ width: 'auto', padding: '8px 14px', fontSize: '0.75em', borderColor: '#0cf', color: '#0cf' }}
                onClick={load}
            >
                LOAD TODAY&apos;S SCHEDULE
            </button>
        </div>
    );
}
