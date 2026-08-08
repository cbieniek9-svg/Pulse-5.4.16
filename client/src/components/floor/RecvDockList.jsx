import { memo } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorUi } from '../shared/NoticeProvider.jsx';

function RecvDockListInner() {
    const { syncData } = useSync();
    const { actions, showNotice, appConfirm, appPrompt } = useFloorUi();
    const onDock = syncData?.receiving_on_dock || [];

    if (syncData?.receiving_on_dock_error) {
        return (
            <div style={{ color: '#f44', fontSize: '0.85em', padding: 10, border: '1px solid #f44', borderRadius: 4, marginBottom: 8 }}>
                DOCK UNAVAILABLE — {syncData.receiving_on_dock_error}. Retry sync; do not assume no trucks.
            </div>
        );
    }

    if (!onDock.length) return null;

    const timeOut = async (expId) => {
        const row = onDock.find((e) => String(e.exp_id) === String(expId));
        const isTgp = /^TGP\b/i.test(String(row?.vendor || '').trim());
        if (isTgp) {
            if (!row?.pallet_count) {
                showNotice('Log TGP pallets on /rec (Chromebook) before time out.', 'error');
                return;
            }
            if (!(await appConfirm('Have you finished receiving the truck and all perishable items stored properly?'))) return;
        } else if (!(await appConfirm('Log TIME OUT for this vendor?'))) {
            return;
        }
        let createTask = '0';
        let startOrderClock = '0';
        if (isTgp) {
            createTask = (await appConfirm('Post Work the TGP order to All Staff?')) ? '1' : '0';
            const clockIdle = !syncData?.settings?.Order_Start;
            if (createTask === '1' && clockIdle) {
                startOrderClock = (await appConfirm('Also start the DRY (grocery) order clock?')) ? '1' : '0';
            }
        } else {
            createTask = (await appConfirm('Post work order to the board?')) ? '1' : '0';
        }
        const invoiceRef = String(await appPrompt('Invoice / Ref # (optional):') || '').trim();
        try {
            await actions.markRecvTimeOut(expId, {
                invoice_ref: invoiceRef,
                create_task: createTask,
                start_order_clock: startOrderClock,
                storage_confirmed: isTgp ? '1' : undefined,
            });
        } catch (e) {
            showNotice(e.message, 'error');
        }
    };

    return (
        <>
            <div style={{ fontSize: '0.7em', color: '#0f8', marginBottom: 6, letterSpacing: 1 }}>ON DOCK · TGP pallets on /rec (Chromebook)</div>
            {onDock.map((e) => (
                <div key={e.exp_id} className="data-card" style={{ borderColor: '#0f8' }}>
                    <div>
                        {e.vendor}
                        <br />
                        <small style={{ color: '#888' }}>
                            IN {new Date(e.arrived_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {' · '}
                            {e.arrived_by || ''}
                            {e.is_tgp ? ` · ${e.pallet_count || 0} pallet(s)` : ''}
                        </small>
                    </div>
                    <button type="button" className="done-btn" style={{ borderColor: '#8cf', color: '#8cf' }} onClick={() => timeOut(e.exp_id)}>TIME OUT</button>
                </div>
            ))}
        </>
    );
}

export default memo(RecvDockListInner);
