import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJson, formatApiError } from '../../lib/api.js';
import { createReportsApi } from '../lib/reportsApi.js';

const REFRESH_SECONDS = 300;

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

    const setReportMode = useCallback((mode) => {
        setReportModeState(mode);
        sessionStorage.setItem('tgp_report_mode', mode);
    }, []);

    const loadReports = useCallback(async () => {
        if (!token) return;
        setLoading(true);
        setError('');
        setCountdown(REFRESH_SECONDS);
        try {
            const q = [];
            if (activeBackup) q.push(`backup=${encodeURIComponent(activeBackup)}`);
            if (
                viewStart && viewEnd
                && /^\d{4}-\d{2}-\d{2}$/.test(viewStart)
                && /^\d{4}-\d{2}-\d{2}$/.test(viewEnd)
            ) {
                q.push(`start=${encodeURIComponent(viewStart)}`);
                q.push(`end=${encodeURIComponent(viewEnd)}`);
            }
            const url = `/api/reports${q.length ? `?${q.join('&')}` : ''}`;
            const d = await fetchJson(url, { headers: { 'x-session-token': token } });
            if (d.meta?.reportStart) setViewStart(d.meta.reportStart);
            if (d.meta?.reportEnd) setViewEnd(d.meta.reportEnd);
            if (
                d.meta?.isLiveToday === false
                && reportMode === 'today'
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
    }, [token, activeBackup, viewStart, viewEnd, reportMode, setReportMode]);

    const applyViewDate = useCallback((nextStart, nextEnd) => {
        setViewStart(nextStart?.trim() || '');
        setViewEnd(nextEnd?.trim() || '');
    }, []);

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

    const reportMeta = reportData?.meta || {};
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
