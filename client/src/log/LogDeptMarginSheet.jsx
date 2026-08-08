import { useState } from 'react';
import { saveDeptMargin } from './logApi.js';
import { formatMoney, formatPct, formatShortDate, isInvalidAmount, parseSheetAmount } from './logAnalyticsUtils.js';

function MarginField({ label, value, pct, onSave, disabled }) {
    const [draft, setDraft] = useState(null);
    const display = draft != null
        ? draft
        : (pct ? (value != null ? `${(Number(value) * 100).toFixed(4)}` : '') : formatMoney(value));

    return (
        <label className="margin-field">
            <span>{label}</span>
            <input
                value={display}
                disabled={disabled}
                onChange={(ev) => setDraft(ev.target.value)}
                onFocus={() => setDraft(pct ? String((Number(value || 0) * 100)) : String(value ?? ''))}
                onBlur={() => {
                    if (isInvalidAmount(draft)) {
                        alert(`Not a number: ${label} — not saved`);
                        setDraft(null);
                        return;
                    }
                    const raw = parseSheetAmount(draft);
                    setDraft(null);
                    onSave(pct ? raw / 100 : raw);
                }}
            />
        </label>
    );
}

function ReadRow({ label, value, pct, strong }) {
    return (
        <div className={`margin-read-row${strong ? ' strong' : ''}`}>
            <span>{label}</span>
            <span>{pct ? formatPct(value) : formatMoney(value)}</span>
        </div>
    );
}

export default function LogDeptMarginSheet({
    token,
    periodStart,
    department,
    margin,
    busy,
    readOnly = false,
    onRefresh,
}) {
    const [saving, setSaving] = useState(false);

    if (!margin) {
        return <div className="log-panel-empty">Loading {department} margin…</div>;
    }

    const saveMeta = async (patch) => {
        if (readOnly) return;
        setSaving(true);
        try {
            await saveDeptMargin(token, {
                period_start: periodStart,
                department,
                ...patch,
            });
            await onRefresh();
        } catch (e) {
            alert(e.message);
        } finally {
            setSaving(false);
        }
    };

    const meta = margin.meta || {};
    const totals = margin.totals || {};

    return (
        <div className="margin-shell">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">{margin.label || department} Margin</div>
                    <div className="sheet-banner-sub">
                        Period {margin.period_number || '—'} · starts {formatShortDate(margin.period_start)}
                    </div>
                </div>
            </div>

            <div className="margin-grid-layout">
                <section className="margin-panel">
                    <div className="margin-panel-title">Weekly sales {margin.has_shrink ? '& shrink' : ''}</div>
                    <table className="sheet-mini-grid margin-week-grid">
                        <thead>
                            <tr>
                                <th>Week ending</th>
                                <th>Sales</th>
                                {margin.has_shrink ? <th>Shrink $</th> : null}
                                {margin.has_shrink ? <th>Shrink %</th> : null}
                            </tr>
                        </thead>
                        <tbody>
                            {(margin.weeks || []).map((week) => (
                                <tr key={week.week_num}>
                                    <td>{formatShortDate(week.week_ending)}</td>
                                    <td>{formatMoney(week.sales)}</td>
                                    {margin.has_shrink ? <td>{formatMoney(week.shrink_dollars)}</td> : null}
                                    {margin.has_shrink ? <td>{formatPct(week.shrink_pct)}</td> : null}
                                </tr>
                            ))}
                            <tr className="sheet-row-highlight">
                                <td>Total</td>
                                <td>{formatMoney(totals.sales)}</td>
                                {margin.has_shrink ? <td>{formatMoney(totals.shrink_dollars)}</td> : null}
                                {margin.has_shrink ? <td>{formatPct(totals.shrink_pct)}</td> : null}
                            </tr>
                        </tbody>
                    </table>
                </section>

                <section className="margin-panel">
                    <div className="margin-panel-title">Inventory &amp; margin inputs</div>
                    <div className="margin-fields">
                        <MarginField label="Opening inventory" value={meta.opening_inventory} onSave={(v) => saveMeta({ opening_inventory: v })} disabled={readOnly || busy || saving} />
                        <MarginField label="Closing inventory" value={meta.closing_inventory} onSave={(v) => saveMeta({ closing_inventory: v })} disabled={readOnly || busy || saving} />
                        <MarginField label="Last inventory" value={meta.last_inventory} onSave={(v) => saveMeta({ last_inventory: v })} disabled={readOnly || busy || saving} />
                        {department === 'produce' ? (
                            <MarginField label="Inventory adjustment" value={meta.inventory_adjustment} onSave={(v) => saveMeta({ inventory_adjustment: v })} disabled={readOnly || busy || saving} />
                        ) : null}
                        <MarginField label="Target margin %" value={meta.target_margin_pct} pct onSave={(v) => saveMeta({ target_margin_pct: v })} disabled={readOnly || busy || saving} />
                        <MarginField label="SMS margin %" value={meta.sms_margin_pct} pct onSave={(v) => saveMeta({ sms_margin_pct: v })} disabled={readOnly || busy || saving} />
                        {margin.has_count_day ? (
                            <>
                                <MarginField label="Sales before count" value={meta.sales_before_count} onSave={(v) => saveMeta({ sales_before_count: v })} disabled={readOnly || busy || saving} />
                                <MarginField label="Sales after count" value={meta.sales_after_count} onSave={(v) => saveMeta({ sales_after_count: v })} disabled={readOnly || busy || saving} />
                                <MarginField label="Sales during count" value={meta.sales_during_count} onSave={(v) => saveMeta({ sales_during_count: v })} disabled={readOnly || busy || saving} />
                            </>
                        ) : null}
                    </div>
                    <label className="margin-field margin-field-wide">
                        <span>Variance explanation</span>
                        <textarea
                            defaultValue={meta.variance_explanation || ''}
                            disabled={readOnly || busy || saving}
                            onBlur={(ev) => saveMeta({ variance_explanation: ev.target.value })}
                        />
                    </label>
                </section>

                <section className="margin-panel">
                    <div className="margin-panel-title">Calculated margin</div>
                    <ReadRow label="Add total purchases" value={totals.purchases} />
                    <ReadRow label="Total goods available for sale" value={totals.goods_available} />
                    <ReadRow label="Cost of goods sold" value={totals.cogs} />
                    <ReadRow label="Gross profit" value={totals.gross_profit} strong />
                    <ReadRow label="Gross margin %" value={totals.gross_margin_pct} pct strong />
                    <ReadRow label="SMS GP $" value={totals.sms_gp} />
                    <ReadRow label="Difference GP$ (Actual - SMS)" value={totals.gp_diff} />
                    {margin.has_shrink ? (
                        <>
                            <ReadRow label="Shrink adjusted GP $" value={totals.shrink_adjusted_gp} />
                            <ReadRow label="Shrink adjusted margin %" value={totals.shrink_adjusted_margin_pct} pct />
                        </>
                    ) : null}
                    <ReadRow label="Current inventory" value={totals.inventory_current} />
                    <ReadRow label="Last inventory" value={totals.inventory_last} />
                    <ReadRow label="Difference (Current - Last)" value={totals.inventory_diff} />
                </section>
            </div>
        </div>
    );
}
