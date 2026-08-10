import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, resolveUrl } from '../lib/api.js';
import { calcXferLineExt, downloadBlob } from './recUtils.js';

function emptyLine(id) {
    return { id, product: '', qty: '', cost: '' };
}

export default function StoreTransfersPanel({ token, storeDate, enabled }) {
    const [customers, setCustomers] = useState([]);
    const [customer, setCustomer] = useState('');
    const [customerMeta, setCustomerMeta] = useState('');
    const [storage, setStorage] = useState('Cooler');
    const [pallets, setPallets] = useState('');
    const [weight, setWeight] = useState('');
    const [lines, setLines] = useState([emptyLine('xl-1')]);
    const [lineSeq, setLineSeq] = useState(1);
    const [searchQ, setSearchQ] = useState('');
    const [searchDate, setSearchDate] = useState(storeDate || '');
    const [results, setResults] = useState([]);
    const [searching, setSearching] = useState(false);
    const [creating, setCreating] = useState(false);

    const loadConfig = useCallback(async () => {
        if (!enabled || !token) return;
        try {
            const data = await fetchJson('/api/receiving/store-transfers/config', {
                headers: { 'x-session-token': token },
            });
            setCustomers(Array.isArray(data.customers) ? data.customers : []);
            if (!searchDate && (data.storeDate || storeDate)) {
                setSearchDate(data.storeDate || storeDate);
            }
        } catch (_) { /* ignore */ }
    }, [enabled, token, searchDate, storeDate]);

    const search = useCallback(async (overrides = {}) => {
        if (!enabled || !token) return;
        const q = overrides.q !== undefined ? overrides.q : searchQ;
        const date = overrides.date !== undefined ? overrides.date : searchDate;
        setSearching(true);
        try {
            const params = new URLSearchParams();
            if (String(q || '').trim()) params.set('q', String(q).trim());
            if (date) params.set('date', date);
            const data = await fetchJson(`/api/receiving/store-transfers?${params}`, {
                headers: { 'x-session-token': token },
            });
            setResults(data.transfers || []);
        } catch (e) {
            setResults([]);
            alert(e.message);
        } finally {
            setSearching(false);
        }
    }, [enabled, token, searchQ, searchDate]);

    useEffect(() => { loadConfig(); }, [loadConfig]);
    useEffect(() => {
        if (enabled && token) search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, token]);

    const totals = useMemo(() => {
        let pieces = 0;
        let extended = 0;
        lines.forEach((line) => {
            const calc = calcXferLineExt(line.qty, line.cost);
            if (calc) {
                pieces += calc.pieces;
                extended += calc.ext;
            }
        });
        return { pieces, extended };
    }, [lines]);

    const selectedCustomer = customers.find((c) => c.name === customer);

    const addLine = () => {
        if (lines.length >= 25) return alert('Max 25 product lines.');
        const next = lineSeq + 1;
        setLineSeq(next);
        setLines((rows) => [...rows, emptyLine(`xl-${next}`)]);
    };

    const removeLine = (id) => {
        setLines((rows) => {
            const next = rows.filter((r) => r.id !== id);
            return next.length ? next : [emptyLine('xl-1')];
        });
    };

    const updateLine = (id, field, value) => {
        setLines((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
    };

    const downloadTransfer = async (transferId, fileName) => {
        const res = await fetch(
            resolveUrl(`/api/receiving/store-transfers/${encodeURIComponent(transferId)}/download?doc=invoice`),
            { headers: { 'x-session-token': token || '' } },
        );
        if (!res.ok) {
            let msg = 'Download failed';
            try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
            throw new Error(msg);
        }
        downloadBlob(await res.blob(), fileName || 'store-transfer.xlsx');
    };

    const createDoc = async () => {
        if (!customer) return alert('Select a customer.');
        const lineItems = lines
            .filter((l) => l.product.trim() || l.qty !== '' || l.cost !== '')
            .map((l) => ({ item: l.product.trim(), quantity: l.qty, cost: l.cost }));
        if (!lineItems.length) return alert('Add at least one product line.');
        setCreating(true);
        try {
            const res = await fetch(resolveUrl('/api/receiving/store-transfers'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token || '' },
                body: JSON.stringify({
                    customer_name: customer,
                    customer_number: selectedCustomer?.number || '',
                    store_date: storeDate || '',
                    storage_type: storage,
                    pallets,
                    weight_kg: weight,
                    line_items: lineItems,
                }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Could not create transfer');
            const transfer = data.transfer;
            if (!transfer?.transfer_id) throw new Error('Transfer created but response was incomplete.');
            try {
                await downloadTransfer(transfer.transfer_id, transfer.file_name);
            } catch (dlErr) {
                setLines([emptyLine('xl-1')]);
                setPallets('');
                setWeight('');
                await search();
                alert(`Created ${transfer.invoice_no || transfer.transfer_id}, but download failed: ${dlErr.message}`);
                return;
            }
            setLines([emptyLine('xl-1')]);
            setPallets('');
            setWeight('');
            await search();
            alert(`Created ${transfer.invoice_no} — workbook downloaded.`);
        } catch (e) {
            alert(e.message);
        } finally {
            setCreating(false);
        }
    };

    if (!enabled) {
        return <p className="hint">Store transfers are disabled for this store.</p>;
    }

    return (
        <>
            <div className="add-box xfer-box">
                <div className="section-label" style={{ marginTop: 0 }}>NEW STORE TRANSFER</div>
                <label className="hint" style={{ display: 'block', color: '#0cf', marginBottom: 4 }}>CUSTOMER (TO)</label>
                <select
                    className="input"
                    value={customer}
                    onChange={(e) => {
                        setCustomer(e.target.value);
                        const c = customers.find((x) => x.name === e.target.value);
                        setCustomerMeta(c?.number ? `Customer # ${c.number}` : (c ? 'Customer # —' : ''));
                    }}
                    style={{ marginBottom: 10 }}
                >
                    <option value="">Select customer…</option>
                    {customers.map((c) => (
                        <option key={c.name} value={c.name}>
                            {c.number ? `${c.name} (${c.number})` : c.name}
                        </option>
                    ))}
                </select>
                {customerMeta ? <p className="hint" style={{ margin: '-4px 0 10px' }}>{customerMeta}</p> : null}
                <label className="hint" style={{ display: 'block', color: '#0cf', marginBottom: 4 }}>COOLER / DRY / FROZEN</label>
                <select className="input" value={storage} onChange={(e) => setStorage(e.target.value)}>
                    <option value="Cooler">Cooler</option>
                    <option value="Dry">Dry</option>
                    <option value="Frozen">Frozen</option>
                </select>
                <div className="date-row" style={{ margin: '10px 0' }}>
                    <label>Pallets</label>
                    <input className="input" type="number" step="0.1" min="0" placeholder="Optional" value={pallets} onChange={(e) => setPallets(e.target.value)} style={{ margin: 0, flex: 1 }} />
                </div>
                <div className="date-row" style={{ margin: '0 0 10px' }}>
                    <label>Weight kg</label>
                    <input className="input" type="number" step="0.1" min="0" placeholder="Optional" value={weight} onChange={(e) => setWeight(e.target.value)} style={{ margin: 0, flex: 1 }} />
                </div>
                <div className="section-label" style={{ marginTop: 8 }}>PRODUCT LINES</div>
                <div className="xfer-lines">
                    {lines.map((line) => {
                        const calc = calcXferLineExt(line.qty, line.cost);
                        return (
                            <div className="xfer-line" key={line.id}>
                                <div className="xfer-line-head">
                                    <span style={{ color: '#8cf', fontSize: '0.72em' }}>LINE</span>
                                    <button type="button" className="btn btn-small btn-warn" onClick={() => removeLine(line.id)}>REMOVE</button>
                                </div>
                                <input className="input xfer-product" placeholder="Product name" value={line.product} onChange={(e) => updateLine(line.id, 'product', e.target.value)} />
                                <input className="input xfer-qty" type="number" step="0.01" min="0" placeholder="Qty" value={line.qty} onChange={(e) => updateLine(line.id, 'qty', e.target.value)} />
                                <input className="input xfer-price" type="number" step="0.01" min="0" placeholder="Cost $" value={line.cost} onChange={(e) => updateLine(line.id, 'cost', e.target.value)} />
                                <div className="xfer-ext">
                                    {calc ? `Price $${calc.unit.toFixed(2)} · Ext $${calc.ext.toFixed(2)}` : '—'}
                                </div>
                            </div>
                        );
                    })}
                </div>
                <div className="xfer-actions">
                    <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={addLine}>+ ADD LINE</button>
                </div>
                <p className="hint" style={{ margin: '8px 0 10px' }}>
                    {totals.pieces
                        ? `Preview: ${totals.pieces} pcs · ~$${totals.extended.toFixed(2)} after 7.25% upcharge`
                        : 'Add product lines above (cost, not sell price).'}
                </p>
                <button type="button" className="btn btn-warn" style={{ width: '100%' }} disabled={creating} onClick={createDoc}>
                    {creating ? 'GENERATING…' : 'GENERATE TRANSFER WORKBOOK'}
                </button>
            </div>

            <div className="add-box xfer-box" style={{ marginTop: 16 }}>
                <div className="section-label" style={{ marginTop: 0 }}>LOOKUP TRANSFERS</div>
                <input className="input" placeholder="Search invoice / customer / product…" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } }} />
                <div className="date-row" style={{ marginBottom: 10 }}>
                    <label>Date</label>
                    <input type="date" className="input" value={searchDate} onChange={(e) => setSearchDate(e.target.value)} style={{ margin: 0, flex: 1 }} />
                </div>
                <div className="xfer-actions">
                    <button type="button" className="btn btn-secondary" style={{ flex: 1 }} disabled={searching} onClick={search}>SEARCH</button>
                    <button type="button" className="btn" style={{ flex: 1 }} onClick={() => {
                        const clearedDate = storeDate || '';
                        setSearchQ('');
                        setSearchDate(clearedDate);
                        search({ q: '', date: clearedDate });
                    }}>CLEAR</button>
                </div>
                <div className="xfer-result">
                    {searching ? <p className="hint">Searching…</p> : null}
                    {!searching && !results.length ? <p className="hint">No transfers found.</p> : null}
                    {results.map((t) => (
                        <div className="xfer-item" key={t.transfer_id}>
                            <div>
                                <strong>{t.invoice_no}</strong> · {t.customer_name}
                                <small>
                                    {t.store_date}
                                    {t.customer_number ? ` · #${t.customer_number}` : ''}
                                    {t.storage_type ? ` · ${t.storage_type}` : ''}
                                    {t.created_by ? ` · ${t.created_by}` : ''}
                                </small>
                            </div>
                            <button type="button" className="btn btn-small btn-secondary" onClick={() => downloadTransfer(t.transfer_id, t.file_name).catch((e) => alert(e.message))}>
                                DOWNLOAD
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        </>
    );
}
