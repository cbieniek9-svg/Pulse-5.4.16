import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { formatApiError } from '../lib/api.js';
import {
    createSession,
    listSessions,
    getSession,
    reopenSession,
    exportSessionCsv,
    finalizeOrderDraft,
    getOrderReport,
    closeBackstockSession,
    closeLocationSession,
    fetchSessionPrintHtml,
    submitScan,
    getActiveScans,
    updateLine,
    deleteLine,
    updateSessionLocation,
    persistCountSessionId,
    readCountSessionId,
    clearCountSessionId,
    getInventoryConfig,
} from '../lib/inventoryCountApi.js';
import useBarcodeCamera, { preferHttpsForCamera } from '../lib/useBarcodeCamera.js';
import { downloadBlob } from './countUtils.js';
import CountDisabledScreen from './components/CountDisabledScreen.jsx';
import CountHomeScreen from './components/CountHomeScreen.jsx';
import CountScanScreen from './components/CountScanScreen.jsx';
import CountDetailScreen from './components/CountDetailScreen.jsx';
import CountOrderFinalizeScreen, { downloadTextCsv } from './components/CountOrderFinalizeScreen.jsx';

function countNotice(err, fallback) {
    return formatApiError(err, fallback || err?.message || 'Request failed');
}

export default function CountApp({ renderAuthWrapper }) {
    const [featureEnabled, setFeatureEnabled] = useState(null);

    useEffect(() => {
        preferHttpsForCamera();
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const cfg = await getInventoryConfig();
                if (!cancelled) setFeatureEnabled(cfg?.enabled !== false);
            } catch (_) {
                if (!cancelled) setFeatureEnabled(true);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (featureEnabled === null) return null;
    if (!featureEnabled) return <CountDisabledScreen />;

    const shell = <CountAuthenticatedApp />;
    if (typeof renderAuthWrapper === 'function') return renderAuthWrapper(shell);
    return shell;
}

function CountAuthenticatedApp() {
    const { token, user, logout } = useAuth();
    const [screen, setScreen] = useState('home');
    const [activeSession, setActiveSession] = useState(null);
    const [detailSessionId, setDetailSessionId] = useState(null);
    const [detailReturnTo, setDetailReturnTo] = useState('home');
    const [openSessions, setOpenSessions] = useState([]);
    const [pastSessions, setPastSessions] = useState([]);
    const [listError, setListError] = useState('');
    const [recentScans, setRecentScans] = useState([]);
    const [scanStatus, setScanStatus] = useState({ msg: '', ok: null });
    const [submitting, setSubmitting] = useState(false);
    const [detailSession, setDetailSession] = useState(null);
    const [detailLines, setDetailLines] = useState([]);
    const [detailLineCount, setDetailLineCount] = useState(0);
    const [detailError, setDetailError] = useState('');
    const [finalizeResult, setFinalizeResult] = useState(null);
    const [finalizeError, setFinalizeError] = useState('');
    const qtyRef = useRef('1');
    const submittingRef = useRef(false);
    const activeSessionRef = useRef(null);
    const scanAcceptedRef = useRef(null);
    const pendingUpcRef = useRef(null);

    useEffect(() => {
        activeSessionRef.current = activeSession;
    }, [activeSession]);

    const setStatus = useCallback((msg, ok) => {
        setScanStatus({ msg: msg || '', ok: ok ?? null });
    }, []);

    const persistActiveSession = useCallback((session) => {
        setActiveSession(session || null);
        persistCountSessionId(session?.id || null);
    }, []);

    const loadRecent = useCallback(async (sessionId) => {
        const sid = sessionId || activeSessionRef.current?.id;
        if (!sid || !token) return;
        try {
            const data = await getActiveScans(token, sid);
            setRecentScans(data.scans || []);
        } catch (err) {
            setStatus(countNotice(err, 'Load failed'), false);
        }
    }, [token, setStatus]);

    const loadHomeLists = useCallback(async () => {
        if (!token) return;
        try {
            const data = await listSessions(token, 'all');
            const sessions = data.sessions || [];
            setOpenSessions(sessions.filter((s) => s.status === 'open'));
            setPastSessions(sessions.filter((s) => s.status === 'exported' || s.status === 'committed'));
            setListError('');
        } catch (err) {
            setListError(countNotice(err, 'Could not load sessions'));
        }
    }, [token]);

    const loadDetail = useCallback(async (sessionId) => {
        const sid = sessionId || detailSessionId;
        if (!sid || !token) return;
        try {
            const data = await getSession(token, sid);
            setDetailSession(data.session);
            setDetailLines(data.lines || []);
            setDetailLineCount(data.line_count || 0);
            setDetailError('');
        } catch (err) {
            setDetailError(countNotice(err, 'Could not load detail'));
        }
    }, [token, detailSessionId]);

    const openScanScreen = useCallback(async (session) => {
        const next = session || activeSessionRef.current;
        if (!next) {
            setScreen('home');
            return;
        }
        persistActiveSession(next);
        setScreen('scan');
        await loadRecent(next.id);
    }, [loadRecent, persistActiveSession]);

    const enterApp = useCallback(async () => {
        const savedId = readCountSessionId();
        if (savedId && token) {
            try {
                const data = await getSession(token, savedId);
                if (data.session?.status === 'open') {
                    await openScanScreen(data.session);
                    return;
                }
            } catch (_) { /* fall through */ }
            clearCountSessionId();
        }
        setScreen('home');
        await loadHomeLists();
    }, [token, openScanScreen, loadHomeLists]);

    // Boot once per auth token. Do NOT re-run when callback identities churn —
    // that was yanking users back into a sticky sessionStorage walk and blocking
    // "start another count" until logout cleared tgp_count_session.
    const bootedForTokenRef = useRef('');
    useEffect(() => {
        if (!token) {
            bootedForTokenRef.current = '';
            return;
        }
        if (bootedForTokenRef.current === token) return;
        bootedForTokenRef.current = token;
        void enterApp();
    }, [token, enterApp]);

    const submitScanLine = useCallback(async (upcRaw, qtyRaw, { showScanAccepted, uom } = {}) => {
        const session = activeSessionRef.current;
        if (!session?.id) {
            setStatus('No active location session', false);
            return false;
        }
        if (submittingRef.current) return false;

        const upc = String(upcRaw || '').trim();
        let quantity = Number(qtyRaw);
        if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;
        if (!upc) {
            setStatus('Scan a UPC', false);
            return false;
        }
        const sessionType = session.session_type || 'location';
        const scanUom = (sessionType === 'backstock' || sessionType === 'order')
            ? 'case'
            : String(uom || '').trim().toLowerCase();
        if (sessionType === 'location' && scanUom !== 'case' && scanUom !== 'unit') {
            setStatus('Select case or unit first', false);
            return false;
        }

        submittingRef.current = true;
        setSubmitting(true);
        try {
            await submitScan(token, {
                session_id: session.id,
                upc,
                quantity,
                uom: scanUom,
            });
            const feedback = showScanAccepted || scanAcceptedRef.current;
            if (typeof feedback === 'function') feedback(upc, quantity);
            else setStatus(`Added ${upc} ×${quantity} ${scanUom}`, true);
            await loadRecent(session.id);
            return true;
        } catch (err) {
            setStatus(countNotice(err, 'Scan failed'), false);
            return false;
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    }, [token, loadRecent, setStatus]);

    const camera = useBarcodeCamera({
        onDecode: async (upc) => {
            if (typeof pendingUpcRef.current === 'function') pendingUpcRef.current(upc);
            else await submitScanLine(upc, qtyRef.current);
        },
        onStatus: setStatus,
    });

    const showHomeWithCamera = useCallback(async () => {
        // Home first — clearing activeSession while screen is still 'scan' used to
        // render null and freeze the portal until logout/reload.
        setScreen('home');
        persistActiveSession(null);
        clearCountSessionId();
        submittingRef.current = false;
        setSubmitting(false);
        try {
            await camera.stopCamera();
        } catch (_) { /* ignore camera teardown */ }
        await loadHomeLists();
    }, [camera, loadHomeLists, persistActiveSession]);

    const startLocationCount = useCallback(async (location) => {
        try {
            clearCountSessionId();
            const data = await createSession(token, { location, session_type: 'location' });
            await openScanScreen(data.session);
        } catch (err) {
            window.alert(countNotice(err, 'Could not start count'));
            throw err;
        }
    }, [token, openScanScreen]);

    const startBackstockCount = useCallback(async (bayLabel) => {
        try {
            clearCountSessionId();
            const data = await createSession(token, {
                location: bayLabel || 'Backstock',
                session_type: 'backstock',
            });
            await openScanScreen(data.session);
        } catch (err) {
            window.alert(countNotice(err, 'Could not start backstock count'));
            throw err;
        }
    }, [token, openScanScreen]);

    const startOrderDraft = useCallback(async (label) => {
        try {
            clearCountSessionId();
            const data = await createSession(token, {
                location: label || 'Order draft',
                session_type: 'order',
            });
            await openScanScreen(data.session);
        } catch (err) {
            window.alert(countNotice(err, 'Could not start order draft'));
            throw err;
        }
    }, [token, openScanScreen]);

    const handleCloseLocation = useCallback(async (sessionId) => {
        const sid = sessionId || activeSessionRef.current?.id;
        if (!sid) return;
        if (!window.confirm(
            'Close this location count?\n\n'
            + 'It moves to History. You can still print or export CSV afterward (or reopen with manager PIN).',
        )) return;
        setSubmitting(true);
        try {
            await closeLocationSession(token, sid);
            setStatus('Location count closed', true);
            await showHomeWithCamera();
        } catch (err) {
            setStatus(countNotice(err, 'Close failed'), false);
            window.alert(countNotice(err, 'Close failed'));
            await showHomeWithCamera();
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    }, [token, showHomeWithCamera, setStatus]);

    const handlePrintSession = useCallback(async (sessionId) => {
        const sid = sessionId || activeSessionRef.current?.id;
        if (!sid || !token) return;
        try {
            const html = await fetchSessionPrintHtml(token, sid);
            // Do not pass noopener — it forces window.open to return null even when
            // the window opens, which made Print always look "blocked" in Electron.
            const win = window.open('', '_blank');
            if (!win) {
                window.alert('Pop-up blocked — allow pop-ups to print.');
                return;
            }
            win.document.open();
            win.document.write(html);
            win.document.close();
        } catch (err) {
            window.alert(countNotice(err, 'Print failed'));
        }
    }, [token]);

    const handleCloseBackstock = useCallback(async (sessionId) => {
        const sid = sessionId || activeSessionRef.current?.id;
        if (!sid) return;
        if (!window.confirm(
            'Close this backstock walk and commit it to Pulse memory?\n\n'
            + 'UPCs at this bay/display become the on-hand stock used when you finalize an order draft '
            + '(pick list + clean order with vendor numbers).\n\n'
            + 'Open walks are NOT used until you commit them.',
        )) return;
        setSubmitting(true);
        try {
            const result = await closeBackstockSession(token, sid);
            setStatus(
                `Committed ${result.upc_count || 0} UPCs at ${result.location || 'Backstock'}`,
                true,
            );
            await showHomeWithCamera();
            window.alert(
                `Backstock committed.\n\n`
                + `${result.upc_count || 0} UPCs · ${result.total_units || 0} units at ${result.location || 'Backstock'}\n`
                + `Memory now has ${result.memory?.upc_count || 0} UPCs total.`,
            );
        } catch (err) {
            setStatus(countNotice(err, 'Close failed'), false);
            window.alert(countNotice(err, 'Close failed'));
            await showHomeWithCamera();
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    }, [token, showHomeWithCamera, setStatus]);

    const handleFinalizeOrder = useCallback(async (sessionId) => {
        const sid = sessionId || activeSessionRef.current?.id;
        if (!sid) return;
        if (!window.confirm(
            'Finalize this order draft?\n\n'
            + '• Uses COMMITTED backstock memory (CLOSE & COMMIT first)\n'
            + '• Pick list = ordered items found in memory (with bay/display)\n'
            + '• Clean order = remaining qty with vendor # + UPC for the relay\n\n'
            + 'This does NOT touch the floor labor order clock.',
        )) return;
        setFinalizeError('');
        setSubmitting(true);
        try {
            const result = await finalizeOrderDraft(token, sid);
            setFinalizeResult(result);
            setScreen('finalize');
            persistActiveSession(null);
            clearCountSessionId();
            try { await camera.stopCamera(); } catch (_) { /* ignore */ }
            await loadHomeLists();
        } catch (err) {
            setFinalizeError(countNotice(err, 'Finalize failed'));
            window.alert(countNotice(err, 'Finalize failed'));
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    }, [token, persistActiveSession, camera, loadHomeLists]);

    const handleViewOrderReport = useCallback(async (sessionId) => {
        const sid = sessionId || detailSessionId || activeSessionRef.current?.id;
        if (!sid) return;
        setFinalizeError('');
        setSubmitting(true);
        try {
            const result = await getOrderReport(token, sid);
            setFinalizeResult(result);
            await camera.stopCamera();
            setScreen('finalize');
        } catch (err) {
            setFinalizeError(countNotice(err, 'Could not load order report'));
            window.alert(countNotice(err, 'Could not load order report'));
        } finally {
            setSubmitting(false);
        }
    }, [token, detailSessionId, camera]);

    const collectReopenControls = useCallback(() => {
        const reason = window.prompt('Reason for reopen (required):', 'Correction');
        if (reason == null) return null;
        if (String(reason).trim().length < 3) {
            window.alert('A reason of at least 3 characters is required.');
            return null;
        }
        const confirm_pin = window.prompt('Manager PIN to confirm reopen:', '');
        if (confirm_pin == null) return null;
        return { reason: String(reason).trim(), confirm_pin: String(confirm_pin) };
    }, []);

    const resumeSession = useCallback(async (sessionId) => {
        try {
            const data = await getSession(token, sessionId);
            if (data.session.status !== 'open') {
                const controls = collectReopenControls();
                if (!controls) return;
                const reopened = await reopenSession(token, sessionId, controls);
                await openScanScreen(reopened.session);
                return;
            }
            await openScanScreen(data.session);
        } catch (err) {
            window.alert(countNotice(err, 'Could not open session'));
        }
    }, [token, openScanScreen, collectReopenControls]);

    const reopenAndScan = useCallback(async (sessionId) => {
        try {
            const controls = collectReopenControls();
            if (!controls) return;
            const data = await reopenSession(token, sessionId, controls);
            await openScanScreen(data.session);
        } catch (err) {
            window.alert(countNotice(err, 'Could not reopen'));
        }
    }, [token, openScanScreen, collectReopenControls]);

    const openDetail = useCallback(async (sessionId, returnTo = 'home') => {
        setDetailSessionId(sessionId);
        setDetailReturnTo(returnTo);
        await camera.stopCamera();
        setScreen('detail');
        await loadDetail(sessionId);
    }, [camera, loadDetail]);

    const backFromDetail = useCallback(async () => {
        if (detailReturnTo === 'scan' && activeSessionRef.current) {
            await openScanScreen();
        } else {
            await showHomeWithCamera();
        }
    }, [detailReturnTo, openScanScreen, showHomeWithCamera]);

    const handleExportSession = useCallback(async (sessionId) => {
        const sid = sessionId || activeSessionRef.current?.id;
        if (!sid) return;
        const session = activeSessionRef.current;
        if (session?.id === sid && !window.confirm(`Export CSV for ${session.location}? Lines are kept so you can edit later.`)) {
            return;
        }
        try {
            const { blob, filename } = await exportSessionCsv(token, sid);
            downloadBlob(blob, filename);
            if (session?.id === sid) {
                setStatus('Exported (kept for history)', true);
                await showHomeWithCamera();
            } else {
                await loadDetail(sid);
                await loadHomeLists();
            }
        } catch (err) {
            setStatus(countNotice(err, 'Export failed'), false);
            window.alert(countNotice(err, 'Export failed'));
        }
    }, [token, persistActiveSession, showHomeWithCamera, loadDetail, loadHomeLists, setStatus]);

    const handleDeleteLine = useCallback(async (lineId) => {
        if (!window.confirm(`Delete this scan line #${lineId}?`)) return;
        try {
            await deleteLine(token, lineId);
            setStatus(`Deleted line #${lineId}`, true);
            if (screen === 'detail') await loadDetail();
            if (activeSessionRef.current?.id) await loadRecent();
        } catch (err) {
            setStatus(countNotice(err, 'Delete failed'), false);
            window.alert(countNotice(err, 'Delete failed'));
        }
    }, [token, screen, loadDetail, loadRecent, setStatus]);

    const handleSaveLine = useCallback(async (lineId, { upc, quantity, uom }) => {
        try {
            await updateLine(token, lineId, { upc, quantity, uom });
            setStatus('Line saved', true);
            await loadDetail();
        } catch (err) {
            setStatus(countNotice(err, 'Save failed'), false);
            window.alert(countNotice(err, 'Save failed'));
        }
    }, [token, loadDetail, setStatus]);

    const handleRenameLocation = useCallback(async () => {
        if (!detailSessionId) return;
        const next = window.prompt('New location name:');
        if (next == null) return;
        const location = String(next).trim();
        if (!location) return;
        try {
            const data = await updateSessionLocation(token, detailSessionId, location);
            if (activeSessionRef.current?.id === detailSessionId) persistActiveSession(data.session);
            await loadDetail();
        } catch (err) {
            window.alert(countNotice(err, 'Rename failed'));
        }
    }, [token, detailSessionId, persistActiveSession, loadDetail]);

    const handleLogout = useCallback(async () => {
        await camera.stopCamera();
        clearCountSessionId();
        logout();
        window.location.reload();
    }, [camera, logout]);

    if (screen === 'home') {
        return (
            <CountHomeScreen
                user={user}
                openSessions={openSessions}
                pastSessions={pastSessions}
                listError={listError}
                onStartLocation={startLocationCount}
                onStartBackstock={startBackstockCount}
                onStartOrderDraft={startOrderDraft}
                onContinue={resumeSession}
                onEdit={(id) => openDetail(id, 'home')}
                onReopenScan={reopenAndScan}
                onViewOrderReport={handleViewOrderReport}
                onLogout={handleLogout}
            />
        );
    }

    if (screen === 'finalize') {
        return (
            <CountOrderFinalizeScreen
                result={finalizeResult}
                error={finalizeError}
                busy={submitting}
                onBack={showHomeWithCamera}
                onDownloadPick={() => {
                    const csv = finalizeResult?.csv;
                    if (!csv?.pick_list) return;
                    downloadTextCsv(csv.pick_list, csv.pick_filename || 'PickList.csv');
                }}
                onDownloadClean={() => {
                    const csv = finalizeResult?.csv;
                    if (!csv?.clean_order) return;
                    downloadTextCsv(csv.clean_order, csv.clean_filename || 'CleanOrder.csv');
                }}
            />
        );
    }

    if (screen === 'scan' && activeSession) {
        return (
            <CountScanScreen
                activeSession={activeSession}
                recentScans={recentScans}
                scanStatus={scanStatus}
                submitting={submitting}
                camera={camera}
                qtyRef={qtyRef}
                scanAcceptedRef={scanAcceptedRef}
                pendingUpcRef={pendingUpcRef}
                onShowHome={showHomeWithCamera}
                onSubmitScan={submitScanLine}
                onDeleteLine={handleDeleteLine}
                onExport={() => handleExportSession()}
                onPrint={() => handlePrintSession()}
                onCloseLocation={() => handleCloseLocation()}
                onFinalizeOrder={() => handleFinalizeOrder()}
                onCloseBackstock={() => handleCloseBackstock()}
                onOpenDetail={() => openDetail(activeSession.id, 'scan')}
            />
        );
    }

    if (screen === 'detail') {
        return (
            <CountDetailScreen
                session={detailSession}
                lines={detailLines}
                lineCount={detailLineCount}
                loadError={detailError}
                onBack={backFromDetail}
                onExport={() => handleExportSession(detailSessionId)}
                onPrint={() => handlePrintSession(detailSessionId)}
                onCloseLocation={
                    (!detailSession?.session_type || detailSession?.session_type === 'location')
                    && detailSession?.status === 'open'
                        ? () => handleCloseLocation(detailSessionId)
                        : undefined
                }
                onFinalizeOrder={
                    detailSession?.session_type === 'order' && detailSession?.status === 'open'
                        ? () => handleFinalizeOrder(detailSessionId)
                        : undefined
                }
                onViewOrderReport={
                    detailSession?.session_type === 'order'
                        ? () => handleViewOrderReport(detailSessionId)
                        : undefined
                }
                onCloseBackstock={
                    detailSession?.session_type === 'backstock' && detailSession?.status === 'open'
                        ? () => handleCloseBackstock(detailSessionId)
                        : undefined
                }
                onReopen={() => reopenAndScan(detailSessionId)}
                onContinueScan={() => resumeSession(detailSessionId)}
                onRename={handleRenameLocation}
                onSaveLine={handleSaveLine}
                onDeleteLine={handleDeleteLine}
            />
        );
    }

    // Never blank the portal — scan without a session used to return null after close.
    return (
        <CountHomeScreen
            user={user}
            openSessions={openSessions}
            pastSessions={pastSessions}
            listError={listError}
            onStartLocation={startLocationCount}
            onStartBackstock={startBackstockCount}
            onStartOrderDraft={startOrderDraft}
            onContinue={resumeSession}
            onEdit={(id) => openDetail(id, 'home')}
            onReopenScan={reopenAndScan}
            onViewOrderReport={handleViewOrderReport}
            onLogout={handleLogout}
        />
    );
}
