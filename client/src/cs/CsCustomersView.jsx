import { useEffect, useRef, useState } from 'react';
import { createCustomer, searchCustomers } from './csApi.js';
import { BackRow, StatusCopy } from './csShared.jsx';

function CsCustomersView({ user, token, onBackHub, onOpenProfile }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState(null);
    const [loading, setLoading] = useState(false);
    const [newName, setNewName] = useState('');
    const [newPhone, setNewPhone] = useState('');
    const [status, setStatus] = useState({ message: '', tone: '' });
    const timerRef = useRef(null);

    useEffect(() => {
        clearTimeout(timerRef.current);
        const q = query.trim();
        if (q.length < 2) {
            setResults(null);
            return undefined;
        }
        timerRef.current = setTimeout(async () => {
            setLoading(true);
            try {
                const data = await searchCustomers(q, token);
                setResults(data.customers || []);
            } catch (err) {
                setResults([]);
                setStatus({ message: err.message, tone: 'error' });
            }
            setLoading(false);
        }, 250);
        return () => clearTimeout(timerRef.current);
    }, [query, token]);

    const handleCreate = async () => {
        if (!newName.trim() || !newPhone.trim()) {
            setStatus({ message: 'Name and phone required.', tone: 'error' });
            return;
        }
        try {
            const data = await createCustomer(newName.trim(), newPhone.trim(), token);
            onOpenProfile(data.customer.customer_id);
        } catch (err) {
            setStatus({ message: err.message, tone: 'error' });
        }
    };

    return (
        <div className="wrap">
            <BackRow user={user} onBackHub={onBackHub} />
            <div className="cs-title">CUSTOMERS</div>
            <div className="due-search-wrap">
                <label htmlFor="crm-search">Find by name, phone, tag, or email</label>
                <input
                    id="crm-search"
                    className="st-input"
                    type="search"
                    autoComplete="off"
                    placeholder="e.g. SMITH, bakery, or 555-1234"
                    data-testid="crm-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <p className="hint" style={{ marginTop: 0 }}>Walk-in: search phone → open profile → clear pickup or take a new order.</p>
            </div>
            <div className={loading ? 'loading' : ''}>
                {!query.trim() || query.trim().length < 2
                    ? 'Type at least 2 letters or 3 phone digits…'
                    : loading
                        ? 'SEARCHING…'
                        : null}
                {!loading && results && results.length === 0 ? <div className="empty-col">No matches — create below.</div> : null}
                {!loading && results?.map((c) => {
                    const counts = c.counts || {};
                    const vip = Number(c.vip || 0) === 1;
                    const alert = Number(c.alert_flag || 0) === 1;
                    return (
                        <div
                            key={c.customer_id}
                            className="crm-result"
                            data-testid="crm-result"
                            role="button"
                            tabIndex={0}
                            onClick={() => onOpenProfile(c.customer_id)}
                            onKeyDown={(e) => { if (e.key === 'Enter') onOpenProfile(c.customer_id); }}
                        >
                            <strong>{c.display_name}</strong>
                            {vip ? <span className="crm-pill vip">VIP</span> : null}
                            {alert ? <span className="crm-pill alert">ALERT</span> : null}
                            {' '}· {c.phone_display || c.phone_digits}
                            <div className="meta" style={{ color: '#c4b5fd', marginTop: 4, fontSize: '0.75em' }}>
                                {Number(counts.open || 0)} open · {Number(counts.past || 0)} past
                                {c.tags ? ` · ${String(c.tags).slice(0, 40)}` : ''}
                                {c.prefs ? ` · ${String(c.prefs).slice(0, 50)}` : ''}
                            </div>
                        </div>
                    );
                })}
            </div>
            <StatusCopy message={status.message} tone={status.tone} />
            <div className="cs-box" style={{ margin: '24px auto 0', maxWidth: 500 }}>
                <div className="cs-title" style={{ fontSize: '1.2em', marginBottom: 16 }}>New customer</div>
                <label htmlFor="crm-new-name">Name</label>
                <input id="crm-new-name" className="st-input" autoComplete="off" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <label htmlFor="crm-new-phone">Phone</label>
                <input id="crm-new-phone" className="st-input" type="tel" autoComplete="off" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
                <button type="button" className="st-btn" onClick={handleCreate}>CREATE / FIND</button>
            </div>
        </div>
    );
}


export { CsCustomersView };
