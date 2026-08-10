import { useCallback, useMemo, useRef, useState } from 'react';
import {
    activatePeriod,
    approvePeriod,
    archiveSalesHistory,
    closePeriod,
    fetchPeriodDashboard,
    reopenPeriod,
    snapshotPeriod,
    submitPeriod,
} from './logApi.js';
import {
    addDays,
    clampToPeriod,
    weekDates,
    weekNumberForDate,
} from './logPeriodUtils.js';
import { formatShortDate } from './logAnalyticsUtils.js';

const DAILY_TABS = new Set(['sheet', 'shrink']);

export function periodOptionLabel(period) {
    const num = period?.period_number;
    const start = period?.period_start ? formatShortDate(period.period_start) : '—';
    const end = period?.period_end ? formatShortDate(period.period_end) : '';
    const countTag = period?.is_count_period ? ' · count' : '';
    if (num != null) return `Period ${num} · ${start}${end ? ` → ${end}` : ''}${countTag}`;
    return `${start}${end ? ` → ${end}` : ''}${countTag}`;
}

export function periodButtonLabel(period) {
    if (period?.period_number != null) {
        return period.is_count_period ? `P${period.period_number}*` : `P${period.period_number}`;
    }
    if (!period?.period_start) return '—';
    const dt = new Date(`${period.period_start}T12:00:00`);
    return dt.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
}

/**
 * Period navigation + submit/approve/close/reopen workflow for the Financial Log.
 * Keeps LogApp focused on chrome and sheet routing.
 */
