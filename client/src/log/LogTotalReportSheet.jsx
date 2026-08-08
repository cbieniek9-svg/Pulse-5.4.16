import { formatShortDate } from './logAnalyticsUtils.js';
import { dayLabel } from './logPeriodUtils.js';

export default function LogTotalReportSheet({ totalReport }) {
    if (!totalReport) {
        return <div className="log-panel-empty">Loading total report…</div>;
    }

    const columns = totalReport.columns || [];
    const maxRows = Math.max(1, totalReport.max_rows || 0);

    return (
        <div className="sheet-shell sheet-shell-wide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Total Report</div>
                    <div className="sheet-banner-sub">
                        Invoice cross-tab · {totalReport.invoice_count || 0} invoices · period starts {formatShortDate(totalReport.period_start)}
                    </div>
                </div>
            </div>

            <div className="sheet-scroll">
                <table className="sheet-grid total-report-grid">
                    <thead>
                        <tr className="sheet-row-head">
                            <th className="sticky-col sticky-col-a">Row</th>
                            {columns.map((col) => (
                                <th key={col.store_date} className="sheet-head sheet-head-mini total-report-col">
                                    <div>{dayLabel(col.store_date)}</div>
                                    <div className="total-report-sub">Wk {col.week_num}</div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {Array.from({ length: maxRows }, (_, rowIdx) => (
                            <tr key={rowIdx} className="sheet-row-data">
                                <td className="sticky-col sticky-col-a sheet-cell-readonly">{rowIdx + 1}</td>
                                {columns.map((col) => {
                                    const inv = col.invoices?.[rowIdx];
                                    return (
                                        <td key={col.store_date} className="sheet-cell total-report-cell" title={inv?.supplier_name || ''}>
                                            {inv?.invoice_number || ''}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
