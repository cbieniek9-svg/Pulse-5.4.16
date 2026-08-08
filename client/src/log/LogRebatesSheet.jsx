import { useState } from 'react';
import { saveRebateLine, deleteRebateLine } from './logApi.js';
import { DEPT_FIELDS, fmtMoney, invalidAmountFields, parseAmount } from './logUtils.js';

const EMPTY = {
    invoice_number: '',
    supplier_name: '',
    notes: '',
    grocery: '',
    tobacco: '',
    meat: '',
    bakery: '',
    bakery_in_store: '',
    deli: '',
    produce: '',
    produce_shrink: '',
    dairy: '',
    pharmacy: '',
    gst: '',
};

export default function LogRebatesSheet({ token, periodStart, rebates, busy, readOnly = false, onRefresh }) {
    const [form, setForm] = useState(EMPTY);
    const [saving, setSaving] = useState(false);

    if (!rebates) {
        return <div className="log-panel-empty">Loading rebates…</div>;
    }

    const updateForm = (patch) => setForm((prev) => ({ ...prev, ...patch }));

    const submit = async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        const bad = invalidAmountFields(form);
        if (bad.length) {
            alert(`Not a number: ${bad.join(', ')} — rebate not saved`);
            return;
        }
        setSaving(true);
        try {
            const payload = { period_start: periodStart, ...form };
            DEPT_FIELDS.forEach((field) => {
                payload[field.key] = parseAmount(form[field.key]);
            });
            await saveRebateLine(token, payload);
            setForm(EMPTY);
            await onRefresh();
        } catch (e) {
            alert(e.message);
        } finally {
            setSaving(false);
        }
    };

    const remove = async (rebateId) => {
        if (readOnly) return;
        if (!window.confirm('Delete this rebate line?')) return;
        try {
            await deleteRebateLine(token, rebateId);
            await onRefresh();
        } catch (e) {
            alert(e.message);
        }
    };

    return (
        <div className="sheet-shell sheet-shell-wide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Rebates</div>
                    <div className="sheet-banner-sub">
                        Period ending {rebates.period_ending || '—'} · {rebates.line_count || 0} lines · total {fmtMoney(rebates.line_total)}
                    </div>
                </div>
            </div>

            {!readOnly ? (
            <form className="shrink-add-form rebates-form" onSubmit={submit}>
                <div className="shrink-add-title">Add rebate invoice</div>
                <div className="rebates-form-row">
                    <label>
                        <span>Invoice #</span>
                        <input value={form.invoice_number} onChange={(ev) => updateForm({ invoice_number: ev.target.value })} />
                    </label>
                    <label>
                        <span>Supplier</span>
                        <input value={form.supplier_name} onChange={(ev) => updateForm({ supplier_name: ev.target.value })} />
                    </label>
                    <label>
                        <span>Notes</span>
                        <input value={form.notes} onChange={(ev) => updateForm({ notes: ev.target.value })} />
                    </label>
                </div>
                <div className="rebates-dept-grid">
                    {DEPT_FIELDS.map((field) => (
                        <label key={field.key}>
                            <span>{field.label}</span>
                            <input
                                inputMode="decimal"
                                value={form[field.key]}
                                onChange={(ev) => updateForm({ [field.key]: ev.target.value })}
                            />
                        </label>
                    ))}
                </div>
                <button type="submit" className="log-btn" disabled={!!busy || saving}>Add rebate line</button>
            </form>
            ) : null}

            <div className="sheet-scroll">
                <table className="sheet-grid rebates-grid">
                    <thead>
                        <tr>
                            <th>Invoice #</th>
                            <th>Supplier</th>
                            {DEPT_FIELDS.map((f) => <th key={f.key}>{f.label}</th>)}
                            <th>Notes</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {(rebates.lines || []).map((line) => (
                            <tr key={line.rebate_id}>
                                <td>{line.invoice_number || '—'}</td>
                                <td>{line.supplier_name || '—'}</td>
                                {DEPT_FIELDS.map((f) => (
                                    <td key={f.key} className="sheet-num">{fmtMoney(line[f.key], true)}</td>
                                ))}
                                <td>{line.notes || '—'}</td>
                                <td>
                                    {!readOnly ? (
                                    <button type="button" className="sheet-row-delete" disabled={!!busy} onClick={() => remove(line.rebate_id)}>×</button>
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                        {!rebates.lines?.length ? (
                            <tr><td colSpan={DEPT_FIELDS.length + 4} className="sheet-empty">No rebate lines yet.</td></tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
