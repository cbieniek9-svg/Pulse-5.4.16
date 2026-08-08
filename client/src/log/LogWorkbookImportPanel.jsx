import { useRef, useState } from 'react';
import { importWorkbook } from './logApi.js';

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const base64 = result.includes(',') ? result.split(',')[1] : result;
            resolve(base64);
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
    });
}

export default function LogWorkbookImportPanel({ token, onImported }) {
    const inputRef = useRef(null);
    const [busy, setBusy] = useState(false);
    const [dryRun, setDryRun] = useState(false);
    const [replacePeriod, setReplacePeriod] = useState(false);
    const [fillSales, setFillSales] = useState(false);
    const [freightRate, setFreightRate] = useState('');
    const [status, setStatus] = useState('');
    const [statusKind, setStatusKind] = useState('');
    const [summary, setSummary] = useState(null);

    const handleFile = async (file) => {
        if (!file) return;
        setBusy(true);
        setStatus('');
        setStatusKind('');
        setSummary(null);
        try {
            const contentBase64 = await readFileAsBase64(file);
            const result = await importWorkbook(token, {
                filename: file.name,
                contentBase64,
                replace_period: replacePeriod,
                fill_sales: fillSales,
                dry_run: dryRun,
                rate_percent: freightRate,
            });
            setSummary(result.summary);
            if (dryRun) {
                setStatusKind('dry-run');
                setStatus('Dry run complete — preview only. No changes were saved to the database.');
            } else {
                setStatusKind('ok');
                const rateNote = result.summary?.period_freight_rate_percent != null
                    ? ` Legacy audit rate ${result.summary.period_freight_rate_percent}% imported (${result.summary.freight_rate_source || 'set'}). Confirm department allocation profile on Margin.`
                    : ' Confirm department allocation profile on Margin before confirming costing.';
                setStatus(`Workbook imported.${rateNote}`);
                await onImported?.(result.summary);
            }
        } catch (e) {
            setStatusKind('error');
            setStatus(e.message || 'Import failed');
        } finally {
            setBusy(false);
            if (inputRef.current) inputRef.current.value = '';
        }
    };

    return (
        <div className="log-workbook-import">
            <div className="log-workbook-import-title">Import full workbook (.xlsx)</div>
            <p className="log-workbook-import-hint">
                Load a prior Edmonton Wholesale Market Receiving Report to roll over a period or restore backup data.
            </p>
            <div className="log-workbook-import-options">
                <label>
                    <input type="checkbox" checked={dryRun} onChange={(ev) => setDryRun(ev.target.checked)} />
                    Dry run (test import)
                </label>
                <label>
                    <input type="checkbox" checked={replacePeriod} onChange={(ev) => setReplacePeriod(ev.target.checked)} />
                    Replace existing period data
                </label>
                <label>
                    <input type="checkbox" checked={fillSales} onChange={(ev) => setFillSales(ev.target.checked)} />
                    Invent sales if Sales Numbers is empty (1.45 markup — off by default; do not use for SMS compare)
                </label>
                <label className="log-workbook-import-rate">
                    Superseded period freight rate % (audit import only)
                    <input
                        type="number"
                        step="0.0001"
                        min="0"
                        placeholder="legacy audit — optional"
                        value={freightRate}
                        disabled={busy}
                        onChange={(ev) => setFreightRate(ev.target.value)}
                    />
                </label>
            </div>
            <p className="log-workbook-import-hint">
                Authoritative costing uses the department allocation profile on Margin (Daily Freight Allocation Total × dept %).
                This legacy rate field is audit-only and never replaces the confirmed allocation profile.
            </p>
            {dryRun ? (
                <p className="log-workbook-import-hint log-workbook-import-dry-run-note">
                    Dry run parses the workbook and shows counts only. Uncheck dry run to commit the import.
                </p>
            ) : null}
            <div className="log-workbook-import-actions">
                <input
                    ref={inputRef}
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    disabled={busy}
                    onChange={(ev) => handleFile(ev.target.files?.[0])}
                />
            </div>
            {status ? (
                <div className={`log-import-status${statusKind ? ` ${statusKind}` : ''}`}>{status}</div>
            ) : null}
            {summary ? (
                <div className="log-import-summary">
                    {dryRun ? <span className="log-import-summary-tag">Dry run preview</span> : null}
                    <span>Period {formatShort(summary.period_start)}</span>
                    <span>{summary.daily_sheets} days</span>
                    <span>{summary.invoice_lines} invoice lines</span>
                    <span>{summary.sales_cells} sales cells</span>
                    {summary.synthesized_sales ? <span>{summary.synthesized_sales} synthesized sales</span> : null}
                    {summary.shrink_lines != null ? <span>{summary.shrink_lines} shrink lines</span> : null}
                    {summary.margin_fields != null ? <span>{summary.margin_fields} margin fields</span> : null}
                    {summary.rebate_lines != null ? <span>{summary.rebate_lines} rebate lines</span> : null}
                    {summary.recount_rows != null ? <span>{summary.recount_rows} recount rows</span> : null}
                    {summary.dept_margin_sheets != null ? <span>{summary.dept_margin_sheets} dept margin sheets</span> : null}
                    {summary.freight_alloc_profile_imported ? (
                        <span>Dept allocation profile imported (confirm on Margin)</span>
                    ) : summary.freight_alloc_profile_status ? (
                        <span>Alloc profile: {summary.freight_alloc_profile_status}</span>
                    ) : (
                        <span>Confirm department allocation profile on Margin</span>
                    )}
                    {summary.period_freight_rate_percent != null ? (
                        <span>
                            Legacy audit rate {summary.period_freight_rate_percent}%
                            {summary.freight_rate_source ? ` · ${summary.freight_rate_source}` : ''}
                        </span>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

function formatShort(value) {
    if (!value) return '—';
    return value;
}
