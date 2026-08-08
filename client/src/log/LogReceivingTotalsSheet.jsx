import { formatMoney, formatShortDate, PURCHASE_COLUMNS, SHRINK_BUCKETS } from './logAnalyticsUtils.js';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function LogReceivingTotalsSheet({ receivingTotals }) {
    if (!receivingTotals) {
        return <div className="log-panel-empty">Loading receiving totals…</div>;
    }

    const weeklyByNum = Object.fromEntries(
        (receivingTotals.weekly_shrink || []).map((w) => [w.week_num, w]),
    );

    return (
        <div className="sheet-shell sheet-shell-wide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Receiving Totals</div>
                    <div className="sheet-banner-sub">
                        Daily purchases and shrink · period starts {formatShortDate(receivingTotals.period_start)}
                        {receivingTotals.costing_method === 'period_department_allocation'
                            || receivingTotals.costing_mode === 'period_department_allocation'
                            || receivingTotals.costing_method === 'legacy_fixed_allocation'
                            || receivingTotals.costing_mode === 'legacy_fixed_allocation'
                            ? ' · department allocation (authoritative)'
                            : receivingTotals.costing_method === 'period_rate' || receivingTotals.costing_mode === 'period_rate'
                                ? ` · superseded period freight rate${receivingTotals.period_freight_rate_percent != null ? ` ${receivingTotals.period_freight_rate_percent}%` : ''} (audit only)`
                                : receivingTotals.costing_method === 'invoice_freight' || receivingTotals.costing_mode === 'invoice_freight'
                                    ? ' · invoice estimated freight (reference only — not in landed)'
                                    : receivingTotals.costing_method === 'base_cost_only' || receivingTotals.costing_mode === 'base_cost_only' || receivingTotals.costing_mode === 'sms_landed'
                                        ? ' · base cost only (diagnostic)'
                                        : ' · department allocation freight'}
                        {receivingTotals.freight_included_total
                            ? ` · allocated freight ${formatMoney(receivingTotals.freight_included_total)}`
                            : receivingTotals.freight_memo_total
                                ? ` · day freight memo ${formatMoney(receivingTotals.freight_memo_total)}`
                                : ''}
                        {receivingTotals.reconciliation_status
                            ? ` · freight recon ${receivingTotals.reconciliation_status}`
                            : ''}
                    </div>
                </div>
                <div className="sheet-banner-stats">
                    <div>
                        <span>Purchases</span>
                        <strong>{formatMoney(receivingTotals.purchase_total)}</strong>
                    </div>
                </div>
            </div>

            <div className="sheet-scroll">
                <table className="sheet-grid totals-grid">
                    <thead>
                        <tr className="sheet-row-head">
                            <th className="sticky-col sticky-col-a">Date</th>
                            <th className="sticky-col sticky-col-b">Day</th>
                            {PURCHASE_COLUMNS.map((col) => (
                                <th key={col.key} className="sheet-head sheet-head-mini">{col.label}</th>
                            ))}
                            {SHRINK_BUCKETS.map((col) => (
                                <th key={col.key} className="sheet-head sheet-head-shrink">{col.label}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {(receivingTotals.days || []).map((day) => {
                            const weekly = weeklyByNum[day.week_num];
                            const showWeekly = day.is_week_end && weekly;
                            return [
                                <tr key={day.store_date} className={day.is_week_end ? 'sheet-row-week-end' : 'sheet-row-data'}>
                                    <td className="sticky-col sticky-col-a">{formatShortDate(day.store_date)}</td>
                                    <td className="sticky-col sticky-col-b">{DAY_NAMES[day.day_of_week]}</td>
                                    {PURCHASE_COLUMNS.map((col) => (
                                        <td key={col.key} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                            {formatMoney(day.purchases?.[col.key])}
                                        </td>
                                    ))}
                                    {SHRINK_BUCKETS.map((col) => (
                                        <td key={col.key} className="sheet-cell sheet-cell-num sheet-cell-readonly sheet-cell-shrink">
                                            {formatMoney(day.shrink?.[col.key])}
                                        </td>
                                    ))}
                                </tr>,
                                showWeekly ? (
                                    <tr key={`${day.store_date}-subtotal`} className="sheet-row-weekly-subtotal">
                                        <td className="sticky-col sticky-col-a" colSpan={2}>
                                            Weekly subtotal · Wk {day.week_num}
                                        </td>
                                        {PURCHASE_COLUMNS.map((col) => (
                                            <td key={col.key} className="sheet-cell sheet-cell-readonly" />
                                        ))}
                                        {SHRINK_BUCKETS.map((col) => (
                                            <td key={col.key} className="sheet-cell sheet-cell-num sheet-cell-readonly sheet-cell-shrink">
                                                {formatMoney(weekly.shrink?.[col.key])}
                                            </td>
                                        ))}
                                    </tr>
                                ) : null,
                            ];
                        })}
                    </tbody>
                </table>
            </div>

            <div className="sheet-side-panel">
                <div className="sheet-side-title">Weekly shrink summary</div>
                <table className="sheet-mini-grid">
                    <thead>
                        <tr>
                            <th>Week ending</th>
                            {SHRINK_BUCKETS.map((col) => <th key={col.key}>{col.label}</th>)}
                            <th>Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(receivingTotals.weekly_shrink || []).map((week) => (
                            <tr key={week.week_num}>
                                <td>{formatShortDate(week.week_ending)}</td>
                                {SHRINK_BUCKETS.map((col) => (
                                    <td key={col.key}>{formatMoney(week.shrink?.[col.key])}</td>
                                ))}
                                <td>{formatMoney(week.total)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
