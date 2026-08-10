import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchJson, formatApiError } from '../../lib/api.js';
import { createReportsApi } from '../lib/reportsApi.js';

const REFRESH_SECONDS = 300;
const EMPTY_META = Object.freeze({});

function loadBackups(token, activeBackup, setBackups, setBackupError) {
    fetchJson('/api/backups', { headers: { 'x-session-token': token } })
        .then((d) => {
            setBackups(d.backups || []);
            setBackupError('');
        })
        .catch((e) => setBackupError(e.message || 'Could not load backups'));
}

export default function useReportsData(token) {
    const [reportData, setReportData] = useState(null);
    const [reportMode, setReportModeState] = useState(
        () => sessionStorage.getItem('tgp_report_mode') || 'today',
    );
    const [viewStart, setViewStart] = useState('');
    const [viewEnd, setViewEnd] = useState('');
    const [activeBackup, setActiveBackup] = useState('');
    const [backups, setBackups] = useState([]);
    const [backupError, setBackupError] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [countdown, setCountdown] = useState(REFRESH_SECONDS);

    const viewStartRef = useRef(viewStart);
    const viewEndRef = useRef(viewEnd);
    const reportModeRef = useRef(reportMode);
    viewStartRef.current = viewStart;
    viewEndRef.current = viewEnd;
    reportModeRef.current = reportMode;

    const setReportMode = useCallback((mode) => {
        setReportModeState(mode);
        sessionStorage.setItem('tgp_report_mode', mode);
    }, []);

    const loadReports = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError('');
        setCountdown(REFRESH_SECONDS);
        const start = viewStartRef.current;
        const end = viewEndRef.current;
        const mode = reportModeRef.current;
        try {
            const q = [];
            if (activeBackup) q.push(`backup=${encodeURIComponent(activeBackup)}`);
            if (
                start && end
                && /^\d{4}-\d{2}-\d{2}$/.test(start)
                && /^\d{4}-\d{2}-\d{2}$/.test(end)
            ) {
                q.push(`start=${encodeURIComponent(start)}`);
                q.push(`end=${encodeURIComponent(end)}`);
            }
            const url = `/api/reports${q.length ? `?${q.join('&')}` : ''}`;
            const d = await fetchJson(url, { headers: { 'x-session-token': token } });
            if (d.meta?.reportStart) {
                viewStartRef.current = d.meta.reportStart;
                setViewStart(d.meta.reportStart);
            }
            if (d.meta?.reportEnd) {
                viewEndRef.current = d.meta.reportEnd;
                setViewEnd(d.meta.reportEnd);
            }
            if (
                d.meta?.isLiveToday === false
                && mode === 'today'
                && !sessionStorage.getItem('tgp_report_mode')
            ) {
                setReportMode('handoff');
            }
            setReportData(d);
        } catch (e) {
            // Fail closed for historical backups: never keep prior live data under a BACKUP selection.
            if (activeBackup) setReportData(null);
            setError(formatApiError(e, e.message || 'Failed to load reports'));
        } finally {
            setLoading(false);
        }
    }, [token, activeBackup, setReportMode]);

    const applyViewDate = useCallback((nextStart, nextEnd) => {
        const start = nextStart?.trim() || '';
        const end = nextEnd?.trim() || '';
        viewStartRef.current = start;
        viewEndRef.current = end;
        setViewStart(start);
        setViewEnd(end);
        loadReports();
    }, [loadReports]);

    useEffect(() => {
        loadReports();
        loadBackups(token, activeBackup, setBackups, setBackupError);
    }, [loadReports, token, activeBackup]);

    useEffect(() => {
        const id = setInterval(() => {
            setCountdown((c) => {
                if (c <= 1) {
                    loadReports();
                    return REFRESH_SECONDS;
                }
                return c - 1;
            });
        }, 1000);
        return () => clearInterval(id);
    }, [loadReports]);

    const reportMeta = reportData?.meta || EMPTY_META;
    const api = useMemo(
        () => createReportsApi(token, reportMeta),
        [token, reportMeta],
    );

    const reload = useCallback(async () => {
        await loadReports();
    }, [loadReports]);

    const runAction = useCallback(async (fn) => {
        try {
            await fn();
            await loadReports();
        } catch (e) {
            alert(e.message);
        }
    }, [loadReports]);

    return {
        reportData,
        reportMode,
        setReportMode,
        viewStart,
        viewEnd,
        setViewStart,
        setViewEnd,
        applyViewDate,
        activeBackup,
        setActiveBackup,
        backups,
        backupError,
        loading,
        error,
        countdown,
        loadReports,
        reload,
        api,
        runAction,
        reportMeta,
    };
}

export { REFRESH_SECONDS };
