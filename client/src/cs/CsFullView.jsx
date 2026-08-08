import { useCallback, useEffect, useState } from 'react';
import {
    crmOn,
    csApiAction,
    getBetacsOrders,
    getBetacsRoutes,
    getBetacsTakenBy,
    getCustomerByPhone,
    printCsOrder,
    upper,
} from './csApi.js';
import { BackRow, PrintBtn, StatusCopy } from './csShared.jsx';

function BoardOrderCard({ order, nextStatus, btnLabel, onAdvance, onSaveNotes, busyId, token }) {
    const [editingNotes, setEditingNotes] = useState(false);
    const [notesDraft, setNotesDraft] = useState(order.notes || '');
    const [savingNotes, setSavingNotes] = useState(false);

    useEffect(() => {
        if (!editingNotes) setNotesDraft(order.notes || '');
    }, [order.notes, editingNotes]);

    const saveNotes = async () => {
        setSavingNotes(true);
        try {
            await onSaveNotes(order.order_id, notesDraft);
            setEditingNotes(false);
        } finally {
            setSavingNotes(false);
        }
    };

    const noteText = String(order.notes || '').trim();

    return (
        <div className="order-card">
            <div><strong>{order.customer}</strong> · L:{order.location}</div>
            <div className="items">{order.item}</div>
            <div className="meta">PH: {order.contact} · BY: {order.needed_by} · {order.route}</div>
            <div className="meta">TAKEN: {order.taken_by} · ENTERED: {order.logged_by || '—'}</div>
            {noteText && !editingNotes ? (
                <div className="order-notes" style={{ marginTop: 6, padding: '6px 8px', background: 'rgba(240,160,75,0.12)', borderRadius: 6, fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>
                    <strong>Notes:</strong> {noteText}
                </div>
            ) : null}
            {editingNotes ? (
                <div style={{ marginTop: 6 }}>
                    <label className="meta" htmlFor={`notes-${order.order_id}`}>Order notes (short / reorder / desk)</label>
                    <textarea
                        id={`notes-${order.order_id}`}
                        className="st-input"
                        rows={3}
                        value={notesDraft}
                        onChange={(e) => setNotesDraft(e.target.value)}
                        placeholder="e.g. Shorted 2 flats Aquafina — reorder Tue vendor"
                    />
                    <div className="card-actions" style={{ marginTop: 4 }}>
                        <button type="button" className="st-btn sm" disabled={savingNotes} onClick={saveNotes}>
                            {savingNotes ? 'Saving…' : 'Save notes'}
                        </button>
                        <button type="button" className="st-btn ghost sm" disabled={savingNotes} onClick={() => setEditingNotes(false)}>
                            Cancel
                        </button>
                    </div>
                </div>
            ) : null}
            <div className="card-actions">
                <PrintBtn orderId={order.order_id} token={token} />
                {!editingNotes ? (
                    <button type="button" className="st-btn ghost sm" onClick={() => setEditingNotes(true)}>
                        {noteText ? 'Edit notes' : 'Add notes'}
                    </button>
                ) : null}
                {nextStatus ? (
                    <button
                        type="button"
                        className="st-btn sm"
                        disabled={busyId === order.order_id}
                        onClick={() => onAdvance(order.order_id, nextStatus)}
                    >
                        {btnLabel}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function CsFullView({ portalCfg, user, token, fromHub, prefill, onBackHub, onOpenProfile }) {
    const [tab, setTab] = useState('log');
    const [routes, setRoutes] = useState([]);
    const [takenNames, setTakenNames] = useState([]);
    const [orders, setOrders] = useState({ New: [], Ordered: [], Ready: [] });
    const [form, setForm] = useState({
        customer: prefill?.customer || '',
        phone: prefill?.phone || '',
        needed: '',
        taken: user || '',
        route: '',
        item: '',
        loc: '1',
    });
    const [logStatus, setLogStatus] = useState({ message: '', tone: '' });
    const [boardStatus, setBoardStatus] = useState({ message: '', tone: '' });
    const [crmHint, setCrmHint] = useState({ show: false, html: null });
    const [savedOrderId, setSavedOrderId] = useState('');
    const [busyId, setBusyId] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const crmEnabled = crmOn(portalCfg);

    const loadOptions = useCallback(async () => {
        const [routesRes, namesRes] = await Promise.all([getBetacsRoutes(token), getBetacsTakenBy(token)]);
        const routeList = routesRes.routes || [];
        const nameList = namesRes.names || [];
        setRoutes(routeList);
        setTakenNames(nameList);
        setForm((f) => ({
            ...f,
            route: f.route || routeList[0] || '',
            taken: f.taken || user || '',
        }));
    }, [user, token]);

    const refreshBoard = useCallback(async () => {
        const { orders: list } = await getBetacsOrders(token);
        const by = { New: [], Ordered: [], Ready: [] };
        (list || []).forEach((o) => { if (by[o.status]) by[o.status].push(o); });
        setOrders(by);
    }, [token]);

    const lookupPhoneHint = useCallback(async (phone) => {
        if (!crmEnabled) {
            setCrmHint({ show: false, html: null });
            return;
        }
        const digits = String(phone || '').replace(/\D/g, '');
        if (digits.length < 7) {
            setCrmHint({ show: false, html: null });
            return;
        }
        try {
            const data = await getCustomerByPhone(phone, token);
            if (!data.customer) {
                setCrmHint({ show: true, text: 'New phone — a CRM profile will be created when you save.' });
                return;
            }
            const c = data.customer;
            const counts = data.counts || {};
            const prefs = String(c.prefs || '').trim();
            setCrmHint({
                show: true,
                customer: c,
                counts,
                prefs,
            });
            setForm((f) => (!f.customer.trim() && c.display_name ? { ...f, customer: c.display_name } : f));
        } catch {
            setCrmHint({ show: false, html: null });
        }
    }, [crmEnabled, token]);

    useEffect(() => {
        loadOptions().catch(() => setLogStatus({ message: 'Could not load form options.', tone: 'error' }));
    }, [loadOptions]);

    useEffect(() => {
        if (prefill?.phone) lookupPhoneHint(prefill.phone);
    }, [prefill, lookupPhoneHint]);

    useEffect(() => {
        if (tab !== 'board') return undefined;
        refreshBoard();
        const id = setInterval(refreshBoard, 12000);
        return () => clearInterval(id);
    }, [tab, refreshBoard]);

    const handleLogSubmit = async (e) => {
        e.preventDefault();
        if (!form.taken.trim()) {
            setLogStatus({ message: 'Who took the order is required.', tone: 'error' });
            return;
        }
        setSubmitting(true);
        setLogStatus({ message: '', tone: '' });
        setSavedOrderId('');
        const item = upper(form.item).replace(/\r?\n/g, ' + ');
        const orderId = `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();
        try {
            await csApiAction({
                table: 'special_orders',
                action: 'insert',
                data: {
                    order_id: orderId,
                    customer: upper(form.customer),
                    contact: form.phone.trim(),
                    needed_by: form.needed,
                    taken_by: form.taken,
                    route: form.route,
                    item,
                    location: form.loc,
                    status: 'New',
                    source: 'betacs',
                    closed_by: '',
                },
            }, user, token);
            setLogStatus({ message: 'Order saved as NEW — mark Ordered on the board for TV.', tone: 'success' });
            setSavedOrderId(orderId);
            setForm({
                customer: '',
                phone: '',
                needed: '',
                taken: user || '',
                route: routes[0] || '',
                item: '',
                loc: '1',
            });
            setCrmHint({ show: false, html: null });
        } catch (err) {
            setLogStatus({ message: err.message, tone: 'error' });
        }
        setSubmitting(false);
    };

    const handleBoardAdvance = async (orderId, next) => {
        setBusyId(orderId);
        setBoardStatus({ message: '', tone: '' });
        try {
            await csApiAction({
                table: 'special_orders',
                action: 'update',
                data: { status: next },
                id_col: 'order_id',
                id_val: orderId,
            }, user, token);
            await refreshBoard();
        } catch (err) {
            setBoardStatus({ message: err.message, tone: 'error' });
        }
        setBusyId('');
    };

    const handleSaveNotes = async (orderId, notes) => {
        setBoardStatus({ message: '', tone: '' });
        try {
            await csApiAction({
                table: 'special_orders',
                action: 'update',
                data: { notes: String(notes || '') },
                id_col: 'order_id',
                id_val: orderId,
            }, user, token);
            await refreshBoard();
            setBoardStatus({ message: 'Notes saved.', tone: 'success' });
        } catch (err) {
            setBoardStatus({ message: err.message, tone: 'error' });
            throw err;
        }
    };

    const setField = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

    return (
        <div className="wrap">
            {fromHub ? <BackRow user={user} onBackHub={onBackHub} /> : null}
            <div className="cs-title">CS_FULL</div>
            <div className="tabs">
                <button type="button" className={`tab-btn${tab === 'log' ? ' active' : ''}`} onClick={() => setTab('log')}>LOG ORDER</button>
                <button type="button" className={`tab-btn${tab === 'board' ? ' active' : ''}`} onClick={() => setTab('board')}>ORDER BOARD</button>
            </div>
            <div className={`panel${tab === 'log' ? ' active' : ''}`}>
                <div className="cs-box">
                    <div className={`crm-hint${crmHint.show ? ' show' : ''}`} data-testid="crm-phone-hint">
                        {crmHint.text ? crmHint.text : null}
                        {crmHint.customer ? (
                            <>
                                Known customer: <strong>{crmHint.customer.display_name}</strong>
                                {' · '}{Number(crmHint.counts?.past || 0)} past · {Number(crmHint.counts?.open || 0)} open
                                {crmHint.prefs ? <><br />Prefs: {crmHint.prefs.slice(0, 120)}</> : null}
                                {' · '}
                                <button
                                    type="button"
                                    className="st-btn ghost sm"
                                    onClick={() => onOpenProfile(crmHint.customer.customer_id)}
                                >
                                    Open profile
                                </button>
                            </>
                        ) : null}
                    </div>
                    <form onSubmit={handleLogSubmit}>
                        <div className="grid-2">
                            <div>
                                <label htmlFor="b-customer">Customer Name</label>
                                <input id="b-customer" className="st-input" required autoComplete="off" value={form.customer} onChange={setField('customer')} />
                            </div>
                            <div>
                                <label htmlFor="b-phone">Phone Number</label>
                                <input id="b-phone" className="st-input" type="tel" required autoComplete="off" value={form.phone} onChange={setField('phone')} onBlur={() => lookupPhoneHint(form.phone)} />
                            </div>
                        </div>
                        <div className="grid-2">
                            <div>
                                <label htmlFor="b-needed">Date Needed By</label>
                                <input id="b-needed" className="st-input" type="date" required value={form.needed} onChange={setField('needed')} />
                            </div>
                            <div>
                                <label htmlFor="b-taken">Who Took The Order</label>
                                <select id="b-taken" className="st-input" required value={form.taken} onChange={setField('taken')}>
                                    <option value="">— SELECT —</option>
                                    {takenNames.map((n) => <option key={n} value={n}>{n}</option>)}
                                    <option value="CS DESK">CS DESK</option>
                                </select>
                            </div>
                        </div>
                        <label htmlFor="b-route">Route / Department</label>
                        <select id="b-route" className="st-input" required value={form.route} onChange={setField('route')}>
                            {routes.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <label htmlFor="b-item">Items &amp; Quantities (one per line)</label>
                        <textarea id="b-item" className="st-input" placeholder="2X FLATS AQUAFINA&#10;1X COKE 12PK" required value={form.item} onChange={setField('item')} />
                        <label htmlFor="b-loc">Order Location</label>
                        <select id="b-loc" className="st-input" value={form.loc} onChange={setField('loc')}>
                            <option>1</option><option>2</option><option>3</option><option>22</option>
                        </select>
                        <button type="submit" id="b-submit" className="st-btn" disabled={submitting}>SAVE AS NEW</button>
                    </form>
                    <StatusCopy id="log-status" message={logStatus.message} tone={logStatus.tone} />
                    {savedOrderId ? (
                        <div style={{ marginTop: 8, textAlign: 'center' }}>
                            <button
                                type="button"
                                className="st-btn sm"
                                onClick={() => {
                                    printCsOrder(savedOrderId, token).catch((err) => {
                                        window.alert(err.message || 'Print failed');
                                    });
                                }}
                            >
                                PRINT SLIP
                            </button>
                        </div>
                    ) : null}
                    <p className="hint">Mark <strong>Ordered</strong> on the board for TV (location + items only). Entered by is recorded from your login when hub is on.</p>
                </div>
            </div>
            <div className={`panel${tab === 'board' ? ' active' : ''}`}>
                <div className="board-grid">
                    <div className="board-col">
                        <h3>New</h3>
                        {orders.New.length
                            ? orders.New.map((o) => (
                                <BoardOrderCard key={o.order_id} order={o} nextStatus="Ordered" btnLabel="MARK ORDERED → TV" onAdvance={handleBoardAdvance} onSaveNotes={handleSaveNotes} busyId={busyId} token={token} />
                            ))
                            : <div className="empty-col">None</div>}
                    </div>
                    <div className="board-col">
                        <h3>Ordered → TV</h3>
                        {orders.Ordered.length
                            ? orders.Ordered.map((o) => (
                                <BoardOrderCard key={o.order_id} order={o} nextStatus="Ready" btnLabel="MARK READY (OFF TV)" onAdvance={handleBoardAdvance} onSaveNotes={handleSaveNotes} busyId={busyId} token={token} />
                            ))
                            : <div className="empty-col">None</div>}
                    </div>
                    <div className="board-col">
                        <h3>Ready</h3>
                        {orders.Ready.length
                            ? orders.Ready.map((o) => (
                                <BoardOrderCard key={o.order_id} order={o} nextStatus="Complete" btnLabel="COMPLETE" onAdvance={handleBoardAdvance} onSaveNotes={handleSaveNotes} busyId={busyId} token={token} />
                            ))
                            : <div className="empty-col">None</div>}
                    </div>
                </div>
                <StatusCopy message={boardStatus.message} tone={boardStatus.tone} />
            </div>
        </div>
    );
}


export { CsFullView };
