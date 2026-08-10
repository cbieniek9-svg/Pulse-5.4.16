import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { getSync, resolveUrl } from '../lib/api.js';
import { postAction } from '../lib/actions.js';
import { captureStationDeviceTokenFromUrl, getStationDeviceToken } from '../lib/stationDeviceToken.js';
import { usePortalStream } from '../lib/usePortalStream.js';
import PortalBackBar from '../components/shared/PortalBackBar.jsx';
import PalletPanel from './PalletPanel.jsx';
import TimeEditPanel from './TimeEditPanel.jsx';
import StoreTransfersPanel from './StoreTransfersPanel.jsx';
import { addDays, downloadBlob, fmtTime, isTgpVendor } from './recUtils.js';

const REC_STREAM_TABLES = ['expected_orders', 'tasks', 'receiving_pallets'];

export default function RecApp() {
    const { token, user } = useAuth();
    const [data, setData] = useState(null);
    const [error, setError] = useState('');
    const [adhocVendor, setAdhocVendor] = useState('');
    const [maintDate, setMaintDate] = useState('');
    const [histLog, setHistLog] = useState([]);
    const [histBusy, setHistBusy] = useState(false);
    const [busyId, setBusyId] = useState('');
    const [activeTab, setActiveTab] = useState('freight');
    const [workFlags, setWorkFlags] = useState({});
    const [clockFlags, setClockFlags] = useState({});
    const [actionError, setActionError] = useState('');
    const [confirmAsk, setConfirmAsk] = useState(null);
    const [outFor, setOutFor] = useState('');
    const [outInvoice, setOutInvoice] = useState('');
    const [outStorage, setOutStorage] = useState(false);
    const maintDateRef = useRef('');
    const streamSyncTimer = useRef(null);
    const loadGen = useRef(0);
    const confirmResolve = useRef(null);

    useEffect(() => { captureStationDeviceTokenFromUrl('receiving'); }, []);
    useEffect(() => { maintDateRef.current = maintDate; }, [maintDate]);

    /**
     * The dock runs in Electron and on kiosk Chromebooks, where window.prompt is
     * unsupported and confirm/alert can be muted by "prevent additional dialogs".
     * Every prompt on this screen is drawn in-page so a click can never no-op.
     */
    const askConfirm = useCallback((message) => new Promise((resolve) => {
        confirmResolve.current?.(false);
        confirmResolve.current = resolve;
        setConfirmAsk({ message });
    }), []);

    const answerConfirm = useCallback((ok) => {
        confirmResolve.current?.(ok);
        confirmResolve.current = null;
        setConfirmAsk(null);
    }, []);

    const storeTransfersEnabled = !!(data?.features?.storeTransfers || data?.settings?.Store_Transfers_Enabled === '1');

    const sync = useCallback(async () => {
        if (!token) return;
        try {
            const payload = await getSync(token);
            setData(payload);
            setError('');
            // Default editable day once — do not put maintDate in deps (avoids sync identity churn).
            if (!maintDateRef.current && payload.storeDate) {
                maintDateRef.current = payload.storeDate;
                setMaintDate(payload.storeDate);
            }
        } catch (e) {
            setError(e.message || 'Sync failed');
        }
    }, [token]);

    const loadDayLog = useCallback(async (date, { quiet = false } = {}) => {
        if (!token || !date) return;
        const gen = ++loadGen.current;
        setHistBusy(true);
        try {
            const res = await fetch(resolveUrl(`/api/receiving/day-log?date=${encodeURIComponent(date)}`), {
                headers: { 'x-session-token': token || '' },
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || 'Could not load day log');
            if (gen !== loadGen.current) return; // stale response
            setHistLog(json.rows || []);
        } catch (e) {
            if (gen !== loadGen.current) return;
            setHistLog([]);
            if (!quiet) alert(e.message);
        } finally {
            if (gen === loadGen.current) setHistBusy(false);
        }
    }, [token]);

    useEffect(() => { void sync(); }, [sync]);

    useEffect(() => {
        if (!maintDate || !token) return;
        void loadDayLog(maintDate);
    }, [maintDate, token, loadDayLog]);

    // Debounced live refresh — never tear the stream down for each tick.
    const onStreamEvent = useCallback(() => {
        if (streamSyncTimer.current) clearTimeout(streamSyncTimer.current);
        streamSyncTimer.current = setTimeout(() => {
            void sync();
            const date = maintDateRef.current;
            if (date) void loadDayLog(date, { quiet: true });
        }, 400);
    }, [sync, loadDayLog]);

    useEffect(() => () => {
        if (streamSyncTimer.current) clearTimeout(streamSyncTimer.current);
    }, []);

    usePortalStream({ token, tables: REC_STREAM_TABLES, onEvent: onStreamEvent });

    const refreshLog = useCallback(async () => {
        // Reload the day log first; dock sync is secondary (avoids save → sync → stream → sync storms).
        if (maintDate) await loadDayLog(maintDate, { quiet: true });
        void sync();
    }, [sync, maintDate, loadDayLog]);

    const api = useCallback(async (table, action, actionData, id_col, id_val) => {
        return postAction({
            table,
            action,
            data: actionData,
            id_col,
            id_val,
            token,
            deviceToken: token ? '' : getStationDeviceToken('receiving'),
        });
    }, [token]);

    const markTimeIn = async (expId) => {
        setActionError('');
        if (!(await askConfirm('Log TIME IN for this vendor?'))) return;
        setBusyId(expId);
        try {
            await api('expected_orders', 'receiving_mark_arrived', {}, 'exp_id', expId);
            await sync();
        } catch (e) {
            setActionError(e.message || 'Could not log time in.');
        } finally {
            setBusyId('');
        }
    };

    const removePending = async (expId) => {
        setActionError('');
        if (!(await askConfirm('Remove this pending delivery? Use for duplicates / ghost vendors only.'))) return;
        setBusyId(expId);
        try {
            await api('expected_orders', 'update', { status: 'Archived' }, 'exp_id', expId);
            await sync();
        } catch (e) {
            setActionError(e.message || 'Could not remove that delivery.');
        } finally {
            setBusyId('');
        }
    };

    const cancelTimeOut = () => {
        setBusyId('');
        setOutFor('');
        setOutInvoice('');
        setOutStorage(false);
    };

    const openTimeOut = (row, isTgp) => {
        setActionError('');
        if (isTgp && !row?.pallet_count) {
            setActionError('Log at least one TGP pallet before time out.');
            return;
        }
        setOutFor(row.exp_id);
        setOutInvoice(row.invoice_ref || '');
        setOutStorage(false);
    };

    const submitTimeOut = async (expId, isTgp) => {
        if (isTgp && !outStorage) {
            setActionError('Confirm the truck is received and perishables are stored before time out.');
            return;
        }
        setActionError('');
        setBusyId(expId);
        try {
            await api('expected_orders', 'receiving_mark_departed', {
                invoice_ref: outInvoice.trim(),
                create_task: workFlags[expId] !== false ? '1' : '0',
                start_order_clock: isTgp && clockFlags[expId] ? '1' : '0',
                storage_confirmed: isTgp ? '1' : undefined,
            }, 'exp_id', expId);
            cancelTimeOut();
            await sync();
        } catch (e) {
            setActionError(e.message || 'Could not time out this vendor.');
        } finally {
            setBusyId('');
        }
    };

    const logAdhoc = async () => {
        const vendor = adhocVendor.trim();
        setActionError('');
        if (!vendor) {
            setActionError('Enter vendor name.');
            return;
        }
        if (!(await askConfirm(`Log TIME IN for ${vendor}?`))) return;
        setBusyId('adhoc');
        try {
            await api('expected_orders', 'receiving_log_arrival', {
                vendor,
                expected_day: data?.storeDate || '',
            });
            setAdhocVendor('');
            await sync();
        } catch (e) {
            setActionError(e.message || 'Could not log that arrival.');
        } finally {
            setBusyId('');
        }
    };

    const fetchExport = async (path, printWindow) => {
        const res = await fetch(resolveUrl(path), { headers: { 'x-session-token': token || '' } });
        if (!res.ok) {
            let msg = 'Export failed';
            try { const d = await res.json(); msg = d.error || msg; } catch (_) {
                try { msg = await res.text(); } catch (_) {}
            }
            throw new Error(msg);
        }
        const fmt = path.includes('format=csv') ? 'csv' : 'print';
        if (fmt === 'csv') {
            downloadBlob(await res.blob(), path.includes('cold-chain') ? `TGP_Cold_Chain_${maintDate}.csv` : `REC_${maintDate}.csv`);
            return;
        }
        const html = await res.text();
        const win = printWindow && !printWindow.closed ? printWindow : window.open('', '_blank');
        if (!win) throw new Error('Popup blocked. Allow popups and try again.');
        win.document.open();
        win.document.write(html);
        win.document.close();
        try { win.focus(); } catch (_) {}
    };

    const openRecLog = async (format) => {
        const printWindow = format === 'print' ? window.open('', '_blank') : null;
        if (printWindow) {
            printWindow.document.write('<!doctype html><title>Receiving Log</title><body style="font-family:Arial,sans-serif;margin:24px">Loading…</body>');
            printWindow.document.close();
        }
        try {
            await fetchExport(`/api/export/receiving-file-maintenance?date=${encodeURIComponent(maintDate)}&format=${format}`, printWindow);
        } catch (e) {
            alert(e.message);
        }
    };

    const openColdChain = async (format) => {
        const printWindow = format === 'print' ? window.open('', '_blank') : null;
        if (printWindow) {
            printWindow.document.write('<!doctype html><title>TGP Cold Chain</title><body style="font-family:Arial,sans-serif;margin:24px">Loading…</body>');
            printWindow.document.close();
        }
        try {
            await fetchExport(`/api/export/tgp-cold-chain?start=${encodeURIComponent(maintDate)}&end=${encodeURIComponent(maintDate)}&format=${format}`, printWindow);
        } catch (e) {
            alert(e.message);
        }
    };

    const pending = (data?.expected || []).filter((e) => e.status === 'Pending');
    const onDock = data?.receiving_on_dock || [];
    const editLog = (histLog || []).filter((e) => e.arrived_at);
    const vendors = data?.receiving_vendor_options || [];
    const departments = data?.receiving_pallet_departments || [];

    return (
        <div className="rec-portal container" data-pulse-surface="rec">
            <PortalBackBar />
            <main id="main" className="rec-main" style={{ minHeight: '70vh' }}>
            <div className="header">
                <div>
                    <div className="title">{activeTab === 'transfers' ? 'STORE TRANSFERS' : 'INBOUND FREIGHT'}</div>
                    <div style={{ fontSize: '0.72em', color: '#888', marginTop: 4 }}>
                        {activeTab === 'transfers'
                            ? 'Receiving Chromebook · LOOKUP DOCS · GENERATE INVOICE + MANIFEST'
                            : `Receiving Chromebook · SCAN TGP PALLETS → TIME IN / OUT · ${data?.storeDate || ''}`}
                    </div>
                </div>
                <div style={{ fontSize: '0.8em', color: '#f90' }}>{user}</div>
            </div>

            <div className="rec-tabs">
                <button type="button" className={`rec-tab ${activeTab === 'freight' ? 'active' : ''}`} onClick={() => setActiveTab('freight')}>FREIGHT</button>
                {storeTransfersEnabled ? (
                    <button type="button" className={`rec-tab ${activeTab === 'transfers' ? 'active' : ''}`} onClick={() => setActiveTab('transfers')}>STORE TRANSFERS</button>
                ) : null}
            </div>

            {error ? <div style={{ color: '#f33', marginBottom: 12 }}>{error}</div> : null}
            {actionError ? (
                <div className="rec-action-error" role="alert">
                    <span>{actionError}</span>
                    <button type="button" className="btn btn-secondary btn-small" onClick={() => setActionError('')}>DISMISS</button>
                </div>
            ) : null}

            {!data ? (
                <div style={{ minHeight: 520, padding: 24, color: '#b0b0b0', textAlign: 'center' }} aria-busy="true">
                    Loading receiving dock…
                </div>
            ) : activeTab === 'transfers' ? (
                <StoreTransfersPanel token={token} storeDate={data?.storeDate} enabled={storeTransfersEnabled} />
            ) : (
                <>
                    <div className="section-label">EXPECTED TODAY</div>
                    {pending.length ? pending.map((e) => (
                        <div className="card" key={e.exp_id}>
                            <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '1.15em' }}>{e.vendor}</div>
                            <div className="card-meta">
                                Scheduled · {e.expected_day || 'today'}
                                {isTgpVendor(e.vendor) ? ' · TGP — log pallets after time in' : ''}
                            </div>
                            <div className="card-actions">
                                <button type="button" className="btn" disabled={busyId === e.exp_id} onClick={() => markTimeIn(e.exp_id)}>{busyId === e.exp_id ? '…' : 'TIME IN'}</button>
                                <button type="button" className="btn btn-remove" disabled={busyId === e.exp_id} onClick={() => removePending(e.exp_id)}>REMOVE</button>
                            </div>
                        </div>
                    )) : <div style={{ textAlign: 'center', padding: 24, color: '#b0b0b0' }}>NO PENDING DELIVERIES</div>}

                    <div className="section-label">ON DOCK (TIME IN, NO TIME OUT YET)</div>
                    {data?.receiving_on_dock_error ? (
                        <div style={{ textAlign: 'center', padding: 24, color: '#f44', border: '1px solid #f44' }}>
                            DOCK UNAVAILABLE — {data.receiving_on_dock_error}
                        </div>
                    ) : onDock.length ? onDock.map((e) => {
                        const tgp = isTgpVendor(e.vendor);
                        return (
                            <div className="card on-dock" key={e.exp_id}>
                                <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '1.15em' }}>{e.vendor}</div>
                                <div className="card-meta">
                                    TIME IN {fmtTime(e.arrived_at)} · {e.arrived_by || ''}
                                    {e.pallet_count ? ` · ${e.pallet_count} pallet(s)` : ''}
                                </div>
                                <TimeEditPanel entry={e} token={token} showDeparted={false} showInvoice={false} onSaved={sync} />
                                {tgp ? (
                                    <PalletPanel expId={e.exp_id} entry={e} departments={departments} storeDate={data?.storeDate} token={token} onChanged={sync} askConfirm={askConfirm} setActionError={setActionError} />
                                ) : null}
                                <label className="chk">
                                    <input
                                        type="checkbox"
                                        checked={workFlags[e.exp_id] !== false}
                                        onChange={(ev) => setWorkFlags((f) => ({ ...f, [e.exp_id]: ev.target.checked }))}
                                    />
                                    {tgp ? 'Post Work the TGP order to All Staff' : 'Post work order to board'}
                                </label>
                                {tgp ? (
                                    <label className="chk">
                                        <input
                                            type="checkbox"
                                            checked={!!clockFlags[e.exp_id]}
                                            onChange={(ev) => setClockFlags((f) => ({ ...f, [e.exp_id]: ev.target.checked }))}
                                        />
                                        Start DRY order clock (off by default — grocery only; frozen is manual)
                                    </label>
                                ) : null}
                                {outFor === e.exp_id ? (
                                    <div className="time-out-confirm">
                                        <label htmlFor={`rec-out-inv-${e.exp_id}`}>INVOICE / REF # (OPTIONAL)</label>
                                        <input
                                            id={`rec-out-inv-${e.exp_id}`}
                                            className="input"
                                            type="text"
                                            maxLength={120}
                                            placeholder="Leave blank if not available"
                                            value={outInvoice}
                                            onChange={(ev) => setOutInvoice(ev.target.value)}
                                        />
                                        {tgp ? (
                                            <label className="chk">
                                                <input
                                                    type="checkbox"
                                                    checked={outStorage}
                                                    onChange={(ev) => setOutStorage(ev.target.checked)}
                                                />
                                                Truck fully received and all perishables stored properly
                                            </label>
                                        ) : null}
                                        <div className="card-actions">
                                            <button type="button" className="btn btn-out" disabled={busyId === e.exp_id} onClick={() => submitTimeOut(e.exp_id, tgp)}>
                                                {busyId === e.exp_id ? 'SAVING…' : 'CONFIRM TIME OUT'}
                                            </button>
                                            <button type="button" className="btn btn-secondary" disabled={busyId === e.exp_id} onClick={cancelTimeOut}>CANCEL</button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="card-actions">
                                        <button type="button" className="btn btn-out" disabled={busyId === e.exp_id} onClick={() => openTimeOut(e, tgp)}>TIME OUT</button>
                                    </div>
                                )}
                            </div>
                        );
                    }) : <div style={{ textAlign: 'center', padding: 24, color: '#b0b0b0' }}>NO TRUCKS ON DOCK</div>}

                    <div className="section-label">REC LOG (EDIT TIMES + PALLETS)</div>
                    <p className="hint" style={{ margin: '-4px 0 10px' }}>
                        Pick a date to correct time in/out, invoice, or TGP pallet plate/dept/temp — including after time out.
                        Use yesterday (or any past day) for trucks already timed out.
                    </p>
                    <div className="add-box file-maint-box" style={{ marginBottom: 14 }}>
                        <label className="hint" htmlFor="rec-maint-date" style={{ display: 'block', marginBottom: 6 }}>Receiving log date</label>
                        <input id="rec-maint-date" className="input" type="date" value={maintDate} onChange={(ev) => setMaintDate(ev.target.value)} />
                        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ flex: 1 }}
                                disabled={!data?.storeDate}
                                onClick={() => setMaintDate(addDays(data.storeDate, -1))}
                            >
                                YESTERDAY
                            </button>
                            <button
                                type="button"
                                className="btn btn-secondary"
                                style={{ flex: 1 }}
                                disabled={!data?.storeDate}
                                onClick={() => setMaintDate(data.storeDate)}
                            >
                                TODAY
                            </button>
                        </div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => openRecLog('print')}>PRINT REC LOG</button>
                            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => openRecLog('csv')}>CSV</button>
                            <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={() => openColdChain('print')}>PRINT COLD CHAIN</button>
                            <button type="button" className="btn" style={{ flex: 1 }} onClick={() => openColdChain('csv')}>COLD CHAIN CSV</button>
                        </div>
                    </div>
                    {histBusy ? <div className="hint">Loading day log…</div> : null}
                    {editLog.length ? (
                        editLog.map((e) => {
                            const tgp = isTgpVendor(e.vendor);
                            return (
                                <div className={`card ${e.status === 'Arrived' && !e.departed_at ? 'on-dock' : ''}`} key={`log-${e.exp_id}-${maintDate}`}>
                                    <div style={{ color: '#fff', fontWeight: 'bold' }}>{e.vendor}</div>
                                    <div className="card-meta">
                                        {maintDate} · {e.status} · IN {fmtTime(e.arrived_at)} · OUT {fmtTime(e.departed_at)} · {e.departed_by || e.arrived_by || ''}
                                        {e.invoice_ref ? ` · ${e.invoice_ref}` : ''}
                                    </div>
                                    <TimeEditPanel key={e.exp_id} entry={e} token={token} showDeparted showInvoice onSaved={refreshLog} />
                                    {tgp ? (
                                        <PalletPanel
                                            expId={e.exp_id}
                                            entry={e}
                                            departments={departments}
                                            storeDate={maintDate || data?.storeDate}
                                            token={token}
                                            onChanged={refreshLog}
                                            askConfirm={askConfirm}
                                            setActionError={setActionError}
                                            allowCorrection
                                        />
                                    ) : null}
                                </div>
                            );
                        })
                    ) : (
                        <div style={{ textAlign: 'center', padding: 24, color: '#b0b0b0' }}>
                            {maintDate ? `NO ARRIVALS LOGGED FOR ${maintDate}` : 'PICK A DATE'}
                        </div>
                    )}

                    <div className="add-box">
                        <div className="section-label" style={{ marginTop: 0 }}>ADD VENDOR ARRIVAL</div>
                        <input className="input" list="vendor-options" placeholder="Vendor name" aria-label="Vendor name" value={adhocVendor} onChange={(ev) => setAdhocVendor(ev.target.value)} />
                        <datalist id="vendor-options">{vendors.map((v) => <option key={v} value={v} />)}</datalist>
                        <button type="button" className="btn btn-warn" style={{ width: '100%', marginTop: 10 }} disabled={busyId === 'adhoc'} onClick={logAdhoc}>LOG TIME IN</button>
                    </div>
                </>
            )}
            </main>
            {confirmAsk ? (
                <div className="confirm-backdrop" role="presentation" style={{ display: 'flex' }}>
                    <div className="confirm-panel" role="dialog" aria-modal="true">
                        <div className="confirm-header">Confirm</div>
                        <div className="confirm-body">{confirmAsk.message}</div>
                        <div className="confirm-actions">
                            <button type="button" className="btn btn-secondary" onClick={() => answerConfirm(false)}>CANCEL</button>
                            <button type="button" className="btn" onClick={() => answerConfirm(true)}>CONFIRM</button>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
