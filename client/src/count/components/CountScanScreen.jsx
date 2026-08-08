import { useEffect, useId, useRef, useState } from 'react';
import RecentScanCard from './RecentScanCard.jsx';
import { beepScanOk, RECENT_LIMIT } from '../countUtils.js';
import { normalizeScannedCode } from '../../lib/cameraUtils.js';

function LastScanBanner({ upc, quantity, visible }) {
    const meta = upc
        ? `Qty ×${quantity} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : '';
    return (
        <div className={`last-scan-banner ${visible ? 'show' : ''}`} aria-live="polite">
            <div className="ls-label">SCANNED</div>
            <div className="ls-upc">{upc || '—'}</div>
            <div className="ls-meta">{meta}</div>
        </div>
    );
}

export default function CountScanScreen({
    activeSession,
    recentScans,
    scanStatus,
    submitting,
    camera,
    qtyRef,
    scanAcceptedRef,
    pendingUpcRef,
    onShowHome,
    onSubmitScan,
    onDeleteLine,
    onExport,
    onPrint,
    onCloseLocation,
    onFinalizeOrder,
    onCloseBackstock,
    onOpenDetail,
}) {
    const sessionType = activeSession?.session_type || 'location';
    const caseOnly = sessionType === 'backstock' || sessionType === 'order';
    const [upc, setUpc] = useState('');
    const [qty, setQty] = useState('1');
    const [uom, setUom] = useState(caseOnly ? 'case' : '');
    const [pendingUpc, setPendingUpc] = useState('');
    const [typeMode, setTypeMode] = useState(false);
    const [lastScan, setLastScan] = useState({ upc: '', quantity: 1, show: false });
    const upcRef = useRef(null);
    const qtyPromptRef = useRef(null);
    const recentListRef = useRef(null);
    const readerId = useId().replace(/:/g, '');
    const snapReaderId = useId().replace(/:/g, '');

    useEffect(() => {
        qtyRef.current = qty;
    }, [qty, qtyRef]);

    const focusUpcSilent = () => {
        const el = upcRef.current;
        if (!el || typeMode) return;
        // Readonly + inputMode=none keeps wedge working without soft keyboard
        el.focus({ preventScroll: true });
    };

    useEffect(() => {
        focusUpcSilent();
        camera.updateCameraHints();
        setUom(caseOnly ? 'case' : '');
    }, [activeSession?.id]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const onFocusOut = (e) => {
            if (pendingUpc) return;
            if (typeMode) return;
            if (e.target !== upcRef.current) return;
            setTimeout(() => {
                if (camera.cameraOn) return;
                const active = document.activeElement;
                if (!active) return focusUpcSilent();
                if (active === qtyPromptRef.current) return;
                if (active.tagName === 'BUTTON' || active.tagName === 'A') return;
                if (active === upcRef.current) return;
                focusUpcSilent();
            }, 0);
        };
        document.addEventListener('focusout', onFocusOut);
        return () => document.removeEventListener('focusout', onFocusOut);
    }, [camera.cameraOn, pendingUpc, typeMode]);

    const showScanAccepted = (scanUpc, quantity) => {
        setLastScan({ upc: scanUpc, quantity, show: false });
        requestAnimationFrame(() => {
            setLastScan({ upc: scanUpc, quantity, show: true });
        });
        camera.flashCameraPanel();
        beepScanOk();
    };

    useEffect(() => {
        if (!scanAcceptedRef) return undefined;
        scanAcceptedRef.current = showScanAccepted;
        return () => { scanAcceptedRef.current = null; };
    });

    const openQtyPrompt = (scanUpc) => {
        const code = normalizeScannedCode(scanUpc);
        if (!code) return;
        if (!caseOnly && (uom !== 'case' && uom !== 'unit')) {
            window.alert('Select Case or Unit before scanning.');
            return;
        }
        setUpc('');
        setPendingUpc(code);
        setQty('1');
        requestAnimationFrame(() => {
            qtyPromptRef.current?.focus({ preventScroll: true });
            try { qtyPromptRef.current?.select(); } catch (_) { /* ignore */ }
        });
    };

    useEffect(() => {
        if (!pendingUpcRef) return undefined;
        pendingUpcRef.current = openQtyPrompt;
        return () => { pendingUpcRef.current = null; };
    });

    const cancelQtyPrompt = () => {
        setPendingUpc('');
        setQty('1');
        focusUpcSilent();
    };

    const confirmQty = async (e) => {
        if (e) e.preventDefault();
        if (!pendingUpc || submitting) return;
        const scanUom = caseOnly ? 'case' : uom;
        if (!caseOnly && (scanUom !== 'case' && scanUom !== 'unit')) {
            window.alert('Select Case or Unit before adding.');
            return;
        }
        const ok = await onSubmitScan(pendingUpc, qty, { showScanAccepted, uom: scanUom });
        if (ok) {
            setPendingUpc('');
            setQty('1');
            recentListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            focusUpcSilent();
        }
    };

    const handleUpcSubmit = (e) => {
        if (e) e.preventDefault();
        openQtyPrompt(upc);
    };

    const handleSnapChange = async (ev) => {
        const file = ev.target.files?.[0];
        ev.target.value = '';
        if (file) await camera.onSnapBarcode(file);
    };

    const statusClass = scanStatus.ok === true ? 'status-ok' : scanStatus.ok === false ? 'status-err' : '';
    const title = sessionType === 'backstock'
        ? 'BACKSTOCK SCAN (CASES)'
        : (sessionType === 'order' ? 'ORDER DRAFT SCAN (CASES)' : 'LOCATION COUNT SCAN');
    const uomReady = caseOnly || uom === 'case' || uom === 'unit';

    return (
        <div className="container">
            <div className="header">
                <div>
                    <div className="title">{title}</div>
                    <div className="loc-badge">{activeSession?.location || '—'}</div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={onShowHome}>
                    HOME
                </button>
            </div>

            <div className="add-box">
                <div className="camera-toolbar">
                    <button type="button" className="btn btn-warn btn-sm" onClick={camera.toggleCamera}>
                        {camera.cameraOn ? 'STOP CAMERA' : 'LIVE CAMERA'}
                    </button>
                    <label className="btn btn-secondary btn-sm" htmlFor="cam-snap-input" style={{ display: 'inline-block', margin: 0 }}>
                        SNAP BARCODE
                    </label>
                    <input
                        id="cam-snap-input"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        style={{ display: 'none' }}
                        onChange={handleSnapChange}
                    />
                    {camera.showTorchHint ? (
                        <button type="button" className="btn btn-secondary btn-sm" disabled>
                            POINT AT BARCODE
                        </button>
                    ) : null}
                </div>
                {camera.httpsHintHtml ? (
                    <p
                        className="hint"
                        style={{ color: '#f90' }}
                        dangerouslySetInnerHTML={{ __html: camera.httpsHintHtml }}
                    />
                ) : null}
                <div
                    className={`camera-panel ${camera.panelVisible ? '' : 'view-hidden'} ${camera.scanFlash ? 'scan-flash' : ''}`}
                    style={camera.panelVisible ? undefined : { display: 'none' }}
                >
                    <div
                        ref={(el) => {
                            camera.scannerRef.current = el;
                            if (el && !el.id) el.id = `camera-reader-${readerId}`;
                        }}
                        className="camera-reader"
                    />
                </div>
                <div
                    ref={(el) => {
                        camera.snapReaderRef.current = el;
                        if (el && !el.id) el.id = `snap-reader-${snapReaderId}`;
                    }}
                    style={{ width: 1, height: 1, overflow: 'hidden', opacity: 0, position: 'absolute', left: -9999 }}
                    aria-hidden="true"
                />

                <LastScanBanner upc={lastScan.upc} quantity={lastScan.quantity} visible={lastScan.show} />

                <div className="section-label" style={{ marginTop: 8 }}>UNIT OF MEASURE</div>
                {caseOnly ? (
                    <p className="hint" style={{ marginTop: 0 }}>This walk is case-only.</p>
                ) : (
                    <div className="qty-row" style={{ gap: 8, marginBottom: 8 }}>
                        <button
                            type="button"
                            className={`btn ${uom === 'case' ? 'btn-warn' : 'btn-secondary'}`}
                            style={{ flex: 1 }}
                            onClick={() => setUom('case')}
                        >
                            CASE
                        </button>
                        <button
                            type="button"
                            className={`btn ${uom === 'unit' ? 'btn-warn' : 'btn-secondary'}`}
                            style={{ flex: 1 }}
                            onClick={() => setUom('unit')}
                        >
                            UNIT
                        </button>
                    </div>
                )}
                {!caseOnly && !uomReady ? (
                    <p className="hint" style={{ color: '#f90' }}>Select Case or Unit before scanning.</p>
                ) : null}

                {pendingUpc ? (
                    <form id="qty-prompt-form" autoComplete="off" onSubmit={confirmQty} className="qty-prompt">
                        <div className="field-label">ENTER QTY ({caseOnly ? 'CASE' : String(uom).toUpperCase()})</div>
                        <div className="ls-upc" style={{ marginBottom: 8 }}>{pendingUpc}</div>
                        <label className="field-label" htmlFor="qty-prompt-input">Quantity</label>
                        <input
                            ref={qtyPromptRef}
                            id="qty-prompt-input"
                            className="input"
                            type="number"
                            inputMode="numeric"
                            min="1"
                            step="1"
                            value={qty}
                            onChange={(e) => setQty(e.target.value)}
                            autoFocus
                        />
                        <div className="qty-row" style={{ marginTop: 8 }}>
                            <button type="submit" className="btn btn-warn" disabled={submitting} style={{ flex: 1 }}>
                                ADD ×{qty || '1'}
                            </button>
                            <button type="button" className="btn btn-secondary" onClick={cancelQtyPrompt} disabled={submitting}>
                                CANCEL
                            </button>
                        </div>
                    </form>
                ) : (
                    <form id="scan-form" autoComplete="off" onSubmit={handleUpcSubmit}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                            <label className="field-label" htmlFor="upc-input" style={{ margin: 0 }}>UPC</label>
                            <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                    setTypeMode((v) => {
                                        const next = !v;
                                        requestAnimationFrame(() => {
                                            if (next) {
                                                upcRef.current?.removeAttribute('readonly');
                                                upcRef.current?.focus();
                                            } else {
                                                focusUpcSilent();
                                            }
                                        });
                                        return next;
                                    });
                                }}
                            >
                                {typeMode ? 'SCAN MODE' : 'TYPE UPC'}
                            </button>
                        </div>
                        <input
                            ref={upcRef}
                            id="upc-input"
                            className="input"
                            type="text"
                            inputMode={typeMode ? 'numeric' : 'none'}
                            readOnly={!typeMode}
                            enterKeyHint="done"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            placeholder={typeMode ? 'Type UPC then Enter' : 'Scan barcode (keyboard stays closed)'}
                            value={upc}
                            onChange={(e) => setUpc(e.target.value)}
                        />
                        <button
                            type="submit"
                            className="btn btn-warn"
                            id="scan-btn"
                            style={{ width: '100%', marginTop: 8 }}
                            disabled={submitting || !upc.trim() || !uomReady}
                        >
                            NEXT → QTY
                        </button>
                    </form>
                )}
                <div className="status-bar">
                    <span>{`Session ${String(activeSession?.id || '').slice(0, 10)}…`}</span>
                    <span className={statusClass}>{scanStatus.msg}</span>
                </div>
                <p className="hint">
                    {caseOnly
                        ? 'Scan cases → enter qty → add.'
                        : 'Select Case or Unit → scan → enter qty → add.'}
                </p>
            </div>

            <div className="section-label">RECENT SCANS</div>
            <div ref={recentListRef}>
                {recentScans.length ? (
                    recentScans.slice(0, RECENT_LIMIT).map((s, idx) => (
                        <RecentScanCard
                            key={s.id}
                            scan={s}
                            isLatest={idx === 0}
                            onDelete={onDeleteLine}
                        />
                    ))
                ) : (
                    <div className="empty">No scans yet.</div>
                )}
            </div>

            <div className="actions">
                {sessionType === 'location' && typeof onCloseLocation === 'function' ? (
                    <button type="button" className="btn btn-warn" style={{ width: '100%' }} onClick={onCloseLocation}>
                        CLOSE LOCATION COUNT
                    </button>
                ) : null}
                {sessionType === 'location' && typeof onPrint === 'function' ? (
                    <button type="button" className="btn btn-secondary" style={{ width: '100%', marginTop: 8 }} onClick={onPrint}>
                        PRINT LOCATION COUNT
                    </button>
                ) : null}
                <button type="button" className="btn" style={{ width: '100%', marginTop: 8 }} onClick={onExport}>
                    {sessionType === 'order' ? 'EXPORT RAW DRAFT CSV' : 'EXPORT CSV'}
                </button>
                {sessionType === 'backstock' && typeof onCloseBackstock === 'function' ? (
                    <button type="button" className="btn btn-warn" style={{ width: '100%', marginTop: 8 }} onClick={onCloseBackstock}>
                        CLOSE &amp; COMMIT TO MEMORY
                    </button>
                ) : null}
                {sessionType === 'order' && typeof onFinalizeOrder === 'function' ? (
                    <button type="button" className="btn btn-warn" style={{ width: '100%', marginTop: 8 }} onClick={onFinalizeOrder}>
                        FINALIZE ORDER (PICK LIST + CLEAN ORDER)
                    </button>
                ) : null}
                <button type="button" className="btn btn-secondary" style={{ width: '100%', marginTop: 8 }} onClick={onOpenDetail}>
                    VIEW / EDIT ALL LINES
                </button>
            </div>
        </div>
    );
}
