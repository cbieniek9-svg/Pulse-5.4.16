import { memo, useCallback } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';

function OosListInner() {
    const { syncData, postAction } = useSync();
    const oos = syncData?.oos || [];

    const handleClear = useCallback(async (oosId, zone, btn) => {
        if (!oosId) return;
        btn.disabled = true;
        btn.style.opacity = '0.5';
        try {
            await postAction({
                table: 'oos',
                action: 'update',
                data: { status: 'Closed', zone },
                id_col: 'oos_id',
                id_val: oosId,
            });
        } catch (err) {
            console.error('[OOS]', err.message);
        } finally {
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    }, [postAction]);

    if (!oos.length) {
        return <>NONE</>;
    }

    return (
        <>
            {oos.map((o) => (
                <div key={o.oos_id} className="data-card data-urgent">
                    <div>{o.zone}: {o.hole_count}H</div>
                    <button
                        type="button"
                        className="done-btn"
                        data-oos-id={o.oos_id}
                        data-zone={o.zone}
                        onClick={(ev) => handleClear(o.oos_id, o.zone, ev.currentTarget)}
                    >
                        CLR
                    </button>
                </div>
            ))}
        </>
    );
}

const OosList = memo(OosListInner);
export default OosList;
