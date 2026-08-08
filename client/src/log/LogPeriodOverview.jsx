import { formatMoney, formatShortDate } from './logAnalyticsUtils.js';
import { addDays } from './logPeriodUtils.js';

const STATUS_LABELS = {
    open: 'Open',
    submitted: 'Submitted',
    approved: 'Approved',
    locked: 'Locked',
};

function CheckItem({ label, done, detail, onGo }) {
    return (
        <div className={`period-check-item${done ? ' done' : ''}`}>
            <div className="period-check-icon">{done ? '✓' : '○'}</div>
            <div className="period-check-body">
                <div className="period-check-label">{label}</div>
                <div className="period-check-detail">{detail}</div>
            </div>
            {onGo ? (
                <button type="button" className="log-btn log-btn-secondary log-btn-small" onClick={onGo}>
                    Open
                </button>
            ) : null}
        </div>
    );
}

export default function LogPeriodOverview({
    periodStart,
    periodEnd,
    periodData,
    periodStatus,
    loading,
    workflowBusy,
    onGoTab,
    onSubmitPeriod,
    onApprovePeriod,
    onClosePeriod,
    onReopenPeriod,
}) {
    if (!periodStart) {
        return <div className="log-panel-empty">Set a period start date to see the checklist.</div>;
    }

    const status = periodStatus?.status || 'open';
    const statusLabel = STATUS_LABELS[status] || status;
    const readOnly = status === 'submitted' || status === 'approved' || status === 'locked';

    const dayActivity = periodData?.day_activity || {};
    const receivingChecklist = periodData?.receiving_checklist || {};
    const daysWithData = receivingChecklist.days_with_data
        ?? Object.values(dayActivity).filter((n) => Number(n) > 0).length;
    const daysWithWarnings = receivingChecklist.days_with_warnings ?? 0;
    const periodEndPassed = receivingChecklist.period_end_passed ?? false;
    const totalLines = Object.values(dayActivity).reduce((sum, n) => sum + Number(n || 0), 0);

    const closeReadiness = periodData?.close_readiness || periodData?.period_close_readiness || null;
    const readinessChecks = closeReadiness?.checks || [];
    const checkPasses = (id) => readinessChecks.find((check) => check.id === id)?.status === 'pass';
    const salesDone = checkPasses('sales_confirmed');
    const marginReady = checkPasses('inventories_complete');
    const receivingReady = checkPasses('receiving_warnings_resolved')
        && checkPasses('active_days_certified')
        && checkPasses('freight_reconciled');
    const marginMeta = periodData?.margin?.meta || {};
    const salesWeeksFilled = closeReadiness?.sales_weeks_filled ?? 0;

    const rebateCount = periodData?.rebates?.line_count || 0;
    const recountCount = periodData?.recounts?.row_count || 0;
    const archivedWeeks = periodData?.sales_data?.column_count || 0;
    const snapshotCount = periodData?.margin_ytd?.period_count || 0;
    const dockExceptions = periodData?.dock_reconciliation?.exception_days || 0;

    const readyToClose = closeReadiness?.ready_to_close === true;
    const canSubmit = status === 'open' && !readOnly;
    const canApprove = status === 'submitted';
    const canClose = status === 'approved' && readyToClose;
    const canReopen = status === 'submitted' || status === 'approved' || status === 'locked';
    const reopenLabel = status === 'submitted' ? 'Withdraw submission' : 'Reopen period';

    const modelStatus = closeReadiness?.model_status
        || 'UNAVAILABLE';
    const failedChecks = (closeReadiness?.checks || [])
        .filter((c) => c.status === 'fail')
        .sort((a, b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1));

    return (
        <div className="period-overview">
            <div className={`model-status-banner ${String(modelStatus).toLowerCase()}`} data-testid="model-status">
                <strong>MODEL STATUS: {modelStatus}</strong>
                <div className="hint">
                    PASS means required controls passed — not merely that formulas ran.
                </div>
                {failedChecks.length ? (
                    <ul>
                        {failedChecks.slice(0, 12).map((check) => (
                            <li key={check.id}>
                                <strong>{check.id}</strong> — {check.message}
                                {check.remediation ? ` (${check.remediation})` : ''}
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">Period Checklist</div>
                    <div className="sheet-banner-sub">
                        {formatShortDate(periodStart)} → {formatShortDate(periodEnd || addDays(periodStart, 34))}
                        {loading ? ' · refreshing…' : ''}
                    </div>
                </div>
                <div className="sheet-banner-actions period-workflow-actions">
                    <span className={`period-status-pill period-status-${status}`}>{statusLabel}</span>
                    {canSubmit ? (
                        <button
                            type="button"
                            className="log-btn log-btn-secondary"
                            disabled={!!workflowBusy}
                            onClick={onSubmitPeriod}
                        >
                            {workflowBusy === 'submit' ? 'Submitting…' : 'Submit for approval'}
                        </button>
                    ) : null}
                    {canApprove ? (
                        <button
                            type="button"
                            className="log-btn log-btn-secondary"
                            disabled={!!workflowBusy}
                            onClick={onApprovePeriod}
                        >
                            {workflowBusy === 'approve' ? 'Approving…' : 'Approve period'}
                        </button>
                    ) : null}
                    {canClose ? (
                        <button
                            type="button"
                            className="log-btn"
                            disabled={!!workflowBusy || !closeReadiness?.ready_to_close}
                            onClick={onClosePeriod}
                            title={closeReadiness?.ready_to_close ? 'Archive, snapshot, and lock period' : 'Complete authoritative close-readiness checks first'}
                        >
                            {workflowBusy === 'close' ? 'Closing…' : 'Close & lock period'}
                        </button>
                    ) : null}
                    {canReopen ? (
                        <button
                            type="button"
                            className="log-btn log-btn-secondary"
                            disabled={!!workflowBusy}
                            onClick={onReopenPeriod}
                        >
                            {workflowBusy === 'reopen'
                                ? (status === 'submitted' ? 'Withdrawing…' : 'Reopening…')
                                : reopenLabel}
                        </button>
                    ) : null}
                </div>
            </div>

            {readOnly ? (
                <div className="period-lock-banner">
                    This period is {statusLabel.toLowerCase()} and read-only.
                    {status === 'submitted' && periodStatus?.submitted_by
                        ? ` Submitted by ${periodStatus.submitted_by}.`
                        : ''}
                    {periodStatus?.approved_by ? ` Approved by ${periodStatus.approved_by}.` : ''}
                    {periodStatus?.locked_by ? ` Locked by ${periodStatus.locked_by}.` : ''}
                    {status === 'submitted' ? ' Use Withdraw submission to edit again.' : ''}
                </div>
            ) : null}

            {status === 'submitted' && periodStatus?.submitted_by ? (
                <div className="period-check-hint">
                    Submitted by {periodStatus.submitted_by}
                    {periodStatus.submitted_at ? ` on ${formatShortDate(periodStatus.submitted_at.slice(0, 10))}` : ''}.
                </div>
            ) : null}

            <div className="period-check-grid">
                <CheckItem
                    label="Daily receiving"
                    done={receivingReady}
                    detail={periodEndPassed
                        ? (daysWithWarnings
                            ? `${daysWithData} day(s) with lines · ${daysWithWarnings} day(s) with warnings · ${totalLines} invoice lines`
                            : `${daysWithData} day(s) with lines · no line warnings · ${totalLines} invoice lines`)
                        : `${daysWithData} day(s) with lines · period ends ${formatShortDate(periodEnd || addDays(periodStart, 34))} · ${totalLines} invoice lines`}
                    onGo={() => onGoTab('sheet')}
                />
                <CheckItem
                    label="Sales numbers"
                    done={salesDone}
                    detail={salesDone ? 'Sales entries / confirmed zeros complete' : `${salesWeeksFilled}/5 weeks complete`}
                    onGo={() => onGoTab('sales')}
                />
                <CheckItem
                    label="Total grocery margin"
                    done={marginReady}
                    detail={marginReady
                        ? `Opening ${formatMoney(marginMeta.opening_inventory)} · Closing ${formatMoney(marginMeta.closing_inventory)}`
                        : 'Opening and closing inventory required'}
                    onGo={() => onGoTab('margin')}
                />
                <CheckItem
                    label="Dock reconciliation"
                    done={dockExceptions === 0}
                    detail={dockExceptions
                        ? `${dockExceptions} day(s) with dock/log mismatches`
                        : 'Dock arrivals match workbook suppliers'}
                    onGo={() => onGoTab('dock-reconcile')}
                />
                <CheckItem
                    label="Sales data archive"
                    done={archivedWeeks >= 5}
                    detail={archivedWeeks ? `${archivedWeeks} week columns archived` : 'Not archived yet'}
                    onGo={() => onGoTab('sales-data')}
                />
                <CheckItem
                    label="Margin YTD snapshot"
                    done={snapshotCount > 0}
                    detail={snapshotCount ? `${snapshotCount} period(s) in YTD` : 'No snapshots yet'}
                    onGo={() => onGoTab('margin-ytd')}
                />
                <CheckItem
                    label="Rebates"
                    done={rebateCount > 0}
                    detail={rebateCount ? `${rebateCount} rebate lines` : 'Optional — add if applicable'}
                    onGo={() => onGoTab('rebates')}
                />
                <CheckItem
                    label="Recounts"
                    done={recountCount > 0}
                    detail={recountCount ? `${recountCount} recount locations` : 'Optional — add if applicable'}
                    onGo={() => onGoTab('recounts')}
                />
            </div>

            {!readyToClose && status !== 'locked' ? (
                <div className="period-check-hint">
                    Close & lock remains unavailable until every authoritative readiness check above passes.
                </div>
            ) : null}
            {readyToClose && status === 'open' ? (
                <div className="period-check-hint period-check-hint-ready">
                    Checklist complete. Submit for approval, then approve, then close &amp; lock to archive sales and snapshot margin YTD. Use <strong>Full workbook</strong> in the toolbar to export the XLSX afterward.
                </div>
            ) : null}
            {status === 'locked' ? (
                <div className="period-check-hint period-check-hint-ready">
                    Period locked. Use Reopen period to make changes (requires a note; action is audited).
                </div>
            ) : null}
        </div>
    );
}
