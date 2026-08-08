import { formatMoney, formatShortDate } from './logAnalyticsUtils.js';

export default function LogSalesDataSheet({ salesData, onArchive, archiving, readOnly = false }) {
    if (!salesData) {
        return <div className="log-panel-empty">Loading sales data history…</div>;
    }

    const weekColumns = salesData.week_columns || [];

    return (
        <div className="sheet-shell sheet-shell-wide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Sales Data</div>
                    <div className="sheet-banner-sub">
                        {weekColumns.length} week columns · rolling sales archive
                    </div>
                </div>
                {!readOnly ? (
                <div className="sheet-banner-actions">
                    <button type="button" className="log-btn log-btn-secondary" disabled={archiving} onClick={onArchive}>
                        {archiving ? 'Archiving…' : 'Archive current period'}
                    </button>
                </div>
                ) : null}
            </div>

            {!weekColumns.length ? (
                <div className="log-panel-empty">
                    No archived sales weeks yet. Enter Sales Numbers for the period, then click Archive current period.
                </div>
            ) : (
                <div className="sheet-scroll">
                    <table className="sheet-grid sales-data-grid">
                        <thead>
                            <tr>
                                <th className="sticky-col sticky-col-a">Code</th>
                                <th className="sticky-col sticky-col-b">Category</th>
                                {weekColumns.map((we) => (
                                    <th key={we} className="sheet-head sheet-head-mini">{formatShortDate(we)}</th>
                                ))}
                                <th>Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            {(salesData.categories || []).map((cat) => (
                                <tr key={cat.key}>
                                    <td className="sticky-col sticky-col-a">{cat.code || '—'}</td>
                                    <td className="sticky-col sticky-col-b">{cat.label}</td>
                                    {weekColumns.map((we) => (
                                        <td key={we} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                            {formatMoney(cat.weeks?.[we])}
                                        </td>
                                    ))}
                                    <td className="sheet-cell sheet-cell-num sheet-cell-readonly">{formatMoney(cat.total)}</td>
                                </tr>
                            ))}
                            {(salesData.rollups || []).map((row) => (
                                <tr key={row.key} className="sheet-row-summary">
                                    <td className="sticky-col sticky-col-a" />
                                    <td className="sticky-col sticky-col-b sheet-label">{row.label}</td>
                                    {weekColumns.map((we) => (
                                        <td key={we} className="sheet-cell sheet-cell-num sheet-cell-readonly">
                                            {formatMoney(row.weeks?.[we])}
                                        </td>
                                    ))}
                                    <td />
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
