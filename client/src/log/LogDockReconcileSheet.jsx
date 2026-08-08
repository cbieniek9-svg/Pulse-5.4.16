import { formatShortDate } from './logAnalyticsUtils.js';

function DayRow({ day, onSelectDate, activeDate }) {
    const hasExceptions = day.dock_only.length > 0 || day.log_only.length > 0;
    return (
        <tr className={`dock-row${hasExceptions ? ' has-exception' : ''}${day.store_date === activeDate ? ' active' : ''}`}>
            <td>
                <button type="button" className="log-link-btn" onClick={() => onSelectDate?.(day.store_date)}>
                    {formatShortDate(day.store_date)}
                </button>
            </td>
            <td className="sheet-num">{day.dock_count}</td>
            <td className="sheet-num">{day.log_count}</td>
            <td className="sheet-num">{day.matched_count}</td>
            <td>
                {day.dock_only.length ? (
                    <span className="dock-tag dock-tag-warn">Dock only: {day.dock_only.join(', ')}</span>
                ) : null}
                {day.log_only.length ? (
                    <span className="dock-tag dock-tag-info">Log only: {day.log_only.join(', ')}</span>
                ) : null}
                {!hasExceptions && day.dock_count > 0 ? (
                    <span className="dock-tag dock-tag-ok">Matched</span>
                ) : null}
                {!day.dock_count && !day.log_count ? (
                    <span className="dock-muted">No activity</span>
                ) : null}
            </td>
        </tr>
    );
}

export default function LogDockReconcileSheet({ reconciliation, activeDate, onSelectDate }) {
    if (!reconciliation?.period_start) {
        return <div className="log-panel-empty">Load a period to compare dock arrivals with workbook suppliers.</div>;
    }

    const summary = reconciliation;

    return (
        <div className="dock-reconcile">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Dock ↔ Workbook Reconciliation</div>
                    <div className="sheet-banner-sub">
                        {formatShortDate(summary.period_start)} → {formatShortDate(summary.period_end)}
                    </div>
                </div>
            </div>

            <div className="dock-summary-grid">
                <div className="dock-summary-card">
                    <div className="dock-summary-value">{summary.total_dock_arrivals}</div>
                    <div className="dock-summary-label">Dock arrivals</div>
                </div>
                <div className="dock-summary-card">
                    <div className="dock-summary-value">{summary.total_log_suppliers}</div>
                    <div className="dock-summary-label">Workbook suppliers</div>
                </div>
                <div className="dock-summary-card">
                    <div className="dock-summary-value">{summary.exception_days}</div>
                    <div className="dock-summary-label">Days with exceptions</div>
                </div>
                <div className="dock-summary-card">
                    <div className="dock-summary-value">{summary.days_fully_matched}</div>
                    <div className="dock-summary-label">Fully matched days</div>
                </div>
            </div>

            <div className="dock-table-wrap">
                <table className="dock-table">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Dock</th>
                            <th>Log</th>
                            <th>Matched</th>
                            <th>Exceptions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {(summary.days || []).map((day) => (
                            <DayRow
                                key={day.store_date}
                                day={day}
                                activeDate={activeDate}
                                onSelectDate={onSelectDate}
                            />
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="period-check-hint">
                Compares vendors marked arrived on /rec with supplier names on daily receiving lines. Names are matched loosely (abbreviations and spacing ignored).
            </div>
        </div>
    );
}
