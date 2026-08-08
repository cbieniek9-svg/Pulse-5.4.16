import { useCallback, useEffect, useState } from 'react';
import { csApiAction, getDueOrders, orderMatchesQuery } from './csApi.js';
import { BackRow, PrintBtn, StatusCopy } from './csShared.jsx';

function DueOrderCard({ order, storeDate, onComplete, onOpenFull, busyId, token }) {
    const overdue = String(order.needed_by || '').slice(0, 10) < (storeDate || '');
    const ready = order.status === 'Ready';
    const showClear = ready || order.status === 'Ordered' || order.status === 'New';

    return (
        <div className={`order-card${overdue ? ' overdue' : ''}${order._hidden ? ' hidden-card' : ''}`}>
            <div>
                <strong>{order.customer}</strong> · {order.status} · L:{order.location}
                {order.route ? ` · ${order.route}` : ''}
            </div>
            <div className="items">{order.item}</div>
            <div className="meta">NEEDED: {order.needed_by} · PH: {order.contact}</div>
            <div className="meta">ENTERED: {order.logged_by || '—'} · TAKEN: {order.taken_by || '—'}</div>
            <div className="card-actions">
                <PrintBtn orderId={order.order_id} token={token} />
                {showClear ? (
                    <button
                        type="button"
                        className="st-btn sm"
                        disabled={busyId === order.order_id}
                        onClick={() => onComplete(order.order_id)}
                    >
                        {ready ? 'MARK PICKED UP' : 'CLEAR (CUSTOMER HERE)'}
                    </button>
                ) : (
                    <button type="button" className="st-btn sm ghost" onClick={onOpenFull}>OPEN IN CS_FULL</button>
                )}
            </div>
        </div>
    );
}

function CsDueBoardView({ user, token, onBackHub, onOpenFull }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [storeDate, setStoreDate] = useState('');
    const [sections, setSections] = useState({ ready: [], overdue: [], dueToday: [], upcoming: [] });
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState({ message: '', tone: '' });
    const [busyId, setBusyId] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await getDueOrders(token);
            const stamp = (rows) => (rows || []).map((o) => ({ ...o, _storeDate: data.store_date }));
            const all = [...stamp(data.overdue), ...stamp(data.dueToday), ...stamp(data.upcoming)];
            setStoreDate(data.store_date);
            setSections({
                ready: all.filter((o) => o.status === 'Ready'),
                overdue: stamp(data.overdue).filter((o) => o.status !== 'Ready'),
                dueToday: stamp(data.dueToday).filter((o) => o.status !== 'Ready'),
                upcoming: stamp(data.upcoming).filter((o) => o.status !== 'Ready'),
            });
        } catch (err) {
            setError(err.message);
        }
        setLoading(false);
    }, [token]);

    useEffect(() => { load(); }, [load]);

    const q = search.trim().toLowerCase();
    const filterOrders = (list) => list.map((o) => ({ ...o, _hidden: q ? !orderMatchesQuery(o, q) : false }));
    const ready = filterOrders(sections.ready);
    const overdue = filterOrders(sections.overdue);
    const dueToday = filterOrders(sections.dueToday);
    const upcoming = filterOrders(sections.upcoming);
    const shownCount = [...ready, ...overdue, ...dueToday, ...upcoming].filter((o) => !o._hidden).length;

    const sectionVisible = (list) => !q || list.some((o) => !o._hidden);

    const handleComplete = async (orderId) => {
        setBusyId(orderId);
        setStatus({ message: '', tone: '' });
        try {
            await csApiAction({
                table: 'special_orders',
                action: 'update',
                data: { status: 'Complete' },
                id_col: 'order_id',
                id_val: orderId,
            }, user, token);
            await load();
        } catch (err) {
            setStatus({ message: err.message, tone: 'error' });
        }
        setBusyId('');
    };

    return (
        <div className="wrap">
            <BackRow user={user} onBackHub={onBackHub} />
            <div className="cs-title">DUE / PICKUPS</div>
            <div className="due-search-wrap">
                <label htmlFor="due-search">Find customer (name or phone)</label>
                <input
                    id="due-search"
                    className="st-input"
                    type="search"
                    autoComplete="off"
                    placeholder="e.g. SMITH or 555-1234"
                    data-testid="due-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <p className="hint" style={{ marginTop: 0 }}>Walk-in at the desk: type their name or last digits of the phone, then MARK PICKED UP.</p>
            </div>
            {loading ? <div className="loading">LOADING…</div> : null}
            {error ? <StatusCopy message={error} tone="error" /> : null}
            {!loading && !error ? (
                <>
                    {sectionVisible(ready) ? (
                        <div className="due-section">
                            <h3>READY FOR PICKUP ({sections.ready.length})</h3>
                            {ready.length
                                ? ready.map((o) => (
                                    <DueOrderCard key={o.order_id} order={o} storeDate={storeDate} onComplete={handleComplete} onOpenFull={onOpenFull} busyId={busyId} token={token} />
                                ))
                                : <div className="empty-col">None waiting</div>}
                        </div>
                    ) : null}
                    {sectionVisible(overdue) ? (
                        <div className="due-section">
                            <h3>OVERDUE ({sections.overdue.length})</h3>
                            {overdue.length
                                ? overdue.map((o) => (
                                    <DueOrderCard key={o.order_id} order={o} storeDate={storeDate} onComplete={handleComplete} onOpenFull={onOpenFull} busyId={busyId} token={token} />
                                ))
                                : <div className="empty-col">None</div>}
                        </div>
                    ) : null}
                    {sectionVisible(dueToday) ? (
                        <div className="due-section">
                            <h3>DUE TODAY ({sections.dueToday.length})</h3>
                            {dueToday.length
                                ? dueToday.map((o) => (
                                    <DueOrderCard key={o.order_id} order={o} storeDate={storeDate} onComplete={handleComplete} onOpenFull={onOpenFull} busyId={busyId} token={token} />
                                ))
                                : <div className="empty-col">None</div>}
                        </div>
                    ) : null}
                    {sectionVisible(upcoming) ? (
                        <div className="due-section">
                            <h3>UPCOMING ({sections.upcoming.length})</h3>
                            {upcoming.length
                                ? upcoming.map((o) => (
                                    <DueOrderCard key={o.order_id} order={o} storeDate={storeDate} onComplete={handleComplete} onOpenFull={onOpenFull} busyId={busyId} token={token} />
                                ))
                                : <div className="empty-col">None</div>}
                        </div>
                    ) : null}
                    <div className={`due-empty-search${q && shownCount === 0 ? ' show' : ''}`}>
                        No open orders match that name or phone.
                    </div>
                    <p className="hint">Store date: {storeDate} · Orders live in this store&apos;s tgp_ops.db (not a separate customer database).</p>
                </>
            ) : null}
            <StatusCopy message={status.message} tone={status.tone} />
        </div>
    );
}


export { CsDueBoardView };
