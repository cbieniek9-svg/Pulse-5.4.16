import { useState } from 'react';
import { resolveUrl } from '../lib/api.js';

function readFileBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
    });
}

export default function MarkdownImportPanels({ token, onBatchAdd, onImported, showToast }) {
    const [scanPreview, setScanPreview] = useState('');
    const [scanCandidates, setScanCandidates] = useState([]);
    const [excelPreview, setExcelPreview] = useState('');
    const [pendingExcel, setPendingExcel] = useState(null);
    const [scanBusy, setScanBusy] = useState(false);
    const [excelBusy, setExcelBusy] = useState(false);
    const [importBusy, setImportBusy] = useState(false);
    const ocrMode = 'local';

    const queueScanRow = (idx) => {
        const r = scanCandidates[idx];
        if (!r?.item || !r?.kill_date) return showToast('Invalid row');
        onBatchAdd({
            item: r.item,
            item_code: r.item_code || '',
            zone: r.zone || 'General',
            kill_date: r.kill_date,
            quantity: r.quantity || 1,
        });
        showToast('Queued from scan');
    };

    const runScan = async (file) => {
        if (!file) return showToast('Choose a scan file first');
        setScanBusy(true);
        setScanPreview('Scanning… this may take a minute.');
        try {
            const contentBase64 = await readFileBase64(file);
            const res = await fetch(resolveUrl('/api/markdown/import-scan'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, contentBase64, token }),
            });
            if (!res.ok) {
                let msg = 'Scan failed';
                try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
                throw new Error(msg);
            }
            const data = await res.json();
            const rows = data.candidates || [];
            setScanCandidates(rows);
            setScanPreview(`${rows.length} candidate row(s)${data.errors?.length ? ` · ${data.errors.length} warning(s)` : ''}`);
            showToast(`OCR: ${rows.length} candidates`);
        } catch (e) {
            setScanCandidates([]);
            setScanPreview(e.message);
            showToast(e.message);
        } finally {
            setScanBusy(false);
        }
    };

    const previewExcel = async (file) => {
        if (!file) return showToast('Choose an Excel or CSV file first');
        setExcelBusy(true);
        setExcelPreview('Previewing…');
        try {
            const payload = {
                filename: file.name,
                contentBase64: await readFileBase64(file),
            };
            setPendingExcel(payload);
            const res = await fetch(resolveUrl('/api/markdown/import-excel'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...payload, token, dry_run: true }),
            });
            if (!res.ok) {
                let msg = 'Preview failed';
                try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
                throw new Error(msg);
            }
            const data = await res.json();
            const rows = data.candidates || [];
            setExcelPreview(`READY: ${rows.length} row(s) from ${data.filename || file.name}`);
            showToast(`Preview: ${data.import_count || rows.length} row(s) ready`);
        } catch (e) {
            setPendingExcel(null);
            setExcelPreview(e.message);
            showToast(e.message);
        } finally {
            setExcelBusy(false);
        }
    };

    const commitExcel = async () => {
        if (!pendingExcel) return showToast('Preview a file first');
        setImportBusy(true);
        try {
            const res = await fetch(resolveUrl('/api/markdown/import-excel'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...pendingExcel, token, dry_run: false }),
            });
            if (!res.ok) {
                let msg = 'Import failed';
                try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
                throw new Error(msg);
            }
            const data = await res.json();
            setPendingExcel(null);
            setExcelPreview(`Imported ${data.imported || 0} expiry row(s)`);
            showToast(`Imported ${data.imported || 0} expiry row(s)`);
            await onImported?.();
        } catch (e) {
            showToast(e.message);
        } finally {
            setImportBusy(false);
        }
    };

    return (
        <>
            <details className="collapsible">
                <summary>▸ Scan / OCR (photo or PDF)</summary>
                <div className="entry-card" style={{ marginTop: 8 }}>
                    <p className="notice-msg" style={{ margin: '0 0 12px 0' }}>
                        Upload a photo or PDF of a handwritten FIFO log. Server runs OCR ({ocrMode}) — review before import.
                    </p>
                    <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff"
                        className="input"
                        style={{ minHeight: 44, padding: 10 }}
                        onChange={(e) => runScan(e.target.files?.[0])}
                        disabled={scanBusy}
                    />
                    <div style={{ marginTop: 12, textTransform: 'none', fontSize: '0.85rem', color: '#ccc', maxHeight: 280, overflow: 'auto' }}>
                        {scanPreview ? <div style={{ marginBottom: 8 }}>{scanPreview}</div> : null}
                        {scanCandidates.slice(0, 25).map((r, i) => (
                            <div key={`scan-${i}`} style={{ padding: '6px 0', borderBottom: '1px solid rgba(168,85,247,0.15)' }}>
                                <strong>{r.item}</strong> · {r.item_code || '—'} · {r.zone} · {r.kill_date} · qty {r.quantity || 1}
                                <br />
                                <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => queueScanRow(i)}>ADD TO BATCH</button>
                            </div>
                        ))}
                    </div>
                </div>
            </details>

            <details className="collapsible">
                <summary>▸ Excel upload</summary>
                <div className="entry-card" style={{ marginTop: 8 }}>
                    <p className="notice-msg" style={{ margin: '0 0 12px 0' }}>Save as .xlsx or .csv. Use PREVIEW before import.</p>
                    <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        className="input"
                        style={{ minHeight: 44, padding: 10 }}
                        onChange={(e) => previewExcel(e.target.files?.[0])}
                        disabled={excelBusy}
                    />
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
                        <button type="button" className="btn btn-green btn-sm" disabled={!pendingExcel || importBusy} onClick={commitExcel}>
                            {importBusy ? 'IMPORTING…' : 'IMPORT'}
                        </button>
                    </div>
                    <div style={{ marginTop: 12, textTransform: 'none', fontSize: '0.85rem', color: '#ccc' }}>{excelPreview}</div>
                </div>
            </details>
        </>
    );
}
