import { useCallback, useEffect, useState } from 'react';
import {
    cleanupItemCatalog, getItemCatalogStats, importItemCsv, rebuildItemCatalog, searchItems,
} from '../../lib/itemCatalogApi.js';
import { useSettings } from '../context/SettingsContext.jsx';
import { fileToBase64 } from '../lib/settingsHelpers.js';

export default function ItemsCatalogTab() {
    const { token, showNotice, appConfirm } = useSettings();
    const [stats, setStats] = useState(null);
    const [query, setQuery] = useState('');
    const [rows, setRows] = useState([]);
    const [busy, setBusy] = useState(false);
    const [pendingFile, setPendingFile] = useState(null);
    const [pendingBase64, setPendingBase64] = useState('');
    const [preview, setPreview] = useState(null);

    const refreshStats = useCallback(async () => {
        try {
            setStats(await getItemCatalogStats(token));
        } catch (e) {
            showNotice(e.message || 'Could not load product catalog totals.', 'error');
        }
    }, [token, showNotice]);

    useEffect(() => { refreshStats(); }, [refreshStats]);

    const runSearch = async (event) => {
        event?.preventDefault();
        if (!query.trim()) return;
        setBusy(true);
        try {
            const result = await searchItems(token, query, 100);
            setRows(result.rows || []);
            if (result.stats) setStats(result.stats);
        } catch (e) {
            showNotice(e.message || 'Catalog search failed.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const chooseFile = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        setBusy(true);
        try {
            const contentBase64 = await fileToBase64(file);
            const result = await importItemCsv(token, {
                filename: file.name,
                contentBase64,
                dryRun: true,
            });
            setPendingFile(file);
            setPendingBase64(contentBase64);
            setPreview(result);
            showNotice(`Preview ready: ${result.import_count || 0} product(s).`, 'success');
        } catch (e) {
            setPendingFile(null);
            setPendingBase64('');
            setPreview(null);
            showNotice(e.message || 'Could not preview that product catalog.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const cancelImport = () => {
        setPendingFile(null);
        setPendingBase64('');
        setPreview(null);
    };

    const confirmImport = async () => {
        if (!pendingFile || !pendingBase64) return;
        const count = preview?.import_count || 0;
        if (!(await appConfirm(`Import ${count} product${count === 1 ? '' : 's'} from ${pendingFile.name}? Existing catalog codes will be updated.`))) return;
        setBusy(true);
        try {
            const result = await importItemCsv(token, {
                filename: pendingFile.name,
                contentBase64: pendingBase64,
                dryRun: false,
            });
            setStats(result.stats || null);
            cancelImport();
            showNotice(`Imported ${result.imported || 0} product(s) and ${result.aliases || 0} barcode alias(es).`, 'success');
        } catch (e) {
            showNotice(e.message || 'Product catalog import failed.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const cleanup = async () => {
        const count = stats?.junk || 0;
        if (!(await appConfirm(`Remove ${count} catalog row${count === 1 ? '' : 's'} that are page headers, department names, or barcodes a spreadsheet rounded off? Real products are kept.`))) return;
        setBusy(true);
        try {
            const result = await cleanupItemCatalog(token);
            setStats(result.stats || null);
            showNotice(`Removed ${result.removed || 0} non-product row(s).`, 'success');
        } catch (e) {
            showNotice(e.message || 'Catalog cleanup failed.', 'error');
        } finally {
            setBusy(false);
        }
    };

    const rebuild = async () => {
        if (!(await appConfirm('Rebuild the product catalog from every FIFO and shrink row already logged? This will not delete uploaded products.'))) return;
        setBusy(true);
        try {
            const result = await rebuildItemCatalog(token);
            setStats(result.stats || null);
            showNotice(`Scanned ${result.scanned || 0} historical row(s); learned ${result.created || 0} new product(s).`, 'success');
        } catch (e) {
            showNotice(e.message || 'Catalog rebuild failed.', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <div className="mgr-section-title">PRODUCT CATALOG</div>
            <div className="mgr-card">
                <p style={{ marginTop: 0, color: '#c7d7ec', textTransform: 'none' }}>
                    Upload the store product list here. Markdown and Shrink use it to fill the
                    description automatically when a shelf code or UPC is scanned.
                </p>

                {stats ? (
                    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 16, color: '#8cf' }}>
                        <strong>{stats.total || 0} products</strong>
                        <span>{stats.described || 0} with descriptions</span>
                        <span>{stats.aliases || 0} linked barcodes</span>
                        {stats.junk ? (
                            <span style={{ color: '#f4a742' }}>{stats.junk} non-product rows</span>
                        ) : null}
                    </div>
                ) : null}

                <label className="section-label" htmlFor="catalog-file">UPLOAD PRODUCT CATALOG</label>
                <p style={{ fontSize: '0.78rem', color: '#789', textTransform: 'none' }}>
                    Best source: SMS <strong>Price List with Cost</strong> → save as
                    <strong> ExcelFile (*.xls)</strong> and upload here (also
                    <code>.xlsx</code> / <code>.csv</code>). No date filter &mdash; active prices only.
                </p>
                <p style={{ fontSize: '0.78rem', color: '#789', textTransform: 'none' }}>
                    Reads <code>Code</code> (UPC), <code>Description</code>,
                    <code>Regular/Qty</code> (retail), <code>Unit cost</code>,
                    <code>Base cost</code> (case), and <code>Case</code> (pack count).
                    Pulls the trailing number from <code>V.Code</code> as an alternate lookup.
                    The printed report puts its headings slightly out of line with the rows
                    beneath them &mdash; that is expected, and the columns are read from the
                    rows themselves.
                </p>
                <p style={{ fontSize: '0.78rem', color: '#789', textTransform: 'none' }}>
                    Older Customer Price Catalog still works (UPC + Case Code). Upload straight
                    from SMS &mdash; re-saving in Excel can round long barcodes
                    (<code>9.78031E+12</code>).
                </p>
                <input
                    id="catalog-file"
                    className="st-input"
                    type="file"
                    accept=".xls,.xlsx,.csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
                    onChange={chooseFile}
                    disabled={busy}
                />

                {preview ? (
                    <div style={{ marginTop: 14, padding: 12, border: '1px solid #8cf', borderRadius: 8, textTransform: 'none' }}>
                        <strong style={{ color: '#8cf' }}>{pendingFile?.name}</strong>
                        <div style={{ marginTop: 5 }}>
                            {preview.import_count || 0} products ready
                            {preview.rows_read ? ` — read ${preview.rows_read} row(s)` : ''}
                            {preview.sheets?.length > 1 ? ` across ${preview.sheets.length} sheets` : ''}
                        </div>
                        {preview.rows_read && preview.import_count < preview.rows_read ? (
                            <div style={{ marginTop: 4, fontSize: '0.78rem', color: '#abc' }}>
                                {preview.rows_read - preview.import_count} row(s) did not become a
                                product. Compare this against the item count SMS reports before importing.
                            </div>
                        ) : null}
                        {preview.header_cells?.length ? (
                            <div style={{ marginTop: 8, fontSize: '0.74rem', color: '#abc' }}>
                                <div style={{ color: '#8cf' }}>HEADER ROW {preview.header_row}</div>
                                <div style={{ fontFamily: 'monospace' }}>
                                    {preview.header_cells.map((cell, i) => `[${i}] ${cell || '·'}`).join('   ')}
                                </div>
                                <div style={{ marginTop: 4, fontFamily: 'monospace' }}>
                                    {Object.entries(preview.columns || {})
                                        .map(([field, at]) => `${field}=col${at}`).join('   ') || 'no columns mapped'}
                                </div>
                            </div>
                        ) : null}
                        {Object.entries(preview.skipped || {}).map(([reason, count]) => (
                            <div key={reason} style={{ marginTop: 6, fontSize: '0.78rem', color: '#f4a742' }}>
                                <div>{count} skipped — {reason}</div>
                                {(preview.skipped_samples?.[reason] || []).map((cells, i) => (
                                    // eslint-disable-next-line react/no-array-index-key
                                    <div key={i} style={{ fontFamily: 'monospace', fontSize: '0.7rem', color: '#89a', paddingLeft: 10 }}>
                                        {cells.map((c) => (c === '' ? '·' : c)).join(' | ')}
                                    </div>
                                ))}
                            </div>
                        ))}
                        {preview.errors?.map((message) => (
                            <div key={message} style={{ marginTop: 6, fontSize: '0.78rem', color: '#f4a742' }}>
                                {message}
                            </div>
                        ))}
                        {preview.sample?.length ? (
                            <div style={{ marginTop: 8, maxHeight: 180, overflowY: 'auto', fontSize: '0.78rem', color: '#abc' }}>
                                {preview.sample.map((item) => (
                                    <div key={`${item.code}-${item.description}`} style={{ padding: '3px 0' }}>
                                        {item.raw_code || item.code} · {item.description || '(no description)'}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                            <button type="button" className="st-btn" style={{ width: 'auto' }} onClick={confirmImport} disabled={busy || !preview.import_count}>
                                CONFIRM IMPORT
                            </button>
                            <button type="button" className="st-btn subtle" style={{ width: 'auto' }} onClick={cancelImport} disabled={busy}>
                                CANCEL
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>

            <div className="mgr-card">
                <div className="section-label">SEARCH CATALOG</div>
                <form onSubmit={runSearch} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                        className="st-input"
                        style={{ flex: '1 1 260px' }}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Product name, SKU, UPC, or vendor code"
                        autoComplete="off"
                    />
                    <button type="submit" className="st-btn" style={{ width: 'auto' }} disabled={busy || !query.trim()}>
                        SEARCH
                    </button>
                </form>
                <div style={{ marginTop: 12, maxHeight: 360, overflowY: 'auto' }}>
                    {rows.map((item) => (
                        <div key={item.code} style={{ padding: '8px 0', borderBottom: '1px solid rgba(120,180,220,0.15)', textTransform: 'none' }}>
                            <strong style={{ color: '#fff' }}>{item.description || '(no description)'}</strong>
                            <br />
                            <small style={{ color: '#8aa' }}>
                                {item.raw_code || item.code}
                                {item.zone ? ` · ${item.zone}` : ''}
                                {item.department ? ` · ${item.department}` : ''}
                                {` · seen ${item.times_seen || 0}×`}
                            </small>
                        </div>
                    ))}
                </div>
            </div>

            <div className="mgr-card">
                <div className="section-label">CATALOG MAINTENANCE</div>
                <p style={{ color: '#789', fontSize: '0.78rem', textTransform: 'none' }}>
                    Re-scan all existing FIFO and shrink history to learn any product codes missing from the catalog.
                </p>
                <button type="button" className="st-btn subtle" style={{ width: 'auto' }} onClick={rebuild} disabled={busy}>
                    REBUILD FROM LOGGED HISTORY
                </button>
                <p style={{ color: '#789', fontSize: '0.78rem', textTransform: 'none', marginTop: 18 }}>
                    Product lists exported as printed reports carry page headers and department banners
                    between the real rows. Clear those out so they stop showing up in search.
                </p>
                <button type="button" className="st-btn subtle" style={{ width: 'auto' }} onClick={cleanup} disabled={busy || !stats?.junk}>
                    {stats?.junk ? `REMOVE ${stats.junk} NON-PRODUCT ROWS` : 'NO NON-PRODUCT ROWS'}
                </button>
            </div>
        </>
    );
}
