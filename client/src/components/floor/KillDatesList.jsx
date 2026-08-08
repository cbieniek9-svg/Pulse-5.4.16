import { memo, useCallback } from 'react';
import { useSync } from '../../providers/SyncProvider.jsx';

function KillDatesListInner() {
    const { syncData, postAction } = useSync();
    const today = syncData?.storeDate || '';
    const activeKills = (syncData?.kill_dates || []).filter((k) => k.status === 'Active');
    const due = activeKills.filter((k) => k.kill_date && today && k.kill_date <= today);
    const upcoming = (syncData?.kill_warnings || []).filter((k) => k.status === 'Active');
    const visible = [...due, ...upcoming.filter((w) => !due.some((k) => k.id === w.id))];

    const handleKill = useCallback(async (id, pull) => {
        const msg = pull
            ? 'Mark this item as pulled? It will leave the live expiry board.'
            : 'Mark this item as sold through? It will leave the expiry board and no pull task will be created.';
        if (!window.confirm(msg)) return;
        await postAction({ table: 'kill_dates', action: 'update', data: { status: 'Closed' }, id_col: 'id', id_val: id });
    }, [postAction]);

    if (!visible.length) {
        return <div style={{ color: '#b0b0b0', textAlign: 'center', padding: '12px 0' }}>NO EXPIRY FLAGS</div>;
    }

    return (
        <>
            {visible.map((k) => {
                const pull = k.kill_date && today && k.kill_date <= today;
                return (
                    <div key={k.id} className={`data-card ${pull ? 'data-urgent' : 'data-high'}`}>
                        <div>
                            {pull ? 'PULL' : 'WARN'}: {k.item}
                            <br />
                            <small>{k.kill_date}{k.days_until != null ? ` · ${k.days_until}D` : ''}</small>
                        </div>
                        <button
                            type="button"
                            className="done-btn"
                            style={pull ? undefined : { borderColor: '#8cf', color: '#8cf' }}
                            onClick={() => handleKill(k.id, pull)}
                        >
                            {pull ? 'PULL' : 'SOLD'}
                        </button>
                    </div>
                );
            })}
        </>
    );
}

export default memo(KillDatesListInner);
