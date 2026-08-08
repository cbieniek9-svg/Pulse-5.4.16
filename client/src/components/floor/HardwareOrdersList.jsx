import { memo, useCallback, useMemo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorUi } from '../shared/NoticeProvider.jsx';

/** Pending hardware vendor rows — separate from grocery expected (TIME IN). */
function HardwareOrdersListInner() {
    const { syncData } = useSync();
    const { actions, showNotice } = useFloorUi();

    const pending = useMemo(() => {
        const rows = syncData?.hardware_orders || [];
        return rows.filter((o) => !Number(o.arrived) && String(o.status || '') !== 'Archived');
    }, [syncData?.hardware_orders]);

    const markArrived = useCallback(async (expId) => {
        try {
            const ok = await actions.markHardwareArrive(expId);
            if (ok) showNotice('Hardware order checked in', 'success');
        } catch (e) {
            showNotice(e.message || 'Hardware check-in failed', 'error');
        }
    }, [actions, showNotice]);

    const undoArrived = useCallback(async (expId) => {
        try {
            await actions.markHardwareUnarrive(expId);
            showNotice('Hardware arrival undone', 'info');
        } catch (e) {
            showNotice(e.message || 'Undo failed', 'error');
        }
    }, [actions, showNotice]);

    const recentArrived = useMemo(() => {
        const rows = syncData?.hardware_orders || [];
        return rows
            .filter((o) => Number(o.arrived) && String(o.status || '') !== 'Archived')
            .slice(0, 4);
    }, [syncData?.hardware_orders]);

    return (
        <>
            {pending.length ? pending.map((o) => (
                <div key={o.exp_id} className="data-card" style={{ borderColor: '#0cf' }}>
                    <div>
                        <span className="card-zone">HDW</span>
                        {o.vendor || 'Hardware'}
                        {o.pieces != null ? (
                            <span className="card-meta" style={{ display: 'inline', marginLeft: 8 }}>
                                {o.pieces} pcs
                            </span>
                        ) : null}
                        {o.expected_day ? (
                            <div className="card-meta" style={{ textAlign: 'left', marginTop: 4 }}>
                                Due {o.expected_day}
                            </div>
                        ) : null}
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        <button type="button" className="done-btn" onClick={() => markArrived(o.exp_id)}>
                            ARRIVED
                        </button>
                    </div>
                </div>
            )) : <div style={{ color: '#b0b0b0' }}>NONE PENDING</div>}

            {recentArrived.length ? (
                <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: '0.72em', color: '#6699cc', letterSpacing: 1, marginBottom: 6 }}>
                        RECENTLY ARRIVED
                    </div>
                    {recentArrived.map((o) => (
                        <div key={o.exp_id} className="data-card" style={{ opacity: 0.85, borderColor: '#556' }}>
                            <div>
                                {o.vendor || 'Hardware'}
                                {o.pieces != null ? ` · ${o.pieces} pcs` : ''}
                            </div>
                            <button
                                type="button"
                                className="done-btn"
                                style={{ borderColor: '#f90', color: '#f90' }}
                                onClick={() => undoArrived(o.exp_id)}
                            >
                                UNDO
                            </button>
                        </div>
                    ))}
                </div>
            ) : null}
        </>
    );
}

export default memo(HardwareOrdersListInner);
