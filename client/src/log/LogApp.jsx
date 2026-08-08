import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import PortalBackBar from '../components/shared/PortalBackBar.jsx';
import {
    deleteShrinkLine,
    downloadFullPeriodWorkbook,
    downloadReportWorkbook,
    fetchWorkbookVendors,
    overrideFreightRecon,
    setCostingMethod,
} from './logApi.js';
import LogImportPanel from './LogImportPanel.jsx';
import LogWorkbookImportPanel from './LogWorkbookImportPanel.jsx';
import LogSpreadsheetGrid from './LogSpreadsheetGrid.jsx';
import LogShrinkSheet from './LogShrinkSheet.jsx';
import LogSalesSheet from './LogSalesSheet.jsx';
import LogReceivingTotalsSheet from './LogReceivingTotalsSheet.jsx';
import LogMarginDashboard from './LogMarginDashboard.jsx';
import LogCostingComparisonBanner from './LogCostingComparisonBanner.jsx';
import LogTotalReportSheet from './LogTotalReportSheet.jsx';
import LogDeptMarginSheet from './LogDeptMarginSheet.jsx';
import LogRebatesSheet from './LogRebatesSheet.jsx';
import LogRecountsSheet from './LogRecountsSheet.jsx';
import LogSalesDataSheet from './LogSalesDataSheet.jsx';
import LogMarginYtdSheet from './LogMarginYtdSheet.jsx';
import LogCountCycleSheet from './LogCountCycleSheet.jsx';
import LogPeriodOverview from './LogPeriodOverview.jsx';
import LogDockReconcileSheet from './LogDockReconcileSheet.jsx';
import LogHelpGuide from './LogHelpGuide.jsx';
import LogDayIntegrityControls from './LogDayIntegrityControls.jsx';
import { useLogPersistence } from './useLogPersistence.js';
import { useLogPeriodWorkflow } from './useLogPeriodWorkflow.js';
import { emptyLine, rowHasData } from './logUtils.js';
import { dayLabel } from './logPeriodUtils.js';
import {
    DEPT_TAB_MAP,
    LOG_NAV_GROUPS,
    PERIOD_TABS,
    findGroupForTab,
    readPortalState,
    writePortalState,
} from './logNavConfig.js';
import '../styles/log.css';

