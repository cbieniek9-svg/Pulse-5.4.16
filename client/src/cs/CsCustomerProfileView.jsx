import { useCallback, useEffect, useState } from 'react';
import { addCustomerEvent, csApiAction, getCustomer, updateCustomer } from './csApi.js';
import { BackRow, PrintBtn, StatusCopy } from './csShared.jsx';

const EVENT_QUICK = [
    { type: 'call', label: 'CALL' },
    { type: 'note', label: 'NOTE' },
    { type: 'short', label: 'SHORT' },
    { type: 'reorder', label: 'REORDER' },
    { type: 'complaint', label: 'COMPLAINT' },
    { type: 'pickup', label: 'PICKUP' },
];

function CrmOrderCard({ order, onComplete, busyId, token }) {
    const canClear = ['New', 'Ordered', 'Ready'].includes(order.status);
    const notes = String(order.notes || '').trim();
    return (
        <div className="order-card">
            <div><strong>{order.status}</strong> · L:{order.location} · {order.needed_by || ''}</div>
            <div className="items">{order.item}</div>
            {notes ? <div className="crm-order-notes">{notes}</div> : null}
            <div className="meta">{order.route || ''} · {order.time_logged || ''}</div>
            <div className="card-actions">
                <PrintBtn orderId={order.order_id} token={token} />
                {canClear ? (
                    <button
                        type="button"
                        className="st-btn sm"
                        disabled={busyId === order.order_id}
                        onClick={() => onComplete(order.order_id)}
                    >
                        {order.status === 'Ready' ? 'MARK PICKED UP' : 'CLEAR (CUSTOMER HERE)'}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

function EventRow({ event }) {
    const when = String(event.created_at || '').replace('T', ' ').slice(0, 16);
    return (
        <div className="crm-event">
            <div className="crm-event-head">
                <span className={`crm-pill type-${event.event_type}`}>{String(event.event_type || 'note').toUpperCase()}</span>
                <span className="meta">{when}{event.created_by ? ` · ${event.created_by}` : ''}</span>
            </div>
            <div>{event.body}</div>
        </div>
    );
}

function CsCustomerProfileView({ user, token, customerId, onBackCustomers, onBackHub, onNewOrder }) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [profile, setProfile] = useState(null);
    const [openOrders, setOpenOrders] = useState([]);
    const [pastOrders, setPastOrders] = useState([]);
    const [events, setEvents] = useState([]);
    const [counts, setCounts] = useState({});
    const [form, setForm] = useState({
        name: '',
        phone: '',
        email: '',
        address_line: '',
        tags: '',
        preferred_contact: '',
        notes: '',
        prefs: '',
        vip: false,
        alert_flag: false,
    });
    const [eventBody, setEventBody] = useState('');
    const [eventType, setEventType] = useState('note');
    const [status, setStatus] = useState({ message: '', tone: '' });
    const [busyId, setBusyId] = useState('');
    const [logging, setLogging] = useState(false);

    const applyProfile = (data) => {
        const c = data.customer;
        setProfile(c);
        setOpenOrders(data.open || []);
        setPastOrders(data.past || []);
        setEvents(data.events || []);
        setCounts(data.counts || {});
        setForm({
            name: c.display_name || '',
            phone: c.phone_display || c.phone_digits || '',
            email: c.email || '',
            address_line: c.address_line || '',
            tags: c.tags || '',
            preferred_contact: c.preferred_contact || '',
            notes: c.notes || '',
            prefs: c.prefs || '',
            vip: Number(c.vip || 0) === 1,
            alert_flag: Number(c.alert_flag || 0) === 1,
        });
    };

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await getCustomer(customerId, token);
            applyProfile(data);
        } catch (err) {
            setError(err.message);
        }
        setLoading(false);
    }, [customerId, token]);

    useEffect(() => { load(); }, [load]);

    const handleSave = async () => {
        try {
            const data = await updateCustomer(customerId, {
                display_name: form.name,
                phone: form.phone,
                email: form.email,
                address_line: form.address_line,
                tags: form.tags,
                preferred_contact: form.preferred_contact,
                notes: form.notes,
                prefs: form.prefs,
                vip: form.vip,
                alert_flag: form.alert_flag,
            }, token);
            if (data.customer) {
                setProfile(data.customer);
                setCounts(data.counts || counts);
            }
            setStatus({ message: 'Profile saved.', tone: 'success' });
        } catch (err) {
            setStatus({ message: err.message, tone: 'error' });
        }
    };

    const handleLogEvent = async (forcedType) => {
        const type = forcedType || eventType;
        if (!eventBody.trim()) {
            setStatus({ message: 'Enter activity text first.', tone: 'error' });
            return;
        }
        setLogging(true);
        try {
            const data = await addCustomerEvent(customerId, {
                event_type: type,
                body: eventBody.trim(),
                created_by: user?.display_name || user?.username || '',
            }, token);
            if (data.profile) applyProfile(data.profile);
            setEventBody('');
            setStatus({ message: `${String(type).toUpperCase()} logged.`, tone: 'success' });
        } catch (err) {
            setStatus({ message: err.message, tone: 'error' });
        }
        setLogging(false);
    };

    const handleComplete = async (orderId) => {
        setBusyId(orderId);
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
            <BackRow user={user} onBackHub={onBackHub} onBackCustomers={onBackCustomers} />
            <div className="cs-title">CUSTOMER</div>
            {loading ? <div className="loading">LOADING…</div> : null}
            {error ? <StatusCopy message={error} tone="error" /> : null}
            {!loading && !error && profile ? (
                <>
                    <div className="crm-stats">
                        <div><strong>{Number(counts.open || 0)}</strong><span>open</span></div>
                        <div><strong>{Number(counts.past || 0)}</strong><span>past</span></div>
                        <div><strong>{Number(counts.shorts || 0)}</strong><span>shorts</span></div>
                        <div><strong>{events.length}</strong><span>activity</span></div>
                    </div>
                    {(form.vip || form.alert_flag) ? (
                        <div className="crm-flags-banner">
                            {form.vip ? <span className="crm-pill vip">VIP</span> : null}
                            {form.alert_flag ? <span className="crm-pill alert">ALERT</span> : null}
                        </div>
                    ) : null}
                    <div className="cs-box" style={{ maxWidth: 720, margin: '0 auto 20px' }}>
                        <label htmlFor="crm-name">Name</label>
                        <input id="crm-name" className="st-input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                        <label htmlFor="crm-phone">Phone</label>
                        <input id="crm-phone" className="st-input" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
                        <div className="crm-notes-grid">
                            <div>
                                <label htmlFor="crm-email">Email</label>
                                <input id="crm-email" className="st-input" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
                            </div>
                            <div>
                                <label htmlFor="crm-contact">Preferred contact</label>
                                <input id="crm-contact" className="st-input" placeholder="call / text / email" value={form.preferred_contact} onChange={(e) => setForm((f) => ({ ...f, preferred_contact: e.target.value }))} />
                            </div>
                        </div>
                        <label htmlFor="crm-address">Address</label>
                        <input id="crm-address" className="st-input" value={form.address_line} onChange={(e) => setForm((f) => ({ ...f, address_line: e.target.value }))} />
                        <label htmlFor="crm-tags">Tags</label>
                        <input id="crm-tags" className="st-input" placeholder="e.g. bakery, weekly, catering" value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} />
                        <div className="crm-flag-row">
                            <label>
                                <input type="checkbox" checked={form.vip} onChange={(e) => setForm((f) => ({ ...f, vip: e.target.checked }))} />
                                {' '}VIP
                            </label>
                            <label>
                                <input type="checkbox" checked={form.alert_flag} onChange={(e) => setForm((f) => ({ ...f, alert_flag: e.target.checked }))} />
                                {' '}Alert (handle carefully)
                            </label>
                        </div>
                        <div className="crm-notes-grid">
                            <div>
                                <label htmlFor="crm-notes">Standing notes</label>
                                <textarea id="crm-notes" className="st-input" rows={3} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
                            </div>
                            <div>
                                <label htmlFor="crm-prefs">Prefs / allergies</label>
                                <textarea id="crm-prefs" className="st-input" rows={3} placeholder="e.g. always dairy, no nuts" value={form.prefs} onChange={(e) => setForm((f) => ({ ...f, prefs: e.target.value }))} />
                            </div>
                        </div>
                        <button type="button" className="st-btn" onClick={handleSave}>SAVE PROFILE</button>
                        <button type="button" className="st-btn ghost" style={{ marginTop: 10 }} onClick={() => onNewOrder({ customer: form.name, phone: form.phone })}>
                            NEW ORDER (PREFILL)
                        </button>
                    </div>

                    <div className="cs-box" style={{ maxWidth: 720, margin: '0 auto 20px' }}>
                        <div className="cs-title" style={{ fontSize: '1.1em', marginBottom: 12 }}>ACTIVITY LOG</div>
                        <label htmlFor="crm-event-body">Log call / short / note</label>
                        <textarea
                            id="crm-event-body"
                            className="st-input"
                            rows={2}
                            placeholder="What happened?"
                            value={eventBody}
                            onChange={(e) => setEventBody(e.target.value)}
                        />
                        <div className="crm-event-actions">
                            {EVENT_QUICK.map((q) => (
                                <button
                                    key={q.type}
                                    type="button"
                                    className={`st-btn sm ghost${eventType === q.type ? ' active' : ''}`}
                                    disabled={logging}
                                    onClick={() => {
                                        setEventType(q.type);
                                        handleLogEvent(q.type);
                                    }}
                                >
                                    {q.label}
                                </button>
                            ))}
                        </div>
                        <div className="crm-event-list">
                            {events.length
                                ? events.map((ev) => <EventRow key={ev.event_id} event={ev} />)
                                : <div className="empty-col">No activity yet</div>}
                        </div>
                    </div>

                    <div className="due-section">
                        <h3>OPEN ORDERS ({openOrders.length})</h3>
                        {openOrders.length
                            ? openOrders.map((o) => <CrmOrderCard key={o.order_id} order={o} onComplete={handleComplete} busyId={busyId} token={token} />)
                            : <div className="empty-col">None</div>}
                    </div>
                    <div className="due-section">
                        <h3>PAST ORDERS ({pastOrders.length})</h3>
                        {pastOrders.length
                            ? pastOrders.map((o) => <CrmOrderCard key={o.order_id} order={o} onComplete={handleComplete} busyId={busyId} token={token} />)
                            : <div className="empty-col">None yet</div>}
                    </div>
                </>
            ) : null}
            <StatusCopy message={status.message} tone={status.tone} />
        </div>
    );
}

export { CsCustomerProfileView };
