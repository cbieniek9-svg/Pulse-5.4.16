import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { ReportsContext } from './context/ReportsContext.jsx';
import useReportsData from './hooks/useReportsData.js';
import ExecStrip from './components/ExecStrip.jsx';
import ReportModeTabs from './components/ReportModeTabs.jsx';
import ReportSectionNav from './components/ReportSectionNav.jsx';
import ReportFooter from './components/ReportFooter.jsx';
import PrintSectionPicker, { printHandoffPreset } from './components/PrintSectionPicker.jsx';
import TodayPanel from './sections/TodayPanel.jsx';
import LearnPanel from './sections/LearnPanel.jsx';
import HandoffPanel from './sections/HandoffPanel.jsx';
import '../styles/reports.css';

export default function ReportsApp() {
    const { token, user, logout } = useAuth();
    const reports = useReportsData(token);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [printOpen, setPrintOpen] = useState(false);
    const hdrRef = useRef(null);

    const {
        reportData,
        reportMode,
        setReportMode,
        viewStart,
        viewEnd,
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
    } = reports;

    const setModeAndScroll = useMemo(() => (
        (mode) => {
            setReportMode(mode);
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    ), [setReportMode]);

    const contextValue = useMemo(() => ({
        reportMode,
        setReportMode: setModeAndScroll,
        viewStart,
        viewEnd,
        applyViewDate,
        reload,
        api,
        runAction,
        reportMeta,
    }), [reportMode, setModeAndScroll, viewStart, viewEnd, applyViewDate, reload, api, runAction, reportMeta]);

    useLayoutEffect(() => {
        const root = document.querySelector('.reports-portal');
        const hdr = hdrRef.current;
        if (!root || !hdr) return undefined;
        const apply = () => {
            root.style.setProperty('--reports-hdr-h', `${Math.ceil(hdr.getBoundingClientRect().height)}px`);
        };
        apply();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null;
        ro?.observe(hdr);
        window.addEventListener('resize', apply);
        return () => {
            ro?.disconnect();
            window.removeEventListener('resize', apply);
        };
    }, [historyOpen, loading, reportData]);

    useEffect(() => {
        // Keep section anchors clear of sticky tools (hdr + tools stack).
        const root = document.querySelector('.reports-portal');
        if (!root) return;
        const tools = root.querySelector('.reports-sticky-tools');
        const toolsH = tools ? Math.ceil(tools.getBoundingClientRect().height) : 0;
        const hdrH = Number.parseFloat(getComputedStyle(root).getPropertyValue('--reports-hdr-h')) || 72;
        root.style.setProperty('--reports-sticky-offset', `${hdrH + toolsH + 8}px`);
    }, [reportMode, reportData, loading, historyOpen]);

    const headerDate = useMemo(() => {
        if (!reportData) return 'LOADING…';
        const m = reportData.meta || {};
        const rd = m.reportDate || reportData.today;
        const rs = m.reportStart || rd;
        const re = m.reportEnd || rd;
        const rangeLabel = rs === re ? rs : `${rs} → ${re}`;
        return `REPORT: ${rangeLabel}  |  LIVE STORE: ${m.liveStoreDate || rd}  |  GENERATED: ${new Date(reportData.generated).toLocaleTimeString()}${m.reportSource === 'backup' ? '  |  BACKUP' : ''}`;
    }, [reportData]);

    const handleLogout = () => {
        logout();
        window.location.reload();
    };

    return (
        <ReportsContext.Provider value={contextValue}>
            <div className="reports-portal">
                <header className="hdr" ref={hdrRef}>
                    <div>
                        <div className="hdr-title">TGP REPORTS</div>
                        <div className="hdr-sub" id="hdr-date">{headerDate}</div>
                    </div>
                    <div className="hdr-right">
                        <span className="hdr-user">{user}</span>
                        <button type="button" className="btn" onClick={() => setHistoryOpen((v) => !v)}>HISTORY</button>
                        <button type="button" className="btn" onClick={() => setPrintOpen(true)}>PRINT</button>
                        <button type="button" className="btn warn" onClick={printHandoffPreset}>HANDOFF</button>
                        <button type="button" className="btn warn" onClick={loadReports}>REFRESH</button>
                        <Link to="/" className="btn ok" style={{ textDecoration: 'none' }}>← FLOOR</Link>
                        <button type="button" className="btn danger" onClick={handleLogout}>LOGOUT</button>
                        <span id="refresh-countdown" className="hdr-countdown">
                            AUTO {countdown}s
                        </span>
                    </div>
                </header>

                {historyOpen ? (
                    <div id="history-selector" className="page history-selector" style={{ display: 'block', paddingBottom: 0 }}>
                        <div className="section-title">BACKUP / HISTORICAL DB</div>
                        {backupError ? <div style={{ color: '#f44', fontSize: '0.85em' }}>{backupError}</div> : null}
                        {error && activeBackup ? (
                            <div style={{ color: '#f44', fontSize: '0.85em', marginBottom: 8 }}>
                                {error}
                                {' '}
                                Reports stay on this error — live data is not shown under a BACKUP selection.
                            </div>
                        ) : null}
                        <div id="backup-list" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                            <button type="button" className={`btn ${!activeBackup ? 'ok' : ''}`} onClick={() => setActiveBackup('')}>CURRENT LIVE DB</button>
                            {backups.map((f) => (
                                <button
                                    key={f}
                                    type="button"
                                    className={`btn ${activeBackup === f ? 'ok' : ''}`}
                                    onClick={() => setActiveBackup(f)}
                                >
                                    {f.replace('tgp_ops_backup_', '').replace('.db', '')}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}

                <main className="page" id="main">
                    {loading || (!error && !reportData) ? (
                        <>
                            <div className="exec-strip" style={{ minHeight: 72 }} aria-busy="true">LOADING REPORT DATA…</div>
                            <div className="report-modes" style={{ minHeight: 52 }} aria-hidden="true" />
                            <div id="report-body" style={{ minHeight: 1200 }} aria-hidden="true" />
                        </>
                    ) : null}
                    {error ? (
                        <div id="error-msg" style={{ display: 'block' }}>
                            {error}
                            {activeBackup ? (
                                <div style={{ marginTop: 8, fontSize: '0.9em', opacity: 0.9 }}>
                                    Selected backup could not be loaded. Choose CURRENT LIVE DB or another backup — live data is not substituted under BACKUP.
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                    {!loading && !error && reportData ? (
                        <>
                            <div className="reports-sticky-tools">
                                <ExecStrip data={reportData} />
                                <div id="report-modes-wrap">
                                    <ReportModeTabs data={reportData} />
                                </div>
                                <ReportSectionNav mode={reportMode} />
                            </div>
                            <div id="report-body">
                                <TodayPanel data={reportData} />
                                <LearnPanel data={reportData} />
                                <HandoffPanel data={reportData} />
                                <ReportFooter data={reportData} />
                            </div>
                        </>
                    ) : null}
                </main>

                <PrintSectionPicker open={printOpen} onClose={() => setPrintOpen(false)} />
            </div>
        </ReportsContext.Provider>
    );
}
