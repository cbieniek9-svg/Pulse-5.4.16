import { useState } from 'react';
import { fmtMoney, isInvalidAmount } from './logUtils.js';
import { SHRINK_BUCKETS } from './logAnalyticsUtils.js';
import { saveShrinkLine } from './logApi.js';

const EMPTY_FORM = {
    sku: '',
    description: '',
    supplier_name: '',
    invoice_number: '',
    department: 'grocery',
    quantity: '1',
    extended_cost: '',
    reason: '',
};

export default function LogShrinkSheet({
    token,
    storeDate,
    shrinkSummary,
    shrinkLines,
    busy,
    readOnly = false,
    vendorNames = [],
    onDeleteShrink,
    onAdded,
}) {
    const [form, setForm] = useState(EMPTY_FORM);
    const [saving, setSaving] = useState(false);

    const updateForm = (patch) => setForm((prev) => ({ ...prev, ...patch }));

    const submitShrink = async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        if (!form.description && !form.extended_cost) {
            alert('Description and amount are required.');
            return;
        }
        if (isInvalidAmount(form.quantity) || isInvalidAmount(form.extended_cost)) {
            alert('Not a number: quantity or extended cost — shrink not saved');
            return;
        }
        setSaving(true);
        try {
            await saveShrinkLine(token, {
                store_date: storeDate,
                sku: form.sku,
                description: form.description,
                supplier_name: form.supplier_name,
                invoice_number: form.invoice_number,
                department: form.department,
                quantity: form.quantity,
                extended_cost: form.extended_cost,
                reason: form.reason,
                source_doc: 'manual',
            });
            setForm(EMPTY_FORM);
            await onAdded?.();
        } catch (e) {
            alert(e.message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="sheet-shell shrink-sheet">
            <div className="sheet-tab">Shrink Detail · {storeDate}</div>
            <div className="shrink-summary-bar">
                <span>{shrinkSummary.line_count || 0} lines</span>
                <span>{shrinkSummary.sku_count || 0} SKUs</span>
                <span>Total {fmtMoney(shrinkSummary.total)}</span>
            </div>

            {vendorNames.length ? (
                <datalist id="log-shrink-vendor-list">
                    {vendorNames.map((name) => (
                        <option key={name} value={name} />
                    ))}
                </datalist>
            ) : null}

            {!readOnly ? (
            <form className="shrink-add-form" onSubmit={submitShrink}>
                <div className="shrink-add-title">Add shrink line</div>
                <div className="shrink-add-grid">
                    <label>
                        <span>SKU</span>
                        <input value={form.sku} onChange={(ev) => updateForm({ sku: ev.target.value })} />
                    </label>
                    <label>
                        <span>Description</span>
                        <input value={form.description} onChange={(ev) => updateForm({ description: ev.target.value })} required />
                    </label>
                    <label>
                        <span>Supplier</span>
                        <input
                            list={vendorNames.length ? 'log-shrink-vendor-list' : undefined}
                            value={form.supplier_name}
                            onChange={(ev) => updateForm({ supplier_name: ev.target.value })}
                        />
                    </label>
                    <label>
                        <span>Invoice #</span>
                        <input value={form.invoice_number} onChange={(ev) => updateForm({ invoice_number: ev.target.value })} />
                    </label>
                    <label>
                        <span>Dept</span>
                        <select value={form.department} onChange={(ev) => updateForm({ department: ev.target.value })}>
                            {SHRINK_BUCKETS.map((b) => (
                                <option key={b.key} value={b.key}>{b.label}</option>
                            ))}
                        </select>
                    </label>
                    <label>
                        <span>Qty</span>
                        <input inputMode="decimal" value={form.quantity} onChange={(ev) => updateForm({ quantity: ev.target.value })} />
                    </label>
                    <label>
                        <span>Amount</span>
                        <input inputMode="decimal" value={form.extended_cost} onChange={(ev) => updateForm({ extended_cost: ev.target.value })} required />
                    </label>
                    <label>
                        <span>Reason</span>
                        <input value={form.reason} onChange={(ev) => updateForm({ reason: ev.target.value })} />
                    </label>
                </div>
                <button type="submit" className="log-btn" disabled={!!busy || saving}>
                    {saving ? 'Saving…' : 'Add shrink line'}
                </button>
            </form>
            ) : null}

            <div className="sheet-scroll">
                <table className="sheet-grid shrink-grid">
                    <thead>
                        <tr>
                            <th className="sheet-head">SKU</th>
                            <th className="sheet-head">Description</th>
                            <th className="sheet-head">Supplier</th>
                            <th className="sheet-head">Invoice #</th>
                            <th className="sheet-head">Dept</th>
                            <th className="sheet-head sheet-head-num">Qty</th>
                            <th className="sheet-head sheet-head-num">Amount</th>
                            <th className="sheet-head">Reason</th>
                            <th className="sheet-head" />
                        </tr>
                    </thead>
                    <tbody>
                        {(shrinkSummary.by_sku || []).map((row) => (
                            <tr key={`${row.sku}-${row.description}`} className="sheet-row-data has-data">
                                <td className="sheet-cell">{row.sku || '—'}</td>
                                <td className="sheet-cell">{row.description}</td>
                                <td className="sheet-cell" colSpan={2} />
                                <td className="sheet-cell">{row.department}</td>
                                <td className="sheet-cell sheet-num">{row.quantity}</td>
                                <td className="sheet-cell sheet-num sheet-total-strong">{fmtMoney(row.extended_cost, true)}</td>
                                <td className="sheet-cell" colSpan={2} />
                            </tr>
                        ))}
                        {shrinkLines.map((line) => (
                            <tr key={line.shrink_id} className="sheet-row-data">
                                <td className="sheet-cell">{line.sku || '—'}</td>
                                <td className="sheet-cell">{line.description}</td>
                                <td className="sheet-cell">{line.supplier_name || '—'}</td>
                                <td className="sheet-cell">{line.invoice_number || '—'}</td>
                                <td className="sheet-cell">{line.department}</td>
                                <td className="sheet-cell sheet-num">{line.quantity}</td>
                                <td className="sheet-cell sheet-num">{fmtMoney(line.extended_cost, true)}</td>
                                <td className="sheet-cell">{line.reason || '—'}</td>
                                <td className="sheet-cell sheet-notes">
                                    {!readOnly ? (
                                    <button
                                        type="button"
                                        className="sheet-row-delete"
                                        disabled={!!busy}
                                        onClick={() => onDeleteShrink(line.shrink_id)}
                                    >
                                        ×
                                    </button>
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                        {!shrinkLines.length && !(shrinkSummary.by_sku || []).length ? (
                            <tr>
                                <td className="sheet-empty" colSpan={9}>
                                    Import shrink/credit PDFs on the receiving sheet, or add lines manually above.
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
