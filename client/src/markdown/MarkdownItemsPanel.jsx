import { useCallback, useEffect, useState } from 'react';
import { getItemCatalogStats, searchItems } from '../lib/itemCatalogApi.js';

export default function MarkdownItemsPanel({ token }) {
    const [q, setQ] = useState('');
    const [rows, setRows] = useState([]);
    const [stats, setStats] = useState(null);
    const [busy, setBusy] = useState(false);

    const loadStats = useCallback(async () => {
        try {
            setStats(await getItemCatalogStats(token));
        } catch (_) {
            setStats(null);
        }
    }, [token]);

    useEffect(() => { loadStats(); }, [loadStats]);

    const runSearch = async (e) => {
        if (e) e.preventDefault();
        if (!q.trim()) return;
        setBusy(true);
        const res = await searchItems(token, q, 50);
        setRows(res.rows);
        if (res.stats) setStats(res.stats);
        setBusy(false);
    };

    return (
        <div className="entry-card">
            <p className="notice-msg" style={{ margin: '0 0 14px 0' }}>
                The store item list. Every code logged on FIFO or shrink is remembered here, so the next
                scan fills the description in for you. Managers upload and maintain the product file
                under Settings → Product Catalog.
            </p>

            {stats ? (
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12, fontSize: '0.8rem', color: '#bbb' }}>
                    <span>{stats.total} item{stats.total === 1 ? '' : 's'}</span>
                    <span>{stats.described} with a description</span>
                    <span>{stats.aliases} linked barcode{stats.aliases === 1 ? '' : 's'}</span>
                </div>
            ) : null}

            <form onSubmit={runSearch}>
                <div className="form-group">
                    <label className="label" htmlFor="it-q">Search by description or code</label>
                    <input id="it-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
                </div>
                <button type="submit" className="btn" disabled={busy || !q.trim()} style={{ width: '100%' }}>
                    {busy ? 'WORKING…' : 'SEARCH ITEMS'}
                </button>
            </form>

            <div style={{ maxHeight: '40vh', overflowY: 'auto', marginTop: 12 }}>
                {rows.map((r) => (
                    <div key={r.code} className="batch-item">
                        <div className="batch-item-text">{r.description || '(no description)'}</div>
                        <div className="batch-item-meta">
                            {r.raw_code || r.code}
                            {r.zone ? ` · ${r.zone}` : ''}
                            {r.department ? ` · ${r.department}` : ''}
                            {r.size ? ` · ${r.size}` : ''}
                            {` · seen ${r.times_seen}×`}
                            {` · ${r.source}`}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}
