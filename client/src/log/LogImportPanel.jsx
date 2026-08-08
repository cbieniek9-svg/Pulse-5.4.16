import { useState } from 'react';
import { commitReportImport, scanReportDocument } from './logApi.js';
import { fmtMoney } from './logUtils.js';

function readFileBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
    });
}

export default function LogImportPanel({ token, storeDate, onImported }) {
    const [docType, setDocType] = useState('auto');
    const [busy, setBusy] = useState('');
    const [preview, setPreview] = useState(null);
    const [message, setMessage] = useState('');

    const runScan = async (file) => {
        if (!file) return;
        setBusy('scan');
        setMessage('Scanning PDF… this may take a minute.');
        try {
            const contentBase64 = await readFileBase64(file);
            const data = await scanReportDocument(token, {
                filename: file.name,
                contentBase64,
                doc_type: docType,
            });
            setPreview({ ...data, filename: file.name, contentBase64 });
            setMessage(`${data.shrink_candidates?.length || 0} SKU line(s) detected · total ${fmtMoney(data.summary?.total_shrink)}`);
        } catch (e) {
            setPreview(null);
            setMessage(e.message || 'Scan failed');
        } finally {
            setBusy('');
        }
    };

    const commitImport = async () => {
        if (!preview) return;
        setBusy('commit');
        try {
            await commitReportImport(token, {
                store_date: storeDate,
                filename: preview.filename,
                doc_type: preview.doc_type,
                invoice: preview.invoice_candidate,
                shrink_lines: preview.shrink_candidates,
                ocrText: preview.ocrText,
            });
            setPreview(null);
            setMessage('Import saved to receiving log and shrink tracker.');
            await onImported?.();
        } catch (e) {
            setMessage(e.message || 'Import failed');
        } finally {
            setBusy('');
        }
    };

    return (
        <div className="add-box">
            <div className="section-label" style={{ marginTop: 0 }}>IMPORT PDF INVOICE / SHRINK</div>
            <p className="hint" style={{ margin: '0 0 10px' }}>
                Upload vendor invoice PDFs or shrink/credit documents. OCR extracts invoice header + SKU-level shrink lines.
            </p>
            <label>
                <span>Document type</span>
                <select className="input" value={docType} onChange={(ev) => setDocType(ev.target.value)}>
                    <option value="auto">Auto-detect</option>
                    <option value="invoice">Invoice</option>
                    <option value="shrink">Shrink / credit</option>
                </select>
            </label>
            <input
                className="input"
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff"
                disabled={!!busy}
                onChange={(ev) => runScan(ev.target.files?.[0])}
            />
            {message ? <div className="hint" style={{ marginBottom: 10 }}>{message}</div> : null}
            {preview ? (
                <div className="import-preview">
                    <div className="import-preview-head">
                        <strong>{preview.invoice_candidate?.supplier_name || 'Supplier TBD'}</strong>
                        <span>{preview.invoice_candidate?.invoice_number || 'Invoice # TBD'}</span>
                    </div>
                    <div className="hint">
                        Detected {preview.doc_type} · {preview.summary?.sku_count || 0} SKU(s) · total {fmtMoney(preview.summary?.total_shrink)}
                    </div>
                    {(preview.errors || []).slice(0, 3).map((err) => (
                        <div key={err} className="import-warning">{err}</div>
                    ))}
                    <div className="import-lines">
                        {(preview.shrink_candidates || []).slice(0, 12).map((row, idx) => (
                            <div key={`${row.sku}-${idx}`} className="import-line">
                                <div>
                                    <strong>{row.sku || '—'}</strong> · {row.description}
                                </div>
                                <div className="card-meta">
                                    {row.department} · qty {row.quantity} · {fmtMoney(row.extended_cost)}
                                    {row.reason ? ` · ${row.reason}` : ''}
                                </div>
                            </div>
                        ))}
                    </div>
                    <button type="button" className="btn btn-warn" style={{ width: '100%', marginTop: 10 }} disabled={!!busy} onClick={commitImport}>
                        {busy === 'commit' ? '…' : 'IMPORT TO /LOG'}
                    </button>
                </div>
            ) : null}
        </div>
    );
}
