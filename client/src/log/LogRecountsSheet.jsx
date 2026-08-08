import { useState } from 'react';
import { saveRecount, deleteRecount } from './logApi.js';
import { formatMoney, formatPct } from './logAnalyticsUtils.js';
import { isInvalidAmount, parseAmount } from './logUtils.js';

const EMPTY = { location: '', count_first: '', count_second: '' };

export default function LogRecountsSheet({ token, periodStart, recounts, busy, readOnly = false, onRefresh }) {
    const [form, setForm] = useState(EMPTY);
    const [saving, setSaving] = useState(false);

    if (!recounts) {
        return <div className="log-panel-empty">Loading recounts…</div>;
    }

    const submit = async (ev) => {
        ev.preventDefault();
        if (readOnly) return;
        if (!form.location.trim()) {
            alert('Location is required.');
            return;
        }
        if (isInvalidAmount(form.count_first) || isInvalidAmount(form.count_second)) {
            alert('Not a number: count — recount not saved');
            return;
        }
        setSaving(true);
        try {
            await saveRecount(token, {
                period_start: periodStart,
                location: form.location.trim(),
                count_first: form.count_first === '' ? null : parseAmount(form.count_first),
                count_second: form.count_second === '' ? null : parseAmount(form.count_second),
            });
            setForm(EMPTY);
            await onRefresh();
        } catch (e) {
            alert(e.message);
        } finally {
            setSaving(false);
        }
    };

    const remove = async (recountId) => {
        if (readOnly) return;
        if (!window.confirm('Delete this recount row?')) return;
        try {
            await deleteRecount(token, recountId);
            await onRefresh();
        } catch (e) {
            alert(e.message);
        }
    };

    return (
        <div className="sheet-shell sheet-shell-wide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Recounts</div>
                    <div className="sheet-banner-sub">{recounts.row_count || 0} locations · inventory verification</div>
                </div>
            </div>

            {!readOnly ? (
            <form className="shrink-add-form" onSubmit={submit}>
                <div className="shrink-add-title">Add recount location</div>
                <div className="shrink-add-grid">
                    <label>
                        <span>Location</span>
                        <input value={form.location} onChange={(ev) => setForm((p) => ({ ...p, location: ev.target.value }))} required />
                    </label>
                    <label>
                        <span>1st count $</span>
                        <input inputMode="decimal" value={form.count_first} onChange={(ev) => setForm((p) => ({ ...p, count_first: ev.target.value }))} />
                    </label>
                    <label>
                        <span>2nd count $</span>
                        <input inputMode="decimal" value={form.count_second} onChange={(ev) => setForm((p) => ({ ...p, count_second: ev.target.value }))} />
                    </label>
                </div>
                <button type="submit" className="log-btn" disabled={!!busy || saving}>Add recount</button>
            </form>
            ) : null}

            <div className="sheet-scroll">
                <table className="sheet-grid recounts-grid">
                    <thead>
                        <tr>
                            <th>Location</th>
                            <th>1st count</th>
                            <th>2nd count</th>
                            <th>Variance $</th>
                            <th>Variance %</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {(recounts.rows || []).map((row) => (
                            <tr key={row.recount_id}>
                                <td>{row.location}</td>
                                <td className="sheet-num">{formatMoney(row.count_first)}</td>
                                <td className="sheet-num">{formatMoney(row.count_second)}</td>
                                <td className="sheet-num">{formatMoney(row.variance_dollars)}</td>
                                <td className="sheet-num">{formatPct(row.variance_ratio)}</td>
                                <td>
                                    {!readOnly ? (
                                    <button type="button" className="sheet-row-delete" disabled={!!busy} onClick={() => remove(row.recount_id)}>×</button>
                                    ) : null}
                                </td>
                            </tr>
                        ))}
                        {recounts.totals ? (
                            <tr className="sheet-row-highlight">
                                <td>Total</td>
                                <td className="sheet-num">{formatMoney(recounts.totals.count_first)}</td>
                                <td className="sheet-num">{formatMoney(recounts.totals.count_second)}</td>
                                <td className="sheet-num">{formatMoney(recounts.totals.variance_dollars)}</td>
                                <td className="sheet-num">{formatPct(recounts.totals.variance_ratio)}</td>
                                <td />
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
