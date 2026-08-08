import { useCallback, useEffect, useRef, useState } from 'react';
import {
    deleteReportLine,
    fetchPeriodDashboard,
    fetchReport,
    saveReportDay,
    saveReportLine,
} from './logApi.js';
import {
    DEPT_FIELDS,
    FREIGHT_FIELDS,
    GRID_PAGE_SIZE,
    emptyLine,
    invalidAmountFields,
    isInvalidAmount,
    lineFromApi,
    parseAmount,
    rebuildPage,
    rowHasData,
} from './logUtils.js';

function countDayLines(rows) {
    return rows.filter(rowHasData).length;
}

function warningKey(row, pageIdx) {
    return row?.line_id || pageIdx;
}

/**
 * Day/period load + save for the Financial Log.
 * Isolated from LogApp UI so date races and blur-save rules live in one place.
 */
export function useLogPersistence({ token, storeDate }) {
    const [report, setReport] = useState(null);
    const [periodData, setPeriodData] = useState(null);
    const [periodLoading, setPeriodLoading] = useState(false);
    const [gridRows, setGridRows] = useState(() => rebuildPage().rows);
    const [gridMeta, setGridMeta] = useState(() => rebuildPage().meta);
    const [gridPage, setGridPage] = useState(0);
    const [allDayLines, setAllDayLines] = useState([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState('');
    const [saveState, setSaveState] = useState('idle');
    const [rowWarnings, setRowWarnings] = useState({});
    const [hasUnsavedFreight, setHasUnsavedFreight] = useState(false);
    const [headerDraft, setHeaderDraft] = useState({
        receiver_name: '',
        freight_total: '',
        period_start: '',
    });

    const headerTimerRef = useRef(null);
    const periodRefreshTimerRef = useRef(null);
    const gridRowsRef = useRef(gridRows);
    gridRowsRef.current = gridRows;
    const gridMetaRef = useRef(gridMeta);
    gridMetaRef.current = gridMeta;
    const allDayLinesRef = useRef(allDayLines);
    allDayLinesRef.current = allDayLines;
    const freightDirtyRef = useRef(false);
    const storeDateRef = useRef(storeDate);
    storeDateRef.current = storeDate;
    const loadSeqRef = useRef(0);
    const periodSeqRef = useRef(0);
    const pendingHeaderSaveRef = useRef(null);

    const periodStatus = periodData?.period_status || null;
    const periodReadOnly = ['submitted', 'approved', 'locked'].includes(periodStatus?.status);
    const periodReadOnlyRef = useRef(periodReadOnly);
    periodReadOnlyRef.current = periodReadOnly;

    const applyPage = useCallback((lines, page) => {
        const { rows, meta } = rebuildPage(lines, page);
        setGridRows(rows);
        setGridMeta(meta);
        setGridPage(meta.page);
        gridRowsRef.current = rows;
        gridMetaRef.current = meta;
        return { rows, meta };
    }, []);

    const setFreightDirty = useCallback((dirty) => {
        freightDirtyRef.current = !!dirty;
        setHasUnsavedFreight(!!dirty);
    }, []);

    const confirmDiscardUnsaved = useCallback((message) => {
        if (!freightDirtyRef.current) return true;
        const ok = window.confirm(
            message || 'You have unsaved freight changes. Discard them and continue?',
        );
        if (ok) setFreightDirty(false);
        return ok;
    }, [setFreightDirty]);

    const load = useCallback(async (date) => {
        if (!token || !date) return;
        if (!confirmDiscardUnsaved('You have unsaved freight changes. Discard them and reload?')) {
            return;
        }
        const seq = ++loadSeqRef.current;
        try {
            const payload = await fetchReport(token, date);
            if (seq !== loadSeqRef.current) return;
            setReport(payload.report);
            const lines = payload.report.lines || [];
            setAllDayLines(lines);
            allDayLinesRef.current = lines;
            applyPage(lines, 0);
            setRowWarnings(payload.report.line_warnings || {});
            setFreightDirty(false);
            setHeaderDraft((prev) => ({
                receiver_name: payload.report.receiver_name || '',
                freight_total: payload.report.freight_total ?? '',
                period_start: payload.report.period_start || prev.period_start,
            }));
            setError('');
        } catch (e) {
            if (seq !== loadSeqRef.current) return;
            setError(e.message || 'Could not load report');
        }
    }, [token, applyPage, confirmDiscardUnsaved, setFreightDirty]);

    const setGridPageSafe = useCallback((nextPage) => {
        if (!confirmDiscardUnsaved('You have unsaved freight changes. Discard them and change page?')) {
            return;
        }
        applyPage(allDayLinesRef.current, nextPage);
    }, [applyPage, confirmDiscardUnsaved]);

    const loadPeriod = useCallback(async (date, { silent = false, periodStart = '' } = {}) => {
        if (!token || !date) return;
        const seq = ++periodSeqRef.current;
        if (!silent) setPeriodLoading(true);
        try {
            const payload = await fetchPeriodDashboard(token, date, periodStart);
            if (seq !== periodSeqRef.current) return;
            setPeriodData(payload);
            if (payload.period_start && !periodStart) {
                setHeaderDraft((prev) => ({
                    ...prev,
                    period_start: payload.period_start,
                }));
            }
        } catch (e) {
            if (seq === periodSeqRef.current && !silent) {
                setError(e.message || 'Could not load period dashboard');
            }
        } finally {
            if (seq === periodSeqRef.current && !silent) setPeriodLoading(false);
        }
    }, [token]);

    const schedulePeriodRefresh = useCallback(() => {
        if (periodRefreshTimerRef.current) clearTimeout(periodRefreshTimerRef.current);
        periodRefreshTimerRef.current = setTimeout(() => {
            if (storeDateRef.current) loadPeriod(storeDateRef.current, { silent: true });
        }, 2500);
    }, [loadPeriod]);

    const bumpDayActivity = useCallback((date, lineCount) => {
        setPeriodData((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                day_activity: {
                    ...prev.day_activity,
                    [date]: lineCount,
                },
            };
        });
    }, []);

    const flushHeaderSave = useCallback(() => {
        if (headerTimerRef.current) {
            clearTimeout(headerTimerRef.current);
            headerTimerRef.current = null;
        }
        const commit = pendingHeaderSaveRef.current;
        if (commit) return commit();
        return undefined;
    }, []);

    const queueHeaderSave = useCallback((patch) => {
        if (periodReadOnlyRef.current) return;
        // Period switching uses selectPeriod / activate — do not save period_start from day meta.
        const { period_start: _ignoredPeriodStart, ...safePatch } = patch;
        setHeaderDraft((prev) => {
            const next = { ...prev, ...safePatch };
            const savedForDate = storeDateRef.current;

            const commit = async () => {
                pendingHeaderSaveRef.current = null;
                if (isInvalidAmount(next.freight_total)) {
                    setSaveState('error');
                    alert('Not a number: Freight — header not saved');
                    return;
                }
                setSaveState('saving');
                try {
                    const data = await saveReportDay(token, {
                        store_date: savedForDate,
                        receiver_name: next.receiver_name,
                        freight_total: next.freight_total === '' ? null : parseAmount(next.freight_total),
                    });
                    if (storeDateRef.current !== savedForDate) return;
                    setReport((prevReport) => ({ ...prevReport, ...data.meta }));
                    setSaveState('saved');
                    setTimeout(() => setSaveState('idle'), 2000);
                } catch (e) {
                    setSaveState('error');
                    alert(e.message);
                }
            };

            if (headerTimerRef.current) clearTimeout(headerTimerRef.current);
            pendingHeaderSaveRef.current = commit;
            headerTimerRef.current = setTimeout(commit, 600);
            return next;
        });
    }, [token]);

    const updateRow = useCallback((idx, patch) => {
        setGridRows((rows) => rows.map((row, i) => (i === idx ? { ...row, ...patch } : row)));
        const page = gridMetaRef.current?.page || 0;
        const pageSize = gridMetaRef.current?.pageSize || GRID_PAGE_SIZE;
        const abs = page * pageSize + idx;
        setAllDayLines((all) => {
            const nextAll = all.length ? [...all] : [];
            while (nextAll.length <= abs) nextAll.push(emptyLine());
            nextAll[abs] = { ...(nextAll[abs] || emptyLine()), ...patch };
            allDayLinesRef.current = nextAll;
            return nextAll;
        });
    }, []);

    const persistRow = useCallback(async (idx) => {
        const current = gridRowsRef.current[idx];
        if (!current || periodReadOnlyRef.current) return false;
        const savedForDate = storeDateRef.current;
        const sameDay = () => storeDateRef.current === savedForDate;
        const page = gridMetaRef.current?.page || 0;
        const pageSize = gridMetaRef.current?.pageSize || GRID_PAGE_SIZE;
        const abs = page * pageSize + idx;

        const badFields = invalidAmountFields(current);
        if (badFields.length) {
            setRowWarnings((prev) => ({
                ...prev,
                [warningKey(current, idx)]: [{ message: `Not a number: ${badFields.join(', ')} — row not saved` }],
            }));
            setSaveState('idle');
            return false;
        }

        setSaveState('saving');

        if (!rowHasData(current)) {
            if (current.line_id) {
                setBusy(current.line_id);
                try {
                    await deleteReportLine(token, current.line_id);
                    if (sameDay()) {
                        const nextAll = allDayLinesRef.current.filter((row) => row.line_id !== current.line_id);
                        setAllDayLines(nextAll);
                        allDayLinesRef.current = nextAll;
                        applyPage(nextAll, page);
                        bumpDayActivity(savedForDate, countDayLines(nextAll));
                        setRowWarnings((prev) => {
                            const next = { ...prev };
                            delete next[current.line_id];
                            delete next[idx];
                            return next;
                        });
                    }
                    schedulePeriodRefresh();
                    setSaveState('saved');
                    setTimeout(() => setSaveState('idle'), 2000);
                    return true;
                } catch (e) {
                    setSaveState('error');
                    alert(e.message);
                    return false;
                } finally {
                    setBusy('');
                }
            }
            setSaveState('idle');
            return true;
        }

        setBusy(current.line_id || `row-${idx}`);
        try {
            const payload = {
                store_date: savedForDate,
                line_id: current.line_id || undefined,
                line_kind: current.line_kind || 'invoice',
                invoice_number: current.invoice_number,
                supplier_name: current.supplier_name,
                notes: current.notes,
            };
            DEPT_FIELDS.forEach((field) => {
                payload[field.key] = parseAmount(current[field.key]);
            });
            FREIGHT_FIELDS.forEach((field) => {
                payload[field.key] = parseAmount(current[field.key]);
            });
            const hasNegativeFreight = FREIGHT_FIELDS.some((field) => Number(payload[field.key] || 0) < 0);
            if (hasNegativeFreight) {
                const reason = window.prompt('Manager freight-credit reason is required for negative freight:');
                if (!reason?.trim()) {
                    setSaveState('idle');
                    return false;
                }
                payload.negative_freight_reason = reason.trim();
            }
            const result = await saveReportLine(token, payload);
            if (sameDay()) {
                const updated = lineFromApi(result.line);
                const nextAll = [...allDayLinesRef.current];
                while (nextAll.length <= abs) nextAll.push(emptyLine());
                if (current.line_id) {
                    const found = nextAll.findIndex((row) => row.line_id === current.line_id);
                    if (found >= 0) nextAll[found] = updated;
                    else nextAll[abs] = updated;
                } else {
                    nextAll[abs] = updated;
                }
                setAllDayLines(nextAll);
                allDayLinesRef.current = nextAll;
                applyPage(nextAll, page);
                bumpDayActivity(savedForDate, countDayLines(nextAll));
                setRowWarnings((prev) => {
                    const next = { ...prev };
                    delete next[idx];
                    if (current.line_id && current.line_id !== updated.line_id) {
                        delete next[current.line_id];
                    }
                    next[warningKey(updated, idx)] = result.warnings || [];
                    return next;
                });
            }
            schedulePeriodRefresh();
            setSaveState('saved');
            setTimeout(() => setSaveState('idle'), 2000);
            return true;
        } catch (e) {
            setSaveState('error');
            alert(e.message);
            return false;
        } finally {
            setBusy('');
        }
    }, [token, bumpDayActivity, schedulePeriodRefresh, applyPage]);

    /** Explicit freight modal save — same payload rules as persistRow; returns success boolean. */
    const persistFreightRow = useCallback(async (idx) => {
        const ok = await persistRow(idx);
        if (ok) setFreightDirty(false);
        return ok;
    }, [persistRow, setFreightDirty]);

    const handlePasteRows = useCallback(async (startIdx, patches) => {
        if (!patches?.length || periodReadOnlyRef.current) return;

        const pageSize = gridMetaRef.current?.pageSize || GRID_PAGE_SIZE;
        const page = gridMetaRef.current?.page || 0;
        const capacity = Math.max(0, pageSize - startIdx);
        const overflow = patches.length - capacity;

        if (overflow > 0) {
            const continueOk = window.confirm(
                `This paste has ${patches.length} rows; only ${capacity} fit on the current page.\n\n`
                + `${overflow} row${overflow === 1 ? '' : 's'} would continue onto the next page.\n\n`
                + 'OK = continue onto the next page\n'
                + 'Cancel = leave the sheet unchanged (nothing discarded silently)',
            );
            if (!continueOk) {
                alert(
                    `Paste cancelled — ${overflow} row${overflow === 1 ? '' : 's'} would have been discarded.\n`
                    + 'Nothing was pasted.',
                );
                return;
            }
        }

        const absStart = page * pageSize + startIdx;
        const nextAll = [...allDayLinesRef.current];
        while (nextAll.length < absStart + patches.length) nextAll.push(emptyLine());
        patches.forEach((patch, offset) => {
            const i = absStart + offset;
            nextAll[i] = { ...(nextAll[i] || emptyLine()), ...patch };
        });
        setAllDayLines(nextAll);
        allDayLinesRef.current = nextAll;
        applyPage(nextAll, page);

        setTimeout(async () => {
            for (let offset = 0; offset < patches.length; offset += 1) {
                const abs = absStart + offset;
                const targetPage = Math.floor(abs / pageSize);
                const idxOnPage = abs % pageSize;
                if (gridMetaRef.current?.page !== targetPage) {
                    applyPage(allDayLinesRef.current, targetPage);
                }
                await persistRow(idxOnPage);
            }
            applyPage(allDayLinesRef.current, page);
        }, 0);
    }, [persistRow, applyPage]);

    const removeLine = useCallback(async (lineId, confirmOrRow) => {
        if (periodReadOnlyRef.current) return;
        if (!lineId) return;

        let confirmLabel = 'Delete this row?';
        if (typeof confirmOrRow === 'string' && confirmOrRow.trim()) {
            confirmLabel = confirmOrRow;
        } else if (confirmOrRow && typeof confirmOrRow === 'object') {
            const inv = confirmOrRow.invoice_number || '—';
            const sup = confirmOrRow.supplier_name || '—';
            confirmLabel = `Delete invoice ${inv} (${sup})?`;
        }
        if (!window.confirm(confirmLabel)) return;

        setBusy(lineId);
        setSaveState('saving');
        try {
            await deleteReportLine(token, lineId);
            const nextAll = allDayLinesRef.current.filter((row) => row.line_id !== lineId);
            setAllDayLines(nextAll);
            allDayLinesRef.current = nextAll;
            applyPage(nextAll, gridMetaRef.current?.page || 0);
            bumpDayActivity(storeDateRef.current, countDayLines(nextAll));
            setRowWarnings((prev) => {
                const next = { ...prev };
                delete next[lineId];
                return next;
            });
            schedulePeriodRefresh();
            setSaveState('saved');
            setTimeout(() => setSaveState('idle'), 2000);
        } catch (e) {
            setSaveState('error');
            alert(e.message);
        } finally {
            setBusy('');
        }
    }, [token, bumpDayActivity, schedulePeriodRefresh, applyPage]);

    const removeRowByIndex = useCallback(async (idx) => {
        const row = gridRowsRef.current[idx];
        if (!row?.line_id) return;
        await removeLine(row.line_id, row);
    }, [removeLine]);

    useEffect(() => () => { flushHeaderSave(); }, [storeDate, flushHeaderSave]);

    useEffect(() => {
        const onLeave = () => { flushHeaderSave(); };
        const onHide = () => { if (document.visibilityState === 'hidden') onLeave(); };
        window.addEventListener('pagehide', onLeave);
        document.addEventListener('visibilitychange', onHide);
        return () => {
            window.removeEventListener('pagehide', onLeave);
            document.removeEventListener('visibilitychange', onHide);
        };
    }, [flushHeaderSave]);

    useEffect(() => () => {
        if (periodRefreshTimerRef.current) clearTimeout(periodRefreshTimerRef.current);
    }, []);

    return {
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
        gridPage,
        setGridPage: setGridPageSafe,
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
        bumpDayActivity,
        queueHeaderSave,
        flushHeaderSave,
        updateRow,
        persistRow,
        persistFreightRow,
        handlePasteRows,
        removeLine,
        removeRowByIndex,
        hasUnsavedFreight,
        freightDirty: hasUnsavedFreight,
        setFreightDirty,
        confirmDiscardUnsaved,
    };
}
