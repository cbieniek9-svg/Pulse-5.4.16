import { memo, useCallback, useState } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';
import { useFloorUi } from '../shared/NoticeProvider.jsx';

function CustomerOrdersListInner() {
    const { syncData, postAction } = useSync();
    const { showNotice } = useFloorUi();
    const [busyId, setBusyId] = useState(null);
    const orders = [...(syncData?.orders || [])].sort((a, b) => {
        const rank = (o) => {
            if (o.source === 'betacs' && o.status === 'Ready') return 0;
            if (o.source === 'betacs' && o.status === 'Ordered') return 1;
            if (o.source === 'betacs') return 2;
            return 3;
        };
        return rank(a) - rank(b);
    });

    // Mirror public/js/mobile/handlers.js completeOrder — API table is special_orders,
    // not the sync payload field name "orders".
    const completeOrder = useCallback(async (order) => {
        const orderId = order?.order_id;
        if (!orderId || busyId) return;
        const status = order?.source === 'betacs' ? 'Complete' : 'Closed';
        setBusyId(orderId);
        try {
            await postAction({
                table: 'special_orders',
                action: 'update',
                data: { status },
                id_col: 'order_id',
                id_val: orderId,
            });
        } catch (e) {
            showNotice(e.message || 'Could not clear order', 'error');
        } finally {
            setBusyId(null);
        }
    }, [busyId, postAction, showNotice]);

    if (!orders.length) return <div style={{ color: '#b0b0b0' }}>NONE</div>;

    return (
        <>
            {orders.map((o) => {
                const isCsFull = o.source === 'betacs';
                const ready = isCsFull && o.status === 'Ready';
                const btnLabel = ready ? 'PICKED UP' : (isCsFull ? 'CLEAR' : 'DONE');
                const pending = String(busyId) === String(o.order_id);
                return (
                    <div key={o.order_id} className="data-card" style={{ borderColor: ready ? '#22c55e' : '#a855f7' }}>
                        {o.customer ? (
                            <div style={{ fontSize: '0.85em', color: '#fff', marginBottom: 2 }}>
                                {o.customer}{o.contact ? ` · ${o.contact}` : ''}
                            </div>
                        ) : null}
                        <div>
                            L:{o.location}: {o.item}
                            {isCsFull && o.status && o.status !== 'Open' ? (
                                <small style={{ color: ready ? '#86efac' : '#c4b5fd' }}>
                                    {' '}({ready ? 'READY · PICKUP' : o.status})
                                </small>
                            ) : null}
                        </div>
                        <button
                            type="button"
                            className="done-btn"
                            disabled={pending}
                            style={pending ? { opacity: 0.5 } : undefined}
                            onClick={() => completeOrder(o)}
                        >
                            {btnLabel}
                        </button>
                    </div>
                );
            })}
        </>
    );
}

export default memo(CustomerOrdersListInner);
