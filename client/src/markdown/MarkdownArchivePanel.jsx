import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from '../lib/api.js';

const KILL_DATE_ZONES = [
    'Dairy', 'Bakery', 'Produce', 'Freezer',
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'Pop', 'Water', 'Jerry', 'Seasonal', 'General',
];

const STATUS_FILTERS = [
    { value: 'all', label: 'Everything' },
    { value: 'Active', label: 'Active (on the board)' },
    { value: 'archived', label: 'Not active' },
    { value: 'Closed', label: 'Closed' },
    { value: 'Archived', label: 'Archived' },
    { value: 'Deleted', label: 'Deleted' },
];

function statusColor(status) {
    if (status === 'Active') return '#0f8';
    if (status === 'Closed') return '#8cf';
    if (status === 'Archived') return '#f90';
    return '#888';
}

export default function MarkdownArchivePanel({ token, showToast, refreshKey = 0 }) {
    const [q, setQ] = useState('');
    const [zone, setZone] = useState('');
    const [status, setStatus] = useState('all');
    const [rows, setRows] = useState([]);
    const [total, setTotal] = useState(0);
    const [counts, setCounts] = useState(null);
    const [offset, setOffset] = useState(0);
    const [busy, setBusy] = useState(false);
    const limit = 100;

    const load = useCallback(async (nextOffset = 0) => {
        if (!token) return;
        setBusy(true);
        try {
            const params = new URLSearchParams({
                status,
                limit: String(limit),
                offset: String(nextOffset),
            });
            if (q.trim()) params.set('q', q.trim());
            if (zone) params.set('zone', zone);
            const data = await fetchJson(`/api/markdown/archive?${params}`, {
                cache: 'no-store',
                headers: { 'x-session-token': token },
            });
            setRows(data.rows || []);
            setTotal(data.total || 0);
            setCounts(data.counts || null);
            setOffset(nextOffset);
        } catch (e) {
            showToast(e.message || 'Could not load archive');
        } finally {
            setBusy(false);
        }
    }, [token, showToast, q, zone, status]);

    // Search text only applies on submit; filters and live kill_dates events reload immediately.
    useEffect(() => { load(0); }, [status, zone, refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

    const onSearch = (e) => {
        e.preventDefault();
        load(0);
    };

    const pageLabel = total
        ? `${offset + 1}–${Math.min(offset + rows.length, total)} of ${total}`
        : '0 rows';

    return (
        <div className="entry-card">
            <p className="notice-msg" style={{ margin: '0 0 14px 0' }}>
                Every kill-date row ever logged — active board rows included. Search before logging FIFO so you do not double-enter the same vendor code.
            </p>

            {counts ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 12, fontSize: '0.8rem', color: '#bbb' }}>
                    <span>Active: {counts.Active ?? 0}</span>
                    <span>Closed: {counts.Closed ?? 0}</span>
                    <span>Archived: {counts.Archived ?? 0}</span>
                    {(counts.Deleted ?? 0) > 0 ? <span>Deleted: {counts.Deleted}</span> : null}
                </div>
            ) : null}

            <form onSubmit={onSearch}>
                <div className="form-group">
                    <label className="label" htmlFor="md-arch-q">Search item / vendor code / who logged</label>
                    <input
                        id="md-arch-q"
                        className="input"
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="e.g. vendor code or yogurt"
                        autoComplete="off"
                    />
                </div>
                <div className="row-3">
                    <div className="form-group">
                        <label className="label" htmlFor="md-arch-status">Status</label>
                        <select id="md-arch-status" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
                            {STATUS_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                        </select>
                    </div>
                    <div className="form-group">
                        <label className="label" htmlFor="md-arch-zone">Zone</label>
                        <select id="md-arch-zone" className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
                            <option value="">All zones</option>
                            {KILL_DATE_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                        </select>
                    </div>
                    <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end' }}>
                        <button type="submit" className="btn" disabled={busy} style={{ width: '100%' }}>
                            {busy ? 'SEARCHING…' : 'SEARCH'}
                        </button>
                    </div>
                </div>
            </form>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '8px 0 10px', fontSize: '0.8rem', color: '#aaa', gap: 8, flexWrap: 'wrap' }}>
                <span>{pageLabel}</span>
                <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => load(offset)}>REFRESH</button>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy || offset <= 0} onClick={() => load(Math.max(0, offset - limit))}>PREV</button>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy || offset + rows.length >= total} onClick={() => load(offset + limit)}>NEXT</button>
                </div>
            </div>

            <div style={{ maxHeight: '55vh', overflowY: 'auto' }}>
                {!rows.length && !busy ? (
                    <div style={{ opacity: 0.65, padding: '12px 0' }}>No matching rows.</div>
                ) : null}
                {rows.map((r) => (
                    <div
                        key={r.id}
                        className="batch-item"
                        style={{ borderLeft: `3px solid ${statusColor(r.status)}` }}
                    >
                        <div className="batch-item-text">{r.item || '(no description)'}</div>
                        <div className="batch-item-meta">
                            <span style={{ color: statusColor(r.status), fontWeight: 600 }}>{r.status}</span>
                            {' · '}
                            {r.item_code || '—'}
                            {' · '}
                            {r.zone || 'General'}
                            {' · '}
                            {r.kill_date || '—'}
                            {r.quantity != null ? ` · qty ${r.quantity}` : ''}
                            {r.logged_by ? ` · by ${r.logged_by}` : ''}
                            {r.closed_by ? ` · closed by ${r.closed_by}` : ''}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
