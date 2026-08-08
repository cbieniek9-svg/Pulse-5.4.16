import { memo, useCallback } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorUi } from '../shared/NoticeProvider.jsx';

/** Pending expected deliveries only — on-dock TIME OUT lives in RecvDockList. */
function VendorDeliveriesListInner() {
    const { syncData } = useSync();
    const { actions, showNotice } = useFloorUi();

    const markTimeIn = useCallback(async (expId) => {
        try {
            const ok = await actions.markRecvTimeIn(expId);
            if (ok) showNotice('Time in logged', 'success');
        } catch (e) {
            showNotice(e.message || 'Time in failed', 'error');
        }
    }, [actions, showNotice]);

    const removePending = useCallback(async (expId) => {
        try {
            await actions.removePendingDelivery(expId);
        } catch (e) {
            showNotice(e.message || 'Remove failed', 'error');
        }
    }, [actions, showNotice]);

    const expected = syncData?.expected || [];

    return (
        <>
            {expected.length ? expected.map((e) => (
                <div key={e.exp_id} className="data-card" style={{ borderColor: '#f90' }}>
                    <div>{e.vendor}</div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                        <button type="button" className="done-btn" onClick={() => markTimeIn(e.exp_id)}>TIME IN</button>
                        <button type="button" className="done-btn" style={{ borderColor: '#f33', color: '#f33' }} onClick={() => removePending(e.exp_id)}>REMOVE</button>
                    </div>
                </div>
            )) : <div style={{ color: '#b0b0b0' }}>NONE</div>}
        </>
    );
}

export default memo(VendorDeliveriesListInner);