export default function LogApp() {
    const { token, user } = useAuth();
    const saved = readPortalState();
    const [storeDate, setStoreDate] = useState(saved?.storeDate || '');
    const [activeGroup, setActiveGroup] = useState(saved?.activeGroup || 'overview');
    const [activeTab, setActiveTab] = useState(saved?.activeTab || 'overview');
    const [showImport, setShowImport] = useState(false);
    const [showWorkbookImport, setShowWorkbookImport] = useState(false);
    const [vendorNames, setVendorNames] = useState([]);

    const {
        report,
        setReport,
        periodData,
        setPeriodData,
        periodLoading,
        periodStatus,
        periodReadOnly,
        gridRows,
        setGridRows,
        gridMeta,
        setGridPage,
        error,
        setError,
        busy,
        setBusy,
        saveState,
        rowWarnings,
        headerDraft,
        setHeaderDraft,
        load,
        loadPeriod,
        schedulePeriodRefresh,
        queueHeaderSave,
        updateRow,
        persistRow,
        persistFreightRow,
        handlePasteRows,
        removeLine,
        setFreightDirty,
        confirmDiscardUnsaved,
    } = useLogPersistence({ token, storeDate });

    // The Financial Log route itself is manager-gated; AuthProvider persists the
    // display name rather than a role object, so role checks cannot be derived
    // client-side here. Sensitive actions remain manager-guarded by their APIs.
    const isManager = true;
    const confirmCostingMethod = async (method) => {
        const reason = window.prompt(`Manager reason for selecting ${method.replaceAll('_', ' ')}:`);
        if (!reason?.trim()) return;
        try {
            await setCostingMethod(token, {
                period_start: periodStart,
                method,
                reason: reason.trim(),
            });
            await refreshPeriod();
        } catch (error) {
            alert(error.message);
        }
    };

    const setStoreDateSafe = (nextDate) => {
        if (!nextDate || nextDate === storeDate) return;
        if (!confirmDiscardUnsaved('You have unsaved freight changes. Discard them and change day?')) {
            return;
        }
        setStoreDate(nextDate);
    };
    const {
        DAILY_TABS,
        archiving,
        snapshotting,
        closingPeriod,
        workflowBusy,
        periodStart,
        periodEnd,
        periodChoices,
        activePeriodIndex,
        selectPeriod,
        setOperationalPeriod,
        navigatePeriod,
        handleReceivingDateChange,
        navigateDay,
        selectWeek,
        handleWorkbookImported,
        refreshPeriod,
        handleArchiveSales,
        handleSnapshotPeriod,
        handleClosePeriod,
        handleSubmitPeriod,
        handleApprovePeriod,
        handleReopenPeriod,
        sheetHint,
        currentWeek,
        weekStrip,
        dayActivity,
        showDayNav,
        periodOptionLabel,
        periodButtonLabel,
    } = useLogPeriodWorkflow({
        token,
        storeDate,
        setStoreDate: setStoreDateSafe,
        activeTab,
        periodData,
        setPeriodData,
        periodStatus,
        headerDraft,
        setHeaderDraft,
        report,
        setBusy,
        setError,
        load,
        loadPeriod,
    });

    const activeGroupConfig = useMemo(
        () => LOG_NAV_GROUPS.find((g) => g.id === activeGroup) || LOG_NAV_GROUPS[0],
        [activeGroup],
    );

    useEffect(() => {
        if (!storeDate) setStoreDate(new Date().toISOString().slice(0, 10));
    }, [storeDate]);

    useEffect(() => {
        if (!token) return;
        fetchWorkbookVendors(token)
            .then((payload) => setVendorNames(payload.vendors || []))
            .catch(() => setVendorNames([]));
    }, [token]);

    useEffect(() => {
        writePortalState({ storeDate, activeGroup, activeTab });
    }, [storeDate, activeGroup, activeTab]);

    useEffect(() => {
        if (!storeDate) return;
        if (DAILY_TABS.has(activeTab) || activeTab === 'total-report') {
            load(storeDate);
        }
    }, [storeDate, activeTab, load, DAILY_TABS]);

    useEffect(() => {
        if (!storeDate) return;
        loadPeriod(storeDate, { silent: !PERIOD_TABS.has(activeTab) });
    }, [storeDate, activeTab, loadPeriod]);

    const removeShrink = async (shrinkId) => {
        if (periodReadOnly) return;
        if (!window.confirm('Delete this shrink line?')) return;
        setBusy(shrinkId);
        try {
            await deleteShrinkLine(token, shrinkId);
            await load(storeDate);
            schedulePeriodRefresh();
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy('');
        }
    };

    const exportDailyWorkbook = async () => {
        setBusy('export-day');
        try {
            await downloadReportWorkbook(token, storeDate);
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy('');
        }
    };

    const exportFullWorkbook = async () => {
        setBusy('export-period');
        try {
            await downloadFullPeriodWorkbook(token, storeDate);
            await loadPeriod(storeDate);
        } catch (e) {
            alert(e.message);
        } finally {
            setBusy('');
        }
    };

    const goToTab = (tabId) => {
        if (!confirmDiscardUnsaved('You have unsaved freight changes. Discard them and leave this sheet?')) {
            return;
        }
        const group = findGroupForTab(tabId);
        setActiveGroup(group.id);
        setActiveTab(tabId);
    };

    const addWriteOffRow = () => {
        if (periodReadOnly) return;
        setGridRows((rows) => {
            const idx = rows.findIndex((row) => !rowHasData(row));
            if (idx < 0) {
                alert('No empty rows available.');
                return rows;
            }
            const next = [...rows];
            next[idx] = emptyLine('write_off');
            return next;
        });
    };

    const shrinkSummary = report?.shrink_summary || {};
    const shrinkLines = report?.shrink_lines || [];

    const saveLabel = {
        idle: '',
        saving: 'Saving…',
        saved: 'Saved',
        error: 'Save failed',
    }[saveState];

    return (
        <div className="log-portal" data-pulse-surface="log">
            <PortalBackBar backTo="/" backLabel="← TGP Center Store" />
            <main id="main" className="log-main" style={{ minHeight: '70vh' }}>
            <div className="log-toolbar">
                <div className="log-toolbar-left">
                    <div className="log-title">Financial Log — Edmonton Wholesale Market Receiving Report</div>
                    <div className="log-subtitle">{sheetHint || '35-day receiving workbook · /financial'}</div>
                </div>
                <div className="log-toolbar-right">
                    {saveLabel ? <span className={`log-save-status log-save-${saveState}`}>{saveLabel}</span> : null}
                    <span className="log-user">{user}</span>
                </div>
            </div>

            {error ? <div className="log-error">{error}</div> : null}

            {periodReadOnly ? (
                <div className="period-lock-banner period-lock-banner-global">
                    Period is {periodStatus?.status || 'locked'} — editing is disabled
                    {periodStatus?.status === 'submitted'
                        ? '. Approve or reopen from the Period Checklist.'
                        : '. Reopen from the Period Checklist to make changes.'}
                </div>
            ) : null}

            <div className="log-controls">
                <div className="log-period-nav">
                    <div className="log-period-nav-head">
                        <span className="log-period-nav-label">Workbook period</span>
                        {periodData?.period_number != null ? (
                            <span className="log-period-active-pill">
                                Period {periodData.period_number}
                                {periodData?.is_count_period ? ' · count' : ''}
                            </span>
                        ) : null}
                    </div>
                    <div className="log-period-nav-row">
                        <button
                            type="button"
                            className="log-btn log-btn-icon"
                            disabled={!!busy || activePeriodIndex <= 0}
                            onClick={() => navigatePeriod(-1)}
                            title="Previous workbook period"
                        >
                            ‹
                        </button>
                        <div className="log-period-picker">
                            {periodChoices.length ? periodChoices.map((period) => (
                                <button
                                    key={period.period_start}
                                    type="button"
                                    className={`log-period-btn${period.period_start === periodStart ? ' active' : ''}${period.is_count_period ? ' count' : ''}`}
                                    disabled={!!busy || periodLoading}
                                    title={periodOptionLabel(period)}
                                    onClick={() => selectPeriod(period.period_start)}
                                >
                                    {periodButtonLabel(period)}
                                </button>
                            )) : (
                                <span className="log-period-empty">Import or activate a period</span>
                            )}
                        </div>
                        <button
                            type="button"
                            className="log-btn log-btn-icon"
                            disabled={!!busy || activePeriodIndex < 0 || activePeriodIndex >= periodChoices.length - 1}
                            onClick={() => navigatePeriod(1)}
                            title="Next workbook period"
                        >
                            ›
                        </button>
                    </div>
                    <label className="log-control log-control-period-menu">
                        <span>All periods</span>
                        <select
                            value={periodStart || ''}
                            disabled={!!busy || periodLoading || periodChoices.length === 0}
                            onChange={(ev) => selectPeriod(ev.target.value)}
                        >
                            {periodChoices.length === 0 ? (
                                <option value={periodStart || ''}>
                                    {periodData?.period_number != null
                                        ? `Period ${periodData.period_number}`
                                        : (periodStart || 'Loading periods…')}
                                </option>
                            ) : null}
                            {periodChoices.map((period) => (
                                <option key={period.period_start} value={period.period_start}>
                                    {periodOptionLabel(period)}
                                </option>
                            ))}
                        </select>
                    </label>
                    {periodStart && periodStart !== periodData?.operational_period_start ? (
                        <button
                            type="button"
                            className="log-btn log-btn-secondary"
                            disabled={!!busy || periodLoading}
                            onClick={() => {
                                if (window.confirm(
                                    `Set ${periodStart} as the store operational period? This changes the shared operational period for all managers.`,
                                )) setOperationalPeriod(periodStart);
                            }}
                        >
                            Set operational period
                        </button>
                    ) : (
                        <span className="log-period-active-pill">Operational period</span>
                    )}
                </div>
                {showDayNav ? (
                    <div className="log-nav-group">
                        <button type="button" className="log-btn log-btn-icon" onClick={() => navigateDay(-1)} title="Previous day">‹</button>
                        <label className="log-control">
                            <span>Receiving date</span>
                            <input
                                type="date"
                                value={storeDate}
                                min={periodStart || undefined}
                                max={periodEnd || undefined}
                                onChange={(ev) => handleReceivingDateChange(ev.target.value)}
                            />
                        </label>
                        <button type="button" className="log-btn log-btn-icon" onClick={() => navigateDay(1)} title="Next day">›</button>
                    </div>
                ) : (
                    <label className="log-control">
                        <span>Anchor date</span>
                        <input
                            type="date"
                            value={storeDate}
                            min={periodStart || undefined}
                            max={periodEnd || undefined}
                            onChange={(ev) => handleReceivingDateChange(ev.target.value)}
                        />
                    </label>
                )}
                {periodStart ? (
                    <div className="log-week-picker">
                        {[1, 2, 3, 4, 5].map((w) => (
                            <button
                                key={w}
                                type="button"
                                className={`log-week-btn${currentWeek === w ? ' active' : ''}`}
                                onClick={() => selectWeek(w)}
                            >
                                Wk {w}
                            </button>
                        ))}
                    </div>
                ) : null}
                <button type="button" className="log-btn log-btn-secondary" disabled={busy === 'export-day'} onClick={exportDailyWorkbook}>
                    Daily XLSX
                </button>
                <button type="button" className="log-btn" disabled={busy === 'export-period'} onClick={exportFullWorkbook}>
                    Full workbook
                </button>
                {activeTab === 'sheet' && !periodReadOnly ? (
                    <button type="button" className="log-btn log-btn-secondary" onClick={() => setShowImport((v) => !v)}>
                        {showImport ? 'Hide PDF import' : 'Import PDF'}
                    </button>
                ) : null}
                {!periodReadOnly ? (
                    <button type="button" className="log-btn log-btn-secondary" onClick={() => setShowWorkbookImport((v) => !v)}>
                        {showWorkbookImport ? 'Hide workbook import' : 'Import workbook'}
                    </button>
                ) : null}
            </div>

            {periodStart && showDayNav ? (
                <div className="log-day-strip">
                    {weekStrip.map((date) => {
                        const count = dayActivity[date] || 0;
                        return (
                            <button
                                key={date}
                                type="button"
                                className={`log-day-chip${storeDate === date ? ' active' : ''}${count ? ' has-data' : ''}`}
                                onClick={() => setStoreDateSafe(date)}
                            >
                                {dayLabel(date)}
                                {count ? <span className="log-day-count">{count}</span> : null}
                            </button>
                        );
                    })}
                </div>
            ) : null}

            {showImport && activeTab === 'sheet' && !periodReadOnly ? (
                <div className="log-import-wrap">
                    <LogImportPanel
                        token={token}
                        storeDate={storeDate}
                        onImported={() => { load(storeDate); schedulePeriodRefresh(); }}
                    />
                </div>
            ) : null}

            {showWorkbookImport && !periodReadOnly ? (
                <div className="log-import-wrap">
                    <LogWorkbookImportPanel token={token} onImported={handleWorkbookImported} />
                </div>
            ) : null}

            <div className="log-nav-layout">
                <nav className="log-nav-groups" aria-label="Workbook sections">
                    {LOG_NAV_GROUPS.map((group) => (
                        <button
                            key={group.id}
                            type="button"
                            className={`log-nav-group-btn${activeGroup === group.id ? ' active' : ''}`}
                            onClick={() => {
                                if (!confirmDiscardUnsaved('You have unsaved freight changes. Discard them and leave this sheet?')) {
                                    return;
                                }
                                setActiveGroup(group.id);
                                setActiveTab(group.tabs[0].id);
                            }}
                        >
                            {group.label}
                        </button>
                    ))}
                </nav>
                <div className="log-nav-subtabs">
                    {activeGroupConfig.tabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            className={`log-tab${activeTab === tab.id ? ' active' : ''}`}
                            onClick={() => {
                                if (tab.id === activeTab) return;
                                if (!confirmDiscardUnsaved('You have unsaved freight changes. Discard them and leave this sheet?')) {
                                    return;
                                }
                                setActiveTab(tab.id);
                            }}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {activeTab === 'overview' ? (
                <LogPeriodOverview
                    periodStart={periodStart}
                    periodEnd={periodEnd}
                    periodData={periodData}
                    periodStatus={periodStatus}
                    loading={periodLoading}
                    workflowBusy={workflowBusy || (closingPeriod ? 'close' : '')}
                    onGoTab={goToTab}
                    onSubmitPeriod={handleSubmitPeriod}
                    onApprovePeriod={handleApprovePeriod}
                    onClosePeriod={handleClosePeriod}
                    onReopenPeriod={handleReopenPeriod}
                />
            ) : null}

            {activeTab === 'dock-reconcile' ? (
                <LogDockReconcileSheet
                    reconciliation={periodData?.dock_reconciliation}
                    activeDate={storeDate}
                    onSelectDate={(date) => {
                        setStoreDateSafe(date);
                        goToTab('sheet');
                    }}
                />
            ) : null}

            {activeTab === 'help' ? <LogHelpGuide /> : null}

            {activeTab === 'sheet' ? (
                <>
                <LogDayIntegrityControls
                    token={token}
                    report={report}
                    periodStart={periodStart}
                    isManager={isManager}
                    readOnly={periodReadOnly}
                    duplicateGroups={(periodData?.close_readiness?.checks || [])
                        .find((check) => check.id === 'duplicate_invoices_resolved')
                        ?.duplicates?.filter((group) => group.line_ids?.some((id) =>
                            report?.lines?.some((line) => line.line_id === id),
                        )) || []}
                    onRefresh={async () => {
                        await load(storeDate);
                        await refreshPeriod();
                    }}
                />
                <LogSpreadsheetGrid
                    storeDate={storeDate}
                    sheetName={report?.sheet_name}
                    receiverName={headerDraft.receiver_name}
                    freightTotal={headerDraft.freight_total}
                    freightReconciliation={report?.freight_reconciliation}
                    rows={gridRows}
                    gridMeta={gridMeta}
                    busy={busy}
                    readOnly={periodReadOnly}
                    vendorNames={vendorNames}
                    rowWarnings={rowWarnings}
                    onReceiverChange={(value) => queueHeaderSave({ receiver_name: value })}
                    onFreightChange={(value) => queueHeaderSave({ freight_total: value })}
                    onRowChange={updateRow}
                    onRowBlur={persistRow}
                    onDeleteRow={(lineId, row) => removeLine(lineId, row)}
                    onPasteRows={handlePasteRows}
                    onAddWriteOff={addWriteOffRow}
                    onPageChange={setGridPage}
                    isManager={isManager}
                    onFreightDirtyChange={setFreightDirty}
                    onFreightSave={persistFreightRow}
                    onFreightClose={async (idx, { dirty } = {}) => {
                        if (!dirty) return true;
                        const saveFirst = window.confirm(
                            'Save freight changes before closing?\n\nOK = save\nCancel = discard unsaved freight edits',
                        );
                        if (saveFirst) {
                            return persistFreightRow(idx);
                        }
                        setFreightDirty(false);
                        await load(storeDate);
                        return true;
                    }}
                    onFreightOverride={async (reason) => {
                        try {
                            const data = await overrideFreightRecon(token, {
                                store_date: storeDate,
                                reason,
                                freight_total: headerDraft.freight_total,
                            });
                            setReport((prev) => ({ ...prev, ...data.meta }));
                            await load(storeDate);
                        } catch (e) {
                            alert(e.message);
                        }
                    }}
                />
                </>
            ) : null}

            {activeTab === 'sales' ? (
                <LogSalesSheet
                    token={token}
                    periodStart={periodStart}
                    sales={periodData?.sales}
                    busy={busy}
                    readOnly={periodReadOnly}
                    onRefresh={refreshPeriod}
                />
            ) : null}

            {activeTab === 'receiving-totals' ? (
                <>
                    <LogCostingComparisonBanner
                        comparison={periodData?.costing_comparison}
                        periodStart={periodStart}
                        token={token}
                        readOnly={periodReadOnly}
                        onConfirmMethod={confirmCostingMethod}
                        onRatesChanged={refreshPeriod}
                    />
                    <LogReceivingTotalsSheet receivingTotals={periodData?.receiving_totals} />
                </>
            ) : null}

            {activeTab === 'margin' ? (
                <>
                    <LogCostingComparisonBanner
                        comparison={periodData?.costing_comparison}
                        periodStart={periodStart}
                        token={token}
                        readOnly={periodReadOnly}
                        onConfirmMethod={confirmCostingMethod}
                        onRatesChanged={refreshPeriod}
                    />
                    <LogMarginDashboard
                        token={token}
                        periodStart={periodStart}
                        margin={periodData?.margin}
                        busy={busy}
                        readOnly={periodReadOnly}
                        onRefresh={refreshPeriod}
                    />
                </>
            ) : null}

            {activeTab === 'total-report' ? (
                <LogTotalReportSheet totalReport={periodData?.total_report} />
            ) : null}

            {activeTab === 'shrink' ? (
                <LogShrinkSheet
                    token={token}
                    storeDate={storeDate}
                    shrinkSummary={shrinkSummary}
                    shrinkLines={shrinkLines}
                    busy={busy}
                    readOnly={periodReadOnly}
                    vendorNames={vendorNames}
                    onDeleteShrink={removeShrink}
                    onAdded={() => { load(storeDate); schedulePeriodRefresh(); }}
                />
            ) : null}

            {activeTab === 'sales-data' ? (
                <LogSalesDataSheet
                    salesData={periodData?.sales_data}
                    archiving={archiving}
                    readOnly={periodReadOnly}
                    onArchive={handleArchiveSales}
                />
            ) : null}

            {activeTab === 'rebates' ? (
                <LogRebatesSheet
                    token={token}
                    periodStart={periodStart}
                    rebates={periodData?.rebates}
                    busy={busy}
                    readOnly={periodReadOnly}
                    onRefresh={refreshPeriod}
                />
            ) : null}

            {activeTab === 'recounts' ? (
                <LogRecountsSheet
                    token={token}
                    periodStart={periodStart}
                    recounts={periodData?.recounts}
                    busy={busy}
                    readOnly={periodReadOnly}
                    onRefresh={refreshPeriod}
                />
            ) : null}

            {activeTab === 'margin-ytd' ? (
                <LogMarginYtdSheet
                    marginYtd={periodData?.margin_ytd}
                    snapshotting={snapshotting}
                    readOnly={periodReadOnly}
                    onSnapshot={handleSnapshotPeriod}
                />
            ) : null}

            {activeTab === 'count-cycle' ? (
                <LogCountCycleSheet
                    token={token}
                    periodStart={periodStart}
                    countCycle={periodData?.count_cycle}
                    busy={busy}
                    readOnly={periodReadOnly}
                    onRefresh={refreshPeriod}
                />
            ) : null}

            {Object.entries(DEPT_TAB_MAP).map(([tabId, deptKey]) => (
                activeTab === tabId ? (
                    <LogDeptMarginSheet
                        key={tabId}
                        token={token}
                        periodStart={periodStart}
                        department={deptKey}
                        margin={periodData?.dept_margins?.[deptKey]}
                        busy={busy}
                        readOnly={periodReadOnly}
                        onRefresh={refreshPeriod}
                    />
                ) : null
            ))}

            <div className="log-footer">
                <Link to="/">← Back to TGP Center Store</Link>
            </div>
            </main>
        </div>
    );
}