export function useLogPeriodWorkflow({
    token,
    storeDate,
    setStoreDate,
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
}) {
    const [archiving, setArchiving] = useState(false);
    const [snapshotting, setSnapshotting] = useState(false);
    const [closingPeriod, setClosingPeriod] = useState(false);
    const [workflowBusy, setWorkflowBusy] = useState('');
    const selectSeqRef = useRef(0);

    const periodStart = headerDraft.period_start || report?.period_start || periodData?.period_start || '';
    const periodEnd = periodData?.period_end || (periodStart ? addDays(periodStart, 34) : '');

    const availablePeriods = periodData?.available_periods || [];

    const periodChoices = useMemo(() => {
        const list = [...availablePeriods];
        if (periodStart && !list.some((p) => p.period_start === periodStart)) {
            list.push({
                period_start: periodStart,
                period_end: periodEnd,
                period_number: periodData?.period_number ?? null,
                is_count_period: !!periodData?.is_count_period,
            });
        }
        return list.sort((a, b) => {
            if (a.period_number != null && b.period_number != null) {
                return a.period_number - b.period_number;
            }
            if (a.period_number != null) return -1;
            if (b.period_number != null) return 1;
            return String(a.period_start).localeCompare(String(b.period_start));
        });
    }, [
        availablePeriods,
        periodStart,
        periodEnd,
        periodData?.period_number,
        periodData?.is_count_period,
    ]);

    const activePeriodIndex = periodChoices.findIndex((p) => p.period_start === periodStart);

    const selectPeriod = useCallback(async (nextStart, keepDate = null, { setOperational = false } = {}) => {
        if (!token || !nextStart) return;
        const seq = ++selectSeqRef.current;
        setBusy('period');
        try {
            let payload;
            if (setOperational) {
                payload = await activatePeriod(token, { period_start: nextStart });
            } else {
                // Session/view only — do not mutate Receiving_Report_Period_Start.
                payload = await fetchPeriodDashboard(token, keepDate || nextStart, nextStart);
            }
            if (seq !== selectSeqRef.current) return;
            setPeriodData(payload);
            const end = payload.period_end || addDays(nextStart, 34);
            const nextDate = keepDate && keepDate >= nextStart && keepDate <= end
                ? keepDate
                : nextStart;
            setStoreDate(nextDate);
            setHeaderDraft((prev) => ({
                ...prev,
                period_start: nextStart,
            }));
            if (DAILY_TABS.has(activeTab) || activeTab === 'total-report') {
                await load(nextDate);
            }
            if (seq !== selectSeqRef.current) return;
            setError('');
        } catch (e) {
            if (seq !== selectSeqRef.current) return;
            alert(e.message || 'Could not switch period.');
        } finally {
            if (seq === selectSeqRef.current) setBusy('');
        }
    }, [token, setBusy, setPeriodData, setStoreDate, setHeaderDraft, activeTab, load, setError]);

    const setOperationalPeriod = useCallback(async (nextStart) => {
        await selectPeriod(nextStart, null, { setOperational: true });
    }, [selectPeriod]);

    const navigatePeriod = useCallback((delta) => {
        if (!periodChoices.length) return;
        const idx = activePeriodIndex >= 0 ? activePeriodIndex : 0;
        const next = periodChoices[idx + delta];
        if (next) selectPeriod(next.period_start);
    }, [periodChoices, activePeriodIndex, selectPeriod]);

    const handleReceivingDateChange = useCallback(async (date) => {
        if (!date) return;
        const match = periodChoices.find(
            (p) => date >= p.period_start && date <= (p.period_end || addDays(p.period_start, 34)),
        );
        if (match && match.period_start !== periodStart) {
            await selectPeriod(match.period_start, date);
            return;
        }
        setStoreDate(clampToPeriod(date, periodStart, periodEnd));
    }, [periodChoices, periodStart, periodEnd, selectPeriod, setStoreDate]);

    const navigateDay = useCallback((delta) => {
        const next = clampToPeriod(addDays(storeDate, delta), periodStart, periodEnd);
        setStoreDate(next);
    }, [storeDate, periodStart, periodEnd, setStoreDate]);

    const selectWeek = useCallback((weekNum) => {
        const dates = weekDates(periodStart, weekNum);
        if (!dates.length) return;
        const inWeek = dates.includes(storeDate) ? storeDate : dates[0];
        setStoreDate(clampToPeriod(inWeek, periodStart, periodEnd));
    }, [periodStart, storeDate, periodEnd, setStoreDate]);

    const handleWorkbookImported = useCallback(async (summary) => {
        if (summary?.period_start) {
            await selectPeriod(summary.period_start);
            return;
        }
        await load(storeDate);
        await loadPeriod(storeDate);
    }, [selectPeriod, load, loadPeriod, storeDate]);

    const refreshPeriod = useCallback(() => loadPeriod(storeDate), [loadPeriod, storeDate]);

    const handleArchiveSales = useCallback(async () => {
        if (!periodStart) return;
        setArchiving(true);
        try {
            await archiveSalesHistory(token, periodStart);
            await loadPeriod(storeDate);
        } catch (e) {
            alert(e.message);
        } finally {
            setArchiving(false);
        }
    }, [periodStart, token, loadPeriod, storeDate]);

    const handleSnapshotPeriod = useCallback(async () => {
        if (!periodStart) return;
        setSnapshotting(true);
        try {
            await snapshotPeriod(token, periodStart);
            await loadPeriod(storeDate);
        } catch (e) {
            alert(e.message);
        } finally {
            setSnapshotting(false);
        }
    }, [periodStart, token, loadPeriod, storeDate]);

    const handleClosePeriod = useCallback(async () => {
        if (!window.confirm('Close and lock this period? This archives sales, snapshots margin YTD, and prevents further edits. Export the workbook separately if you need a copy.')) {
            return;
        }
        setClosingPeriod(true);
        setWorkflowBusy('close');
        try {
            await closePeriod(token, periodStart);
            await loadPeriod(storeDate);
        } catch (e) {
            alert(e.message);
        } finally {
            setClosingPeriod(false);
            setWorkflowBusy('');
        }
    }, [token, periodStart, loadPeriod, storeDate]);

    const handleSubmitPeriod = useCallback(async () => {
        setWorkflowBusy('submit');
        try {
            const result = await submitPeriod(token, periodStart);
            setPeriodData((prev) => (prev ? { ...prev, period_status: result.period_status } : prev));
        } catch (e) {
            alert(e.message);
        } finally {
            setWorkflowBusy('');
        }
    }, [token, periodStart, setPeriodData]);

    const handleApprovePeriod = useCallback(async () => {
        setWorkflowBusy('approve');
        try {
            const result = await approvePeriod(token, periodStart);
            setPeriodData((prev) => (prev ? { ...prev, period_status: result.period_status } : prev));
        } catch (e) {
            alert(e.message);
        } finally {
            setWorkflowBusy('');
        }
    }, [token, periodStart, setPeriodData]);

    const handleReopenPeriod = useCallback(async () => {
        const isSubmitted = periodStatus?.status === 'submitted';
        const note = window.prompt(
            isSubmitted
                ? 'Reason for withdrawing submission (required, audited):'
                : 'Reason for reopening this period (required, audited):',
        );
        if (!note?.trim()) return;
        setWorkflowBusy('reopen');
        try {
            const result = await reopenPeriod(token, periodStart, note.trim());
            setPeriodData((prev) => (prev ? { ...prev, period_status: result.period_status } : prev));
        } catch (e) {
            alert(e.message);
        } finally {
            setWorkflowBusy('');
        }
    }, [periodStatus?.status, token, periodStart, setPeriodData]);

    const sheetHint = useMemo(() => {
        const periodNum = periodData?.period_number;
        const periodLabel = periodNum != null ? `Period ${periodNum}` : '';
        if (!report?.sheet_name) {
            return periodLabel
                ? `${periodLabel} · starts ${formatShortDate(periodStart)}`
                : '';
        }
        return `${report.sheet_name}${periodLabel ? ` · ${periodLabel}` : ''} · starts ${formatShortDate(periodStart || report.period_start)}`;
    }, [report, periodData?.period_number, periodStart]);

    const currentWeek = weekNumberForDate(periodStart, storeDate);
    const weekStrip = weekDates(periodStart, currentWeek);
    const dayActivity = periodData?.day_activity || {};
    const showDayNav = DAILY_TABS.has(activeTab) || activeTab === 'overview';

    return {
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
    };
}
