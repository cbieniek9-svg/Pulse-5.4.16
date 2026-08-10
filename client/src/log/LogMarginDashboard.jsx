import { useState } from 'react';
import { saveMarginDashboard } from './logApi.js';
import { formatMoney, formatPct, formatShortDate } from './logAnalyticsUtils.js';
import { MarginField, ReadRow } from './logMarginFields.jsx';

export default function LogMarginDashboard({
    token,
    periodStart,
    margin,
    busy,
    readOnly = false,
    onRefresh,
}) {
    const [saving, setSaving] = useState(false);

    if (!margin) {
        return <div className="log-panel-empty">Loading margin dashboard…</div>;
    }

    const saveMeta = async (patch) => {
        if (readOnly) return;
        setSaving(true);
        try {
            await saveMarginDashboard(token, {
                period_start: periodStart,
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
                    <div className="sheet-banner-title">Total Grocery / Margin</div>
                    <div className="sheet-banner-sub">
                        Period {meta.period_number || margin.period_number || '—'} · starts {formatShortDate(margin.period_start)}
                    </div>
                </div>
            </div>

            <div className="margin-grid-layout">
                <section className="margin-panel">
                    <div className="margin-panel-title">Weekly sales &amp; shrink</div>
                    <table className="sheet-mini-grid margin-week-grid">
                        <thead>
                            <tr>
                                <th>Week ending</th>
                                <th>Total Grocery Sales</th>
                                <th>Shrink $</th>
                                <th>Shrink %</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(margin.weeks || []).map((week) => (
                                <tr key={week.week_num}>
                                    <td>{formatShortDate(week.week_ending)}</td>
                                    <td>{formatMoney(week.sales)}</td>
                                    <td>{formatMoney(week.shrink_dollars)}</td>
                                    <td>{formatPct(week.shrink_pct)}</td>
                                </tr>
                            ))}
                            <tr className="sheet-row-highlight">
                                <td>Total Sales</td>
                                <td>{formatMoney(totals.sales)}</td>
                                <td>{formatMoney(totals.shrink_dollars)}</td>
                                <td>{formatPct(totals.shrink_pct)}</td>
                            </tr>
                        </tbody>
                    </table>
                </section>

                <section className="margin-panel">
                    <div className="margin-panel-title">Inventory &amp; margin inputs</div>
                    <div className="margin-fields">
                        <MarginField
                            label="Period #"
                            value={meta.period_number}
                            onSave={(v) => {
                                const n = Math.round(Number(v));
                                if (!Number.isFinite(n) || n <= 0) {
                                    alert('Period # must be a finite number greater than 0.');
                                    return;
                                }
                                saveMeta({ period_number: n });
                            }}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="Opening inventory"
                            value={meta.opening_inventory}
                            onSave={(v) => saveMeta({ opening_inventory: v })}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="Closing inventory"
                            value={meta.closing_inventory}
                            onSave={(v) => saveMeta({ closing_inventory: v })}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="Last inventory"
                            value={meta.last_inventory}
                            onSave={(v) => saveMeta({ last_inventory: v })}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="Target margin %"
                            value={meta.target_margin_pct}
                            pct
                            onSave={(v) => saveMeta({ target_margin_pct: v })}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="SMS margin %"
                            value={meta.sms_margin_pct}
                            pct
                            onSave={(v) => saveMeta({ sms_margin_pct: v })}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="Sales before count"
                            value={meta.sales_before_count}
                            onSave={(v) => saveMeta({ sales_before_count: v })}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="Sales after count"
                            value={meta.sales_after_count}
                            onSave={(v) => saveMeta({ sales_after_count: v })}
                            disabled={readOnly || busy || saving}
                        />
                        <MarginField
                            label="Sales during count"
                            value={meta.sales_during_count}
                            onSave={(v) => saveMeta({ sales_during_count: v })}
                            disabled={readOnly || busy || saving}
                        />
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
                    <ReadRow label="Difference % (Actual - SMS)" value={totals.gp_diff_pct} pct />
                    <ReadRow label="Shrink adjusted GP $" value={totals.shrink_adjusted_gp} />
                    <ReadRow label="Shrink adjusted margin %" value={totals.shrink_adjusted_margin_pct} pct />
                    <ReadRow label="Inventory should be" value={totals.inventory_should_be} />
                    <ReadRow label="Current inventory" value={totals.inventory_current} />
                    <ReadRow label="Last inventory" value={totals.inventory_last} />
                    <ReadRow label="Difference (Current - Last)" value={totals.inventory_diff} />
                </section>
            </div>
        </div>
    );
}
