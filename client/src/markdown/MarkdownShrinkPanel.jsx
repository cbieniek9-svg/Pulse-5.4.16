import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJson, httpError, resolveUrl } from '../lib/api.js';
import useBarcodeCamera from '../lib/useBarcodeCamera.js';
import { beepScanOk, normalizeScannedCode } from '../lib/cameraUtils.js';
import { lookupItem } from '../lib/itemCatalogApi.js';
import BarcodeCameraPanel from '../components/shared/BarcodeCameraPanel.jsx';
import { SHRINK_REASONS, reasonSelectValue } from '../lib/shrinkReasons.js';

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const s = String(reader.result || '');
            const i = s.indexOf(',');
            resolve(i >= 0 ? s.slice(i + 1) : s);
        };
        reader.onerror = () => reject(new Error('Could not read file'));
        reader.readAsDataURL(file);
    });
}

function normalizeQty(raw, fallback = 1) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

function moneyLabel(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return `$${Number(n).toFixed(2)}`;
}

function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
    }, 500);
}

function emptyEdit() {
    return { sku: '', item: '', quantity: '1', reason: '' };
}

const SHRINK_SESSION_KEY = 'tgp_shrink_session_id';

export default function MarkdownShrinkPanel({ token, showToast }) {
    const [rows, setRows] = useState([]);
    const [totals, setTotals] = useState(null);
    const [departments, setDepartments] = useState([]);
    const [counts, setCounts] = useState(null);
    const [sessions, setSessions] = useState([]);
    const [recentSessions, setRecentSessions] = useState([]);
    const [activeSessionId, setActiveSessionId] = useState(() => {
        try { return localStorage.getItem(SHRINK_SESSION_KEY) || ''; } catch { return ''; }
    });
    const [newLabel, setNewLabel] = useState('');
    const [storeDate, setStoreDate] = useState('');
    const [todayDate, setTodayDate] = useState('');
    const [sku, setSku] = useState('');
    const [item, setItem] = useState('');
    const [qty, setQty] = useState('1');
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [preview, setPreview] = useState(null);
    const [pendingFile, setPendingFile] = useState(null);
    const [importHistorical, setImportHistorical] = useState(true);
    const [importDate, setImportDate] = useState('');
    const [scanStatus, setScanStatus] = useState({ msg: '', ok: null });
    const [catalogHit, setCatalogHit] = useState(null);
    const [scanTypeMode, setScanTypeMode] = useState(false);
    const [editingId, setEditingId] = useState('');
    const [editDraft, setEditDraft] = useState(emptyEdit());
    const itemValueRef = useRef('');
    const skuRef = useRef(null);
    const qtyRef = useRef(null);
    const storeDateRef = useRef('');
    const todayDateRef = useRef('');
    useEffect(() => { storeDateRef.current = storeDate; }, [storeDate]);
    useEffect(() => { todayDateRef.current = todayDate; }, [todayDate]);
    // What we filled in last, and for which SKU, so a name left over from the previous
    // scan does not stay attached to the next one.
    const autoItemRef = useRef('');
    const resolvedSkuRef = useRef('');
    const loadSeqRef = useRef(0);

    useEffect(() => { itemValueRef.current = item; }, [item]);

    const resolveSku = useCallback(async (code, { focusQty = false } = {}) => {
        const isNewCode = resolvedSkuRef.current !== code;
        resolvedSkuRef.current = code;
        const nameNow = itemValueRef.current;
        const typedByHand = nameNow.trim() !== '' && nameNow !== autoItemRef.current;
        const applyName = (name) => { autoItemRef.current = name; setItem(name); };

        try {
            const found = await lookupItem(token, code);
            setCatalogHit(found);
            if (found?.description && (isNewCode || !nameNow.trim())) {
                applyName(found.description);
            } else if (isNewCode && !typedByHand && nameNow.trim()) {
                applyName('');
            }
        } catch (e) {
            setCatalogHit(null);
            setScanStatus({ msg: e.message || 'Catalog lookup failed', ok: false });
        }
        // After a camera/scan decode only — typed blur/Enter should not steal focus.
        if (focusQty) requestAnimationFrame(() => qtyRef.current?.focus());
    }, [token]);

    const onDecode = useCallback(async (code) => {
        const clean = normalizeScannedCode(code);
        if (!clean) return;
        setSku(clean);
        setCatalogHit(null);
        beepScanOk();
        setScanStatus({ msg: `Scanned ${clean}`, ok: true });
        await resolveSku(clean, { focusQty: true });
    }, [resolveSku]);
    const onScanStatus = useCallback((msg, ok) => setScanStatus({ msg, ok }), []);
    const camera = useBarcodeCamera({ onDecode, onStatus: onScanStatus, portalPath: '/markdown' });

    const selectSession = useCallback((id) => {
        const next = String(id || '');
        setActiveSessionId(next);
        try {
            if (next) localStorage.setItem(SHRINK_SESSION_KEY, next);
            else localStorage.removeItem(SHRINK_SESSION_KEY);
        } catch { /* ignore */ }
    }, []);

    const load = useCallback(async (opts = {}) => {
        if (!token) return;
        const seq = ++loadSeqRef.current;
        try {
            let sid = opts.sessionId != null ? opts.sessionId : activeSessionId;
            if (opts.sessionId == null) {
                try { sid = localStorage.getItem(SHRINK_SESSION_KEY) || sid; } catch { /* ignore */ }
            }
            const dateHint = opts.storeDate || storeDateRef.current || '';
            const qs = new URLSearchParams();
            if (sid) qs.set('session_id', sid);
            else if (dateHint) qs.set('store_date', dateHint);
            const data = await fetchJson(`/api/markdown/shrink?${qs.toString()}`, {
                cache: 'no-store',
                headers: { 'x-session-token': token },
            });
            if (seq !== loadSeqRef.current) return;
            const list = data.sessions || [];
            const recent = data.recent_sessions || [];
            setSessions(list);
            setRecentSessions(recent);
            if (data.store_date) setStoreDate(data.store_date);

            // Remember business "today" from a plain day load (no forced past session).
            if (!todayDateRef.current) {
                if (!sid && data.store_date) setTodayDate(data.store_date);
                else if (recent[0]?.store_date) {
                    // Fallback: ask for today without a session filter.
                    try {
                        const boot = await fetchJson('/api/markdown/shrink', {
                            cache: 'no-store',
                            headers: { 'x-session-token': token },
                        });
                        if (seq !== loadSeqRef.current) return;
                        if (boot.store_date) setTodayDate(boot.store_date);
                    } catch { /* ignore */ }
                }
            }

            let nextSid = data.session?.id || sid || '';
            const known = nextSid && (
                list.some((s) => s.id === nextSid)
                || recent.some((s) => s.id === nextSid)
            );
            if (!known) {
                const open = list.find((s) => s.status === 'open');
                nextSid = open?.id || list[0]?.id || '';
            }
            if (nextSid && nextSid !== activeSessionId) {
                selectSession(nextSid);
                // Selecting updates activeSessionId and re-runs load via effect — return after syncing rows if same response already has them.
            }

            if (nextSid && nextSid !== (data.session?.id || '') && nextSid !== sid) {
                const again = await fetchJson(
                    `/api/markdown/shrink?session_id=${encodeURIComponent(nextSid)}`,
                    { cache: 'no-store', headers: { 'x-session-token': token } },
                );
                if (seq !== loadSeqRef.current) return;
                setSessions(again.sessions || list);
                setRecentSessions(again.recent_sessions || recent);
                if (again.store_date) setStoreDate(again.store_date);
                setRows(again.rows || []);
                setTotals(again.totals || null);
                setDepartments(again.departments || []);
                setCounts(again.counts || null);
                return;
            }

            setRows(data.rows || []);
            setTotals(data.totals || null);
            setDepartments(data.departments || []);
            setCounts(data.counts || null);
        } catch (e) {
            if (seq !== loadSeqRef.current) return;
            showToast(e.message || 'Could not load shrink');
        }
    }, [token, showToast, activeSessionId, selectSession]);

    useEffect(() => { load(); }, [load]);

    const activeSession = sessions.find((s) => s.id === activeSessionId)
        || recentSessions.find((s) => s.id === activeSessionId)
        || null;
    const openSessions = sessions.filter((s) => s.status === 'open');
    const closedSessions = sessions.filter((s) => s.status === 'closed');
    const canLog = !!activeSession && activeSession.status === 'open';
    const viewingPast = !!(todayDate && storeDate && storeDate !== todayDate);

    const openCount = async (session) => {
        if (!session?.id) return;
        selectSession(session.id);
        setStoreDate(session.store_date || storeDate);
        await load({ sessionId: session.id, storeDate: session.store_date });
    };

    const changeViewDate = async (nextDate) => {
        const d = String(nextDate || '').trim();
        setStoreDate(d);
        selectSession('');
        await load({ sessionId: '', storeDate: d });
    };

    const startCount = async () => {
        setBusy(true);
        try {
            const targetDate = storeDate || todayDate || undefined;
            const res = await fetchJson('/api/markdown/shrink/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({ label: newLabel.trim(), store_date: targetDate }),
            });
            const created = res.session;
            selectSession(created?.id || '');
            if (created?.store_date) setStoreDate(created.store_date);
            setNewLabel('');
            showToast(`Opened ${created?.label || 'shrink count'}`);
            await load({ sessionId: created?.id, storeDate: created?.store_date });
        } catch (err) {
            showToast(err.message || 'Could not open count');
        } finally {
            setBusy(false);
        }
    };

    const submitManual = async (e) => {
        e.preventDefault();
        if (!sku.trim()) return showToast('SKU required');
        if (!canLog) return showToast('Open a shrink count first');
        setBusy(true);
        try {
            const res = await fetchJson('/api/markdown/shrink', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({
                    session_id: activeSessionId,
                    sku: sku.trim(),
                    item: item.trim(),
                    quantity: normalizeQty(qty, 1),
                    reason: reason.trim(),
                }),
            });
            if (res.session_id && res.session_id !== activeSessionId) selectSession(res.session_id);
            setSku('');
            setItem('');
            setQty('1');
            setReason('');
            setCatalogHit(null);
            autoItemRef.current = '';
            resolvedSkuRef.current = '';
            showToast('Shrink line saved');
            await load();
        } catch (err) {
            showToast(err.message || 'Save failed');
        } finally {
            setBusy(false);
        }
    };

    const startEdit = (row) => {
        setEditingId(row.id);
        setEditDraft({
            sku: row.sku || '',
            item: row.item || row.description || '',
            quantity: String(row.quantity ?? 1),
            reason: row.reason || '',
        });
    };

    const cancelEdit = () => {
        setEditingId('');
        setEditDraft(emptyEdit());
    };

    const resolveEditSku = async (raw) => {
        const clean = normalizeScannedCode(raw);
        if (!clean) return;
        setEditDraft((d) => ({ ...d, sku: clean }));
        const found = await lookupItem(token, clean);
        if (found?.description) {
            setEditDraft((d) => ({ ...d, sku: clean, item: found.description }));
        }
    };

    const saveEdit = async (id) => {
        const quantity = normalizeQty(editDraft.quantity, 0);
        if (!editDraft.sku.trim()) return showToast('SKU required');
        if (!quantity) return showToast('Quantity must be greater than zero');
        setBusy(true);
        try {
            await fetchJson(`/api/markdown/shrink/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({
                    sku: editDraft.sku.trim(),
                    item: editDraft.item.trim(),
                    quantity,
                    reason: editDraft.reason.trim(),
                }),
            });
            cancelEdit();
            showToast('Shrink line updated');
            await load();
        } catch (err) {
            showToast(err.message || 'Could not update line');
        } finally {
            setBusy(false);
        }
    };

    const voidLine = async (row) => {
        if (!window.confirm(`Void this shrink line?\n\n${row.sku}${row.item || row.description ? ` · ${row.item || row.description}` : ''}\nqty ${row.quantity}\n\nIt drops out of today's totals (kept for audit).`)) {
            return;
        }
        setBusy(true);
        try {
            await fetchJson(`/api/markdown/shrink/${encodeURIComponent(row.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({ status: 'Voided' }),
            });
            if (editingId === row.id) cancelEdit();
            showToast('Line voided');
            await load();
        } catch (err) {
            showToast(err.message || 'Could not void line');
        } finally {
            setBusy(false);
        }
    };

    const closeActiveCount = async () => {
        if (!activeSessionId) return showToast('No active count');
        const open = counts?.open ?? rows.filter((r) => r.status === 'Open').length;
        if (!window.confirm(
            `Close this shrink count?\n\n${activeSession?.label || 'Walk'}\n${open} open line(s)\nRetail ${moneyLabel(totals?.retail)} · Cost ${moneyLabel(totals?.cost)}\n\nYou can open another count right away. Export still works afterward.`,
        )) return;
        setBusy(true);
        try {
            const res = await fetchJson(`/api/markdown/shrink/sessions/${encodeURIComponent(activeSessionId)}/close`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({}),
            });
            showToast(`Closed ${res.closed ?? open} line(s) — open a new count anytime`);
            await load();
        } catch (err) {
            showToast(err.message || 'Could not close shrink count');
        } finally {
            setBusy(false);
        }
    };

    const reopenActiveCount = async () => {
        if (!activeSessionId) return;
        if (!window.confirm(`Reopen "${activeSession?.label || 'this count'}" so lines can be edited again?`)) return;
        setBusy(true);
        try {
            const res = await fetchJson(`/api/markdown/shrink/sessions/${encodeURIComponent(activeSessionId)}/reopen`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({}),
            });
            showToast(`Reopened ${res.reopened || 0} line(s)`);
            await load();
        } catch (err) {
            showToast(err.message || 'Could not reopen count');
        } finally {
            setBusy(false);
        }
    };

    const exportShrink = async (format) => {
        if (!token) return;
        const path = `/api/markdown/shrink/export?store_date=${encodeURIComponent(storeDate || '')}&format=${format}`;
        const printWindow = format === 'print' ? window.open('', '_blank') : null;
        if (printWindow) {
            printWindow.document.write('<!doctype html><title>Floor Shrink</title><body style="font-family:Arial,sans-serif;margin:24px">Loading…</body>');
            printWindow.document.close();
        }
        setBusy(true);
        try {
            const res = await fetch(resolveUrl(path), {
                headers: { 'x-session-token': token || '' },
            });
            if (!res.ok) throw await httpError(res, 'Export failed');
            if (format === 'csv') {
                downloadBlob(await res.blob(), `TGP_Floor_Shrink_${storeDate || 'day'}.csv`);
                showToast('Shrink CSV downloaded');
                return;
            }
            const html = await res.text();
            const win = printWindow && !printWindow.closed ? printWindow : window.open('', '_blank');
            if (!win) throw new Error('Popup blocked. Allow popups and try again.');
            win.document.open();
            win.document.write(html);
            win.document.close();
            try { win.focus(); } catch (_) { /* ignore */ }
        } catch (err) {
            if (printWindow && !printWindow.closed) printWindow.close();
            showToast(err.message || 'Export failed');
        } finally {
            setBusy(false);
        }
    };

    const onCsvWithHold = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (!file) return;
        setPendingFile(file);
        setBusy(true);
        try {
            const contentBase64 = await fileToBase64(file);
            const previewRes = await fetchJson('/api/markdown/shrink/import-csv', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({
                    filename: file.name,
                    contentBase64,
                    dry_run: true,
                    historical: importHistorical,
                    store_date: importDate || storeDate || undefined,
                    session_id: importHistorical ? undefined : activeSessionId || undefined,
                }),
            });
            setPreview(previewRes);
            showToast(`Preview ${previewRes.import_count || 0} row(s) — confirm import`);
        } catch (err) {
            setPendingFile(null);
            showToast(err.message || 'CSV preview failed');
        } finally {
            setBusy(false);
        }
    };

    const confirmImport = async () => {
        if (!pendingFile) return;
        setBusy(true);
        try {
            const contentBase64 = await fileToBase64(pendingFile);
            const res = await fetchJson('/api/markdown/shrink/import-csv', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-session-token': token },
                body: JSON.stringify({
                    filename: pendingFile.name,
                    contentBase64,
                    dry_run: false,
                    historical: importHistorical,
                    store_date: importDate || storeDate || undefined,
                    session_id: importHistorical ? undefined : activeSessionId || undefined,
                }),
            });
            const first = res.sessions?.[0];
            if (first?.id) {
                selectSession(first.id);
                if (first.store_date) setStoreDate(first.store_date);
            }
            const dates = (res.store_dates || []).join(', ');
            showToast(
                `Imported ${res.imported || 0} row(s)`
                + (res.historical ? ` as closed count(s)${dates ? ` · ${dates}` : ''}` : '')
                + ' — opening that count now',
            );
            setPreview(null);
            setPendingFile(null);
            await load({
                sessionId: first?.id || '',
                storeDate: first?.store_date || (res.store_dates?.[0] || storeDate),
            });
        } catch (err) {
            showToast(err.message || 'Import failed');
        } finally {
            setBusy(false);
        }
    };

    const openRows = rows.filter((r) => r.status === 'Open');

    return (
        <div className="entry-card">
            <p className="notice-msg" style={{ margin: '0 0 14px 0' }}>
                Concurrent shrink counts — close one walk and open another the same day.
                Historical XLS/CSV imports create closed counts on their report date; open them below to see the lines.
            </p>

            <div style={{ marginBottom: 14, padding: 12, border: '1px solid rgba(168,85,247,0.25)', borderRadius: 8, textTransform: 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                    <div className="label" style={{ margin: 0 }}>
                        SHRINK COUNTS · {storeDate || '—'}
                        {viewingPast ? ' (past day)' : ''}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <label className="label" htmlFor="sh-view-date" style={{ margin: 0 }}>Day</label>
                        <input
                            id="sh-view-date"
                            className="input"
                            type="date"
                            style={{ width: 150 }}
                            value={storeDate || ''}
                            onChange={(e) => { void changeViewDate(e.target.value); }}
                        />
                        {viewingPast && todayDate ? (
                            <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={() => void changeViewDate(todayDate)}>
                                TODAY
                            </button>
                        ) : null}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                    <input
                        className="input"
                        style={{ flex: '1 1 140px' }}
                        placeholder="Label (e.g. Dairy, Aisle 3)"
                        value={newLabel}
                        onChange={(e) => setNewLabel(e.target.value)}
                    />
                    <button type="button" className="btn btn-warn" disabled={busy} onClick={startCount}>
                        + NEW COUNT
                    </button>
                </div>
                {openSessions.length ? (
                    <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: '0.72rem', color: '#888', marginBottom: 4 }}>OPEN THIS DAY</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {openSessions.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    className={`btn btn-sm ${s.id === activeSessionId ? 'btn-green' : 'btn-secondary'}`}
                                    disabled={busy}
                                    onClick={() => { void openCount(s); }}
                                >
                                    {s.label || 'Walk'} · {s.line_count || 0}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: 8 }}>No open counts on this day — start one to scan, or open a past import below.</div>
                )}
                {closedSessions.length ? (
                    <div style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: '0.72rem', color: '#888', marginBottom: 4 }}>CLOSED THIS DAY</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                            {closedSessions.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    className={`btn btn-sm ${s.id === activeSessionId ? 'btn-green' : 'btn-secondary'}`}
                                    disabled={busy}
                                    onClick={() => { void openCount(s); }}
                                    style={{ opacity: s.id === activeSessionId ? 1 : 0.75 }}
                                >
                                    {s.label || 'Walk'} · {s.line_count || 0}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}
                {recentSessions.length ? (
                    <div>
                        <div style={{ fontSize: '0.72rem', color: '#888', marginBottom: 4 }}>RECENT COUNTS (ALL DAYS)</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
                            {recentSessions.map((s) => (
                                <button
                                    key={s.id}
                                    type="button"
                                    className={`btn btn-sm ${s.id === activeSessionId ? 'btn-green' : 'btn-secondary'}`}
                                    style={{ justifyContent: 'space-between', textAlign: 'left' }}
                                    disabled={busy}
                                    onClick={() => { void openCount(s); }}
                                >
                                    <span>{s.store_date} · {s.label || 'Walk'} · {s.status}</span>
                                    <span>{s.line_count || 0} lines · qty {s.quantity || 0}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}
            </div>

            {activeSession && activeSession.status === 'closed' ? (
                <div className="notice-card" style={{ marginBottom: 14, borderLeftColor: '#0f8', textTransform: 'none' }}>
                    <strong style={{ color: '#0f8' }}>COUNT CLOSED — {activeSession.label}</strong>
                    <div style={{ fontSize: '0.8rem', color: '#ccc', marginTop: 4 }}>
                        This walk is finalized. Open a new count to keep scanning, or reopen this one to edit.
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={reopenActiveCount}>REOPEN THIS COUNT</button>
                        <button type="button" className="btn btn-sm btn-warn" disabled={busy} onClick={startCount}>+ NEW COUNT</button>
                        <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !rows.length} onClick={() => exportShrink('print')}>PRINT REPORT</button>
                        <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !rows.length} onClick={() => exportShrink('csv')}>CSV EXPORT</button>
                    </div>
                </div>
            ) : null}

            {canLog ? (
                <form onSubmit={submitManual}>
                    <div className="form-group">
                        <label className="label" htmlFor="sh-sku">SKU / barcode</label>
                        <BarcodeCameraPanel
                            camera={camera}
                            status={scanStatus}
                            buttonClass="btn btn-sm"
                            typeMode={scanTypeMode}
                            onToggleTypeMode={() => {
                                setScanTypeMode((v) => {
                                    const next = !v;
                                    requestAnimationFrame(() => {
                                        if (next) skuRef.current?.focus();
                                    });
                                    return next;
                                });
                            }}
                        />
                        <input
                            ref={skuRef}
                            id="sh-sku"
                            className="input"
                            value={sku}
                            onChange={(e) => { setSku(e.target.value); setCatalogHit(null); }}
                            onBlur={() => {
                                const clean = normalizeScannedCode(sku);
                                if (clean && clean !== sku) setSku(clean);
                                if (clean.length >= 4) resolveSku(clean);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const clean = normalizeScannedCode(sku);
                                    if (clean) {
                                        if (clean !== sku) setSku(clean);
                                        resolveSku(clean);
                                    }
                                }
                            }}
                            inputMode={scanTypeMode ? 'numeric' : 'none'}
                            enterKeyHint="done"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            placeholder={scanTypeMode ? 'Type SKU / UPC, then Enter' : 'Scan barcode (keyboard stays closed)'}
                        />
                        {catalogHit ? (
                            <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: '#0f8', textTransform: 'none' }}>
                                Known item: <strong>{catalogHit.description || '(no description on file)'}</strong>
                                {catalogHit.retail_price != null ? ` · retail ${moneyLabel(catalogHit.retail_price)}` : ''}
                                {catalogHit.unit_cost != null ? ` · cost ${moneyLabel(catalogHit.unit_cost)}` : ''}
                            </p>
                        ) : null}
                    </div>
                    <div className="form-group">
                        <label className="label" htmlFor="sh-item">Item (optional)</label>
                        <input id="sh-item" className="input" value={item} onChange={(e) => setItem(e.target.value)} />
                    </div>
                    <div className="row-3">
                        <div className="form-group">
                            <label className="label" htmlFor="sh-qty">Qty</label>
                            <div className="qty-stepper">
                                <button
                                    type="button"
                                    className="qty-btn"
                                    onClick={() => setQty(String(Math.max(0.01, Math.round((normalizeQty(qty, 1) - 1) * 100) / 100)))}
                                >
                                    −
                                </button>
                                <input
                                    ref={qtyRef}
                                    id="sh-qty"
                                    className="input"
                                    type="number"
                                    inputMode="decimal"
                                    min="0.01"
                                    step="any"
                                    value={qty}
                                    onChange={(e) => setQty(e.target.value)}
                                    onFocus={(e) => e.target.select()}
                                />
                                <button
                                    type="button"
                                    className="qty-btn"
                                    onClick={() => setQty(String(Math.round((normalizeQty(qty, 1) + 1) * 100) / 100))}
                                >
                                    +
                                </button>
                            </div>
                        </div>
                        <div className="form-group" style={{ gridColumn: 'span 2' }}>
                            <label className="label" htmlFor="sh-reason">Reason</label>
                            <select
                                id="sh-reason"
                                className="input"
                                value={reasonSelectValue(reason)}
                                onChange={(e) => setReason(e.target.value)}
                            >
                                <option value="">Select reason…</option>
                                {SHRINK_REASONS.map((r) => (
                                    <option key={r.code} value={r.label}>{r.label}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <button type="submit" className="btn btn-warn" disabled={busy} style={{ width: '100%' }}>
                        LOG SHRINK
                    </button>
                </form>
            ) : null}

            <div style={{ marginTop: 16, textTransform: 'none' }}>
                <label className="label">Import shrink file (CSV / XLS / XLSX)</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.85rem', color: '#ccc', margin: '6px 0' }}>
                    <input
                        type="checkbox"
                        checked={importHistorical}
                        onChange={(e) => setImportHistorical(e.target.checked)}
                    />
                    Historical import — create closed count(s) from file dates (SMS bakery count reports, old CSVs)
                </label>
                {importHistorical ? (
                    <div className="form-group" style={{ marginBottom: 8 }}>
                        <label className="label" htmlFor="sh-import-date">Default store date (if file has no date)</label>
                        <input
                            id="sh-import-date"
                            className="input"
                            type="date"
                            value={importDate}
                            onChange={(e) => setImportDate(e.target.value)}
                        />
                    </div>
                ) : (
                    <p style={{ fontSize: '0.78rem', color: '#aaa', margin: '0 0 8px' }}>
                        Live import adds rows into the active open count{activeSession ? ` (${activeSession.label})` : ''}.
                    </p>
                )}
                <input
                    type="file"
                    accept=".csv,.xls,.xlsx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={onCsvWithHold}
                    disabled={busy || (!importHistorical && !canLog)}
                />
                <p style={{ fontSize: '0.72rem', color: '#888', marginTop: 6 }}>
                    SMS Inventory Count Report by SubDepartment (.xls) is supported — qty from COUNT Units only (Variance ignored), date from the report header.
                    Plain CSV needs sku/upc/code. SUBTOTAL / GRAND TOTAL rows are skipped.
                </p>
                {preview ? (
                    <div style={{ marginTop: 8, fontSize: '0.9rem', color: '#ddd' }}>
                        Preview: {preview.import_count} row(s)
                        {preview.format ? ` · ${preview.format}` : ''}
                        {preview.report_store_date ? ` · report date ${preview.report_store_date}` : ''}
                        {preview.store_dates?.length ? ` · dates ${preview.store_dates.join(', ')}` : ''}
                        {preview.errors?.length ? ` · ${preview.errors.length} warning(s)` : ''}
                        {preview.candidates?.length ? (
                            <div style={{ marginTop: 6, fontSize: '0.75rem', color: '#aaa', maxHeight: 100, overflow: 'auto' }}>
                                {preview.candidates.slice(0, 8).map((c, i) => (
                                    <div key={`${c.sku}-${i}`}>{c.store_date || '—'} · {c.sku} · qty {c.quantity}{c.item ? ` · ${c.item}` : ''}</div>
                                ))}
                            </div>
                        ) : null}
                        <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                            <button type="button" className="btn btn-green" disabled={busy || !pendingFile} onClick={confirmImport}>
                                CONFIRM IMPORT
                            </button>
                            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setPreview(null); setPendingFile(null); }}>
                                CANCEL
                            </button>
                        </div>
                    </div>
                ) : null}
            </div>

            <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div className="label" style={{ margin: 0 }}>
                    {activeSession ? `${activeSession.status === 'open' ? 'Open' : 'Closed'} · ${activeSession.label}` : 'No count'}
                    {' · '}{storeDate || '—'}
                    {counts?.voided ? ` · ${counts.voided} voided` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {canLog ? (
                        <button type="button" className="btn btn-sm btn-green" disabled={busy || !openRows.length} onClick={closeActiveCount}>
                            CLOSE THIS COUNT
                        </button>
                    ) : null}
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !rows.length} onClick={() => exportShrink('print')}>
                        PRINT DAY REPORT
                    </button>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !rows.length} onClick={() => exportShrink('csv')}>
                        CSV DAY EXPORT
                    </button>
                </div>
            </div>
            {totals ? (
                <div style={{ margin: '8px 0 12px', fontSize: '0.85rem', color: '#c9a0ff', textTransform: 'none' }}>
                    {totals.line_count} line(s) · qty {totals.quantity}
                    {' · '}retail {moneyLabel(totals.retail)}
                    {' · '}cost {moneyLabel(totals.cost)}
                    {totals.department_count ? ` · ${totals.department_count} dept(s)` : ''}
                    {totals.unpriced_lines ? ` · ${totals.unpriced_lines} without catalog price` : ''}
                </div>
            ) : null}
            {departments.length > 1 || (departments[0] && departments[0].department !== 'Unassigned') ? (
                <div style={{ margin: '0 0 12px', fontSize: '0.8rem', color: '#b8a0d4', textTransform: 'none' }}>
                    {departments.map((d) => (
                        <div key={d.department} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
                            <span>{d.department}</span>
                            <span>
                                qty {d.quantity}
                                {' · '}retail {moneyLabel(d.retail)}
                                {' · '}cost {moneyLabel(d.cost)}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}
            <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                {!rows.length ? <div style={{ opacity: 0.65 }}>No shrink lines yet.</div> : null}
                {rows.map((r) => {
                    const locked = r.status !== 'Open';
                    return (
                        <div key={r.id} style={{ padding: '10px 0', borderBottom: '1px solid rgba(168,85,247,0.15)', textTransform: 'none' }}>
                            {editingId === r.id ? (
                                <div style={{ display: 'grid', gap: 8 }}>
                                    <div>
                                        <label className="label" htmlFor={`edit-sku-${r.id}`}>SKU</label>
                                        <input
                                            id={`edit-sku-${r.id}`}
                                            className="input"
                                            value={editDraft.sku}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, sku: e.target.value }))}
                                            onBlur={() => resolveEditSku(editDraft.sku)}
                                            inputMode="numeric"
                                            autoComplete="off"
                                        />
                                    </div>
                                    <div>
                                        <label className="label" htmlFor={`edit-item-${r.id}`}>Item</label>
                                        <input
                                            id={`edit-item-${r.id}`}
                                            className="input"
                                            value={editDraft.item}
                                            onChange={(e) => setEditDraft((d) => ({ ...d, item: e.target.value }))}
                                        />
                                    </div>
                                    <div className="row-3">
                                        <div className="form-group">
                                            <label className="label" htmlFor={`edit-qty-${r.id}`}>Qty</label>
                                            <div className="qty-stepper">
                                                <button
                                                    type="button"
                                                    className="qty-btn"
                                                    onClick={() => setEditDraft((d) => ({
                                                        ...d,
                                                        quantity: String(Math.max(0.01, Math.round((normalizeQty(d.quantity, 1) - 1) * 100) / 100)),
                                                    }))}
                                                >
                                                    −
                                                </button>
                                                <input
                                                    id={`edit-qty-${r.id}`}
                                                    className="input"
                                                    type="number"
                                                    inputMode="decimal"
                                                    min="0.01"
                                                    step="any"
                                                    value={editDraft.quantity}
                                                    onChange={(e) => setEditDraft((d) => ({ ...d, quantity: e.target.value }))}
                                                    onFocus={(e) => e.target.select()}
                                                />
                                                <button
                                                    type="button"
                                                    className="qty-btn"
                                                    onClick={() => setEditDraft((d) => ({
                                                        ...d,
                                                        quantity: String(Math.round((normalizeQty(d.quantity, 1) + 1) * 100) / 100),
                                                    }))}
                                                >
                                                    +
                                                </button>
                                            </div>
                                        </div>
                                        <div className="form-group" style={{ gridColumn: 'span 2' }}>
                                            <label className="label" htmlFor={`edit-reason-${r.id}`}>Reason</label>
                                            <select
                                                id={`edit-reason-${r.id}`}
                                                className="input"
                                                value={reasonSelectValue(editDraft.reason)}
                                                onChange={(e) => setEditDraft((d) => ({ ...d, reason: e.target.value }))}
                                            >
                                                <option value="">Select reason…</option>
                                                {SHRINK_REASONS.map((opt) => (
                                                    <option key={opt.code} value={opt.label}>{opt.label}</option>
                                                ))}
                                            </select>
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        <button type="button" className="btn btn-sm btn-green" disabled={busy} onClick={() => saveEdit(r.id)}>SAVE</button>
                                        <button type="button" className="btn btn-sm btn-secondary" disabled={busy} onClick={cancelEdit}>CANCEL</button>
                                        <button type="button" className="btn btn-sm" style={{ borderColor: '#f66', color: '#f66' }} disabled={busy} onClick={() => voidLine(r)}>VOID LINE</button>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                                        <strong>{r.sku}</strong>
                                        {r.status && r.status !== 'Open' ? (
                                            <span style={{ fontSize: '0.7rem', color: r.status === 'Closed' ? '#0f8' : '#f90' }}>{r.status}</span>
                                        ) : null}
                                    </div>
                                    {r.item || r.description ? <div>{r.item || r.description}</div> : null}
                                    <small style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 4 }}>
                                        <span>
                                            {r.department ? `${r.department} · ` : ''}
                                            qty {r.quantity}
                                            {r.reason ? ` · ${r.reason}` : ''}
                                            {r.line_retail != null || r.line_cost != null
                                                ? ` · retail ${moneyLabel(r.line_retail)} · cost ${moneyLabel(r.line_cost)}`
                                                : ' · no catalog price'}
                                            {' · '}{r.logged_by}
                                            {' · '}{String(r.time_logged || '').slice(11, 16)}
                                        </span>
                                        {!locked ? (
                                            <>
                                                <button type="button" className="btn btn-sm btn-secondary" style={{ padding: '2px 10px' }} onClick={() => startEdit(r)}>
                                                    EDIT
                                                </button>
                                                <button type="button" className="btn btn-sm" style={{ padding: '2px 10px', borderColor: '#f66', color: '#f66' }} onClick={() => voidLine(r)}>
                                                    VOID
                                                </button>
                                            </>
                                        ) : null}
                                    </small>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
