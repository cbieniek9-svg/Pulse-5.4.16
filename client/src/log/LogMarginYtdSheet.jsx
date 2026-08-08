import { formatMoney, formatPct, formatShortDate } from './logAnalyticsUtils.js';

export default function LogMarginYtdSheet({ marginYtd, onSnapshot, snapshotting, readOnly = false }) {
    if (!marginYtd) {
        return <div className="log-panel-empty">Loading margin YTD…</div>;
    }

    return (
        <div className="sheet-shell sheet-shell-wide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Margin YTD</div>
                    <div className="sheet-banner-sub">
                        {marginYtd.period_count || 0} periods tracked
                    </div>
                </div>
                {!readOnly ? (
                <div className="sheet-banner-actions">
                    <button type="button" className="log-btn log-btn-secondary" disabled={snapshotting} onClick={onSnapshot}>
                        {snapshotting ? 'Saving…' : 'Snapshot current period'}
                    </button>
                </div>
                ) : null}
            </div>

            <div className="sheet-scroll">
                <table className="sheet-grid margin-ytd-grid">
                    <thead>
                        <tr>
                            <th>Period start</th>
                            <th>Period #</th>
                            <th>Total grocery sales</th>
                            <th>Gross profit</th>
                            <th>Margin %</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(marginYtd.rows || []).map((row) => (
                            <tr key={row.period_start} className={row.is_current ? 'sheet-row-highlight' : 'sheet-row-data'}>
                                <td>{formatShortDate(row.period_start)}</td>
                                <td>{row.period_number || '—'}</td>
                                <td className="sheet-num">{formatMoney(row.total_grocery_sales)}</td>
                                <td className="sheet-num">{formatMoney(row.total_grocery_gp)}</td>
                                <td className="sheet-num">{formatPct(row.total_grocery_margin_pct)}</td>
                            </tr>
                        ))}
                        {marginYtd.totals ? (
                            <tr className="sheet-row-summary">
                                <td colSpan={2}>YTD total</td>
                                <td className="sheet-num">{formatMoney(marginYtd.totals.total_grocery_sales)}</td>
                                <td className="sheet-num">{formatMoney(marginYtd.totals.total_grocery_gp)}</td>
                                <td className="sheet-num">{formatPct(marginYtd.totals.avg_margin_pct)}</td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
