import { useMemo, useState } from 'react';
import SessionCard from './SessionCard.jsx';

function splitByType(sessions) {
    const backstock = [];
    const order = [];
    const location = [];
    for (const s of sessions || []) {
        const t = s.session_type || 'location';
        if (t === 'backstock') backstock.push(s);
        else if (t === 'order') order.push(s);
        else location.push(s);
    }
    return { backstock, order, location };
}

function filterByType(sessions, typeFilter) {
    if (!typeFilter || typeFilter === 'all') return sessions || [];
    return (sessions || []).filter((s) => (s.session_type || 'location') === typeFilter);
}

export default function CountHomeScreen({
    user,
    openSessions,
    pastSessions,
    listError,
    onStartLocation,
    onStartBackstock,
    onStartOrderDraft,
    onContinue,
    onEdit,
    onReopenScan,
    onViewOrderReport,
    onLogout,
}) {
    const [tab, setTab] = useState('work'); // work | history
    const [historyFilter, setHistoryFilter] = useState('all'); // all | location | backstock | order
    const [startKind, setStartKind] = useState('location'); // which start form is expanded
    const [location, setLocation] = useState('');
    const [backstockBay, setBackstockBay] = useState('');
    const [orderLabel, setOrderLabel] = useState('');
    const [starting, setStarting] = useState(false);

    const open = splitByType(openSessions);
    const past = splitByType(pastSessions);
    const openTotal = (openSessions || []).length;
    const pastTotal = (pastSessions || []).length;
    const historyList = useMemo(
        () => filterByType(pastSessions, historyFilter),
        [pastSessions, historyFilter],
    );

    const run = async (fn) => {
        setStarting(true);
        try { await fn(); } finally { setStarting(false); }
    };

    return (
        <div className="container">
            <div className="header">
                <div>
                    <div className="title">COUNT HOME</div>
                    <div style={{ fontSize: '0.72em', color: '#888', marginTop: 4 }}>
                        Location: case or unit · Backstock / order: cases only
                    </div>
                </div>
                <div style={{ fontSize: '0.8em', color: '#f90' }}>{user || ''}</div>
            </div>

            <div className="count-tabs" role="tablist" aria-label="Count sections">
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'work'}
                    className={`count-tab ${tab === 'work' ? 'active' : ''}`}
                    onClick={() => setTab('work')}
                >
                    WORK ({openTotal})
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'history'}
                    className={`count-tab ${tab === 'history' ? 'active' : ''}`}
                    onClick={() => setTab('history')}
                >
                    HISTORY ({pastTotal})
                </button>
            </div>

            {listError ? <div className="empty status-err">{listError}</div> : null}

            {tab === 'work' ? (
                <>
                    <div className="section-label" style={{ marginTop: 14 }}>START A COUNT</div>
                    <div className="count-kind-row">
                        <button
                            type="button"
                            className={`btn btn-sm ${startKind === 'location' ? 'btn-warn' : 'btn-secondary'}`}
                            onClick={() => setStartKind('location')}
                        >
                            LOCATION
                        </button>
                        <button
                            type="button"
                            className={`btn btn-sm ${startKind === 'backstock' ? 'btn-warn' : 'btn-secondary'}`}
                            onClick={() => setStartKind('backstock')}
                        >
                            BACKSTOCK
                        </button>
                        <button
                            type="button"
                            className={`btn btn-sm ${startKind === 'order' ? 'btn-warn' : 'btn-secondary'}`}
                            onClick={() => setStartKind('order')}
                        >
                            ORDER DRAFT
                        </button>
                    </div>

                    {startKind === 'location' ? (
                        <form
                            className="add-box"
                            onSubmit={(e) => {
                                e.preventDefault();
                                const trimmed = location.trim();
                                if (!trimmed) {
                                    window.alert('Enter a location (aisle / bay / area).');
                                    return;
                                }
                                void run(async () => {
                                    await onStartLocation(trimmed);
                                    setLocation('');
                                });
                            }}
                        >
                            <p className="hint" style={{ marginTop: 0 }}>
                                Aisle / freezer / bay walk. Choose Case or Unit on each scan. Close when done.
                            </p>
                            <label className="field-label" htmlFor="location-input">Location</label>
                            <input
                                id="location-input"
                                className="input"
                                type="text"
                                autoComplete="off"
                                placeholder="e.g. A3, Freezer Bay 2"
                                value={location}
                                onChange={(e) => setLocation(e.target.value)}
                            />
                            <button type="submit" className="btn btn-secondary" style={{ width: '100%' }} disabled={starting}>
                                OPEN LOCATION COUNT
                            </button>
                        </form>
                    ) : null}

                    {startKind === 'backstock' ? (
                        <form
                            className="add-box"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void run(() => onStartBackstock(backstockBay.trim()));
                                setBackstockBay('');
                            }}
                        >
                            <p className="hint" style={{ marginTop: 0 }}>
                                Cases only. CLOSE &amp; COMMIT so Pulse remembers UPC × bay for order matching.
                            </p>
                            <label className="field-label" htmlFor="backstock-bay">Bay / area (optional)</label>
                            <input
                                id="backstock-bay"
                                className="input"
                                type="text"
                                autoComplete="off"
                                placeholder="e.g. Cooler, Dry Bay 2"
                                value={backstockBay}
                                onChange={(e) => setBackstockBay(e.target.value)}
                            />
                            <button type="submit" className="btn btn-warn" style={{ width: '100%' }} disabled={starting}>
                                START BACKSTOCK COUNT
                            </button>
                        </form>
                    ) : null}

                    {startKind === 'order' ? (
                        <form
                            className="add-box"
                            onSubmit={(e) => {
                                e.preventDefault();
                                void run(() => onStartOrderDraft(orderLabel.trim()));
                                setOrderLabel('');
                            }}
                        >
                            <p className="hint" style={{ marginTop: 0 }}>
                                Cases only. Finalize uses committed backstock → pick list + clean order.
                            </p>
                            <label className="field-label" htmlFor="order-label">Label (optional)</label>
                            <input
                                id="order-label"
                                className="input"
                                type="text"
                                autoComplete="off"
                                placeholder="e.g. Tuesday grocery"
                                value={orderLabel}
                                onChange={(e) => setOrderLabel(e.target.value)}
                            />
                            <button type="submit" className="btn btn-warn" style={{ width: '100%' }} disabled={starting}>
                                START ORDER DRAFT
                            </button>
                        </form>
                    ) : null}

                    <div className="section-label">OPEN NOW</div>
                    {!openTotal ? (
                        <div className="empty">No open counts. Start one above.</div>
                    ) : (
                        <>
                            <Section title={`LOCATION (${open.location.length})`} empty="None open." sessions={open.location} {...{ onContinue, onEdit, onReopenScan, onViewOrderReport }} />
                            <Section title={`BACKSTOCK (${open.backstock.length})`} empty="None open." sessions={open.backstock} {...{ onContinue, onEdit, onReopenScan, onViewOrderReport }} />
                            <Section title={`ORDER DRAFTS (${open.order.length})`} empty="None open." sessions={open.order} {...{ onContinue, onEdit, onReopenScan, onViewOrderReport }} />
                        </>
                    )}
                </>
            ) : (
                <>
                    <p className="hint" style={{ marginTop: 12 }}>
                        Closed / exported / committed counts of every type. Reopen needs manager PIN.
                    </p>
                    <div className="count-kind-row" style={{ marginBottom: 8 }}>
                        {[
                            ['all', `ALL (${pastTotal})`],
                            ['location', `LOC (${past.location.length})`],
                            ['backstock', `BACK (${past.backstock.length})`],
                            ['order', `ORDER (${past.order.length})`],
                        ].map(([key, label]) => (
                            <button
                                key={key}
                                type="button"
                                className={`btn btn-sm ${historyFilter === key ? 'btn-warn' : 'btn-secondary'}`}
                                onClick={() => setHistoryFilter(key)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {!historyList.length ? (
                        <div className="empty">No past counts in this filter.</div>
                    ) : (
                        historyList.map((s) => (
                            <SessionCard
                                key={s.id}
                                session={s}
                                past
                                onContinue={onContinue}
                                onEdit={onEdit}
                                onReopenScan={onReopenScan}
                                onViewOrderReport={onViewOrderReport}
                            />
                        ))
                    )}
                </>
            )}

            <div className="actions">
                <button type="button" className="btn btn-secondary" style={{ width: '100%' }} onClick={onLogout}>
                    LOGOUT
                </button>
            </div>
        </div>
    );
}

function Section({ title, empty, sessions, past = false, onContinue, onEdit, onReopenScan, onViewOrderReport }) {
    if (!sessions.length) return null;
    return (
        <>
            <div className="section-label" style={{ marginTop: 12 }}>{title}</div>
            {sessions.length ? sessions.map((s) => (
                <SessionCard
                    key={s.id}
                    session={s}
                    past={past}
                    onContinue={onContinue}
                    onEdit={onEdit}
                    onReopenScan={onReopenScan}
                    onViewOrderReport={onViewOrderReport}
                />
            )) : (
                <div className="empty">{empty}</div>
            )}
        </>
    );
}
