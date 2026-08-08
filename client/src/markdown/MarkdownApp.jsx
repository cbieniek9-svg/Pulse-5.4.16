import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { fetchJson, getSync } from '../lib/api.js';
import { postAction } from '../lib/actions.js';
import { captureStationDeviceTokenFromUrl, getStationDeviceToken } from '../lib/stationDeviceToken.js';
import { usePortalStream } from '../lib/usePortalStream.js';
import useBarcodeCamera from '../lib/useBarcodeCamera.js';
import { beepScanOk, normalizeScannedCode } from '../lib/cameraUtils.js';
import { linkAlias, lookupItem, searchItems } from '../lib/itemCatalogApi.js';
import PortalBackBar from '../components/shared/PortalBackBar.jsx';
import BarcodeCameraPanel from '../components/shared/BarcodeCameraPanel.jsx';

import MarkdownImportPanels from './MarkdownImportPanels.jsx';
import MarkdownShrinkPanel from './MarkdownShrinkPanel.jsx';
import MarkdownArchivePanel from './MarkdownArchivePanel.jsx';
import MarkdownItemsPanel from './MarkdownItemsPanel.jsx';

const TABS = ['fifo', 'shrink', 'archive', 'items'];
const TAB_TITLES = {
    fifo: 'FIFO EXPIRY AUDIT',
    shrink: 'FLOOR SHRINK BY SKU',
    archive: 'MARKDOWN ARCHIVE',
    items: 'STORE ITEM LIST',
};

const KILL_DATE_ZONES = [
    'Dairy', 'Bakery', 'Produce', 'Freezer',
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'Pop', 'Water', 'Jerry', 'Seasonal', 'General',
];

function normalizeQty(raw) {
    let n = parseInt(String(raw ?? ''), 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    return n;
}

function zoneFromAisle(aisle) {
    const n = parseInt(String(aisle || '').trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 'General';
    const label = `A${n}`;
    return KILL_DATE_ZONES.includes(label) ? label : 'General';
}

export default function MarkdownApp() {
    const { token, user } = useAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const [data, setData] = useState(null);
    const [batchRows, setBatchRows] = useState([]);
    const [aisle, setAisle] = useState('');
    const [itemCode, setItemCode] = useState('');
    const [itemName, setItemName] = useState('');
    const [killDate, setKillDate] = useState('');
    const [zone, setZone] = useState('General');
    const [qty, setQty] = useState('1');
    const [toast, setToast] = useState('');
    const [live, setLive] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const tabParam = searchParams.get('tab');
    const tab = TABS.includes(tabParam) ? tabParam : 'fifo';
    const [scanTypeMode, setScanTypeMode] = useState(false);
    const [scanStatus, setScanStatus] = useState({ msg: '', ok: null });
    const [dupHint, setDupHint] = useState(null);
    const [submitError, setSubmitError] = useState('');
    const [archiveRefresh, setArchiveRefresh] = useState(0);
    const [catalogHit, setCatalogHit] = useState(null);
    const [nameSuggestions, setNameSuggestions] = useState([]);
    const itemNameRef = useRef(null);
    const itemCodeRef = useRef(null);

    useEffect(() => { captureStationDeviceTokenFromUrl('markdown'); }, []);

    const setTab = (next) => {
        const params = new URLSearchParams(searchParams);
        if (next === 'fifo') params.delete('tab');
        else params.set('tab', next);
        setSearchParams(params, { replace: true });
    };

    const sync = useCallback(async () => {
        if (!token) return;
        try {
            const payload = await getSync(token);
            setData(payload);
        } catch (_) { /* retry on next poll/stream */ }
    }, [token]);

    useEffect(() => { sync(); }, [sync]);
    usePortalStream({
        token,
        tables: ['kill_dates'],
        onEvent: () => { sync(); setArchiveRefresh((n) => n + 1); },
        onOpen: () => setLive(true),
    });

    const showToast = (msg) => {
        setToast(msg);
        setTimeout(() => setToast(''), 2200);
    };

    const lookupDuplicates = useCallback(async (code, opts = {}) => {
        if (!token || !String(code || '').trim()) return null;
        const params = new URLSearchParams({ item_code: String(code).trim() });
        if (opts.item) params.set('item', opts.item);
        if (opts.zone) params.set('zone', opts.zone);
        if (opts.kill_date) params.set('kill_date', opts.kill_date);
        try {
            return await fetchJson(`/api/markdown/archive/lookup?${params}`, {
                cache: 'no-store',
                headers: { 'x-session-token': token },
            });
        } catch (_) {
            return null;
        }
    }, [token]);

    // Refs keep onDecode stable: html5-qrcode captures the callback when the camera starts.
    const cameraRef = useRef(null);
    const itemNameValueRef = useRef('');
    useEffect(() => { itemNameValueRef.current = itemName; }, [itemName]);
    // The description we filled in last, so a name the user typed can be told apart from
    // one the catalog supplied, and the last code we resolved, so scanning the same tag
    // twice does not fight with an edit made in between.
    const autoNameRef = useRef('');
    const resolvedCodeRef = useRef('');

    /**
     * Resolve a code against the item catalog and the kill-date history.
     * Used by the camera, the wedge scanner, and manual typing alike.
     *
     * A description belongs to the code it was filled in for, so scanning a different
     * code replaces it rather than leaving the previous item's name sitting in the
     * field. Text the user typed themselves only gives way to a real catalog name.
     */
    const resolveCode = useCallback(async (code) => {
        const clean = normalizeScannedCode(code);
        if (!clean) return;
        // Wedge scanners often keep a leading 0; rewrite the field to match the shelf tag.
        if (clean !== String(code || '').trim()) setItemCode(clean);

        const isNewCode = resolvedCodeRef.current !== clean;
        resolvedCodeRef.current = clean;

        let nameNow = itemNameValueRef.current;
        const typedByHand = nameNow.trim() !== '' && nameNow !== autoNameRef.current;
        const applyName = (name) => {
            nameNow = name;
            autoNameRef.current = name;
            setItemName(name);
            setNameSuggestions([]);
        };

        const item = await lookupItem(token, clean);
        setCatalogHit(item);
        if (item?.description && (isNewCode || !nameNow.trim())) {
            applyName(item.description);
        } else if (isNewCode && !typedByHand && nameNow.trim()) {
            // Nothing on file for this code, so the name we filled in for the last one
            // would quietly mislabel it.
            applyName('');
        }
        if (item?.zone) setZone(item.zone);

        const lookup = await lookupDuplicates(clean);
        if (lookup && lookup.matches?.length) {
            setDupHint({ code: clean, ...lookup });
            const prior = lookup.active?.[0] || lookup.matches[0];
            if (prior?.item && !nameNow.trim()) applyName(prior.item);
            if (prior?.zone && !item?.zone) setZone(prior.zone);
        } else {
            setDupHint(null);
        }
    }, [token, lookupDuplicates]);

    const onBarcodeDecoded = useCallback(async (code) => {
        const clean = normalizeScannedCode(code);
        if (!clean) return;
        setItemCode(clean);
        setDupHint(null);
        setCatalogHit(null);
        beepScanOk();
        cameraRef.current?.flashCameraPanel();
        setScanStatus({ msg: `Scanned ${clean}`, ok: true });
        // Each FIFO row still needs a date entered, so hand the screen back to the
        // form instead of leaving the video feed under the soft keyboard.
        await cameraRef.current?.stopCamera();
        requestAnimationFrame(() => itemNameRef.current?.focus({ preventScroll: true }));
        await resolveCode(clean);
    }, [resolveCode]);

    const onScanStatus = useCallback((msg, ok) => setScanStatus({ msg, ok }), []);

    const camera = useBarcodeCamera({
        onDecode: onBarcodeDecoded,
        onStatus: onScanStatus,
        portalPath: '/markdown',
    });
    cameraRef.current = camera;

    useEffect(() => {
        if (tab !== 'fifo' && camera.cameraOn) camera.stopCamera();
    }, [tab, camera.cameraOn]); // eslint-disable-line react-hooks/exhaustive-deps

    // Typed or wedge-scanned codes resolve on their own once entry settles.
    useEffect(() => {
        const code = itemCode.trim();
        if (code.length < 4) {
            setCatalogHit(null);
            return undefined;
        }
        const t = setTimeout(() => { resolveCode(code); }, 400);
        return () => clearTimeout(t);
    }, [itemCode, resolveCode]);

    /**
     * Picking a suggestion after a scan missed tells us exactly which product the
     * barcode belongs to, so record the link now instead of hoping the description
     * gets typed identically to the one on file.
     */
    const pickSuggestion = useCallback(async (item) => {
        setItemName(item.description);
        autoNameRef.current = item.description;
        setNameSuggestions([]);
        if (item.zone) setZone(item.zone);

        const scanned = normalizeScannedCode(itemCode);
        if (!scanned) {
            setItemCode(item.raw_code || item.code);
            setCatalogHit(item);
            return;
        }
        if (scanned === item.code) {
            setCatalogHit(item);
            return;
        }
        try {
            const res = await linkAlias(token, scanned, item.code);
            setCatalogHit(res?.item || { ...item, matched_via: 'alias' });
            setScanStatus({ msg: `${scanned} linked to ${item.description}`, ok: true });
        } catch (_) {
            setCatalogHit(item);
        }
    }, [itemCode, token]);

    // When the code is unknown, offer matching descriptions already in the catalog.
    useEffect(() => {
        const q = itemName.trim();
        if (catalogHit || q.length < 3) {
            setNameSuggestions([]);
            return undefined;
        }
        const t = setTimeout(async () => {
            const { rows } = await searchItems(token, q, 6);
            setNameSuggestions(rows);
        }, 400);
        return () => clearTimeout(t);
    }, [itemName, catalogHit, token]);

    const addToBatch = async () => {
        if (!itemName.trim() || !killDate) return showToast('Need description and expiration date');
        if (!itemCode.trim()) return showToast('Vendor code required (shelf tag)');
        const row = {
            item: itemName.trim(),
            item_code: itemCode.trim(),
            zone: zone || zoneFromAisle(aisle),
            kill_date: killDate,
            quantity: normalizeQty(qty),
        };
        const dupInBatch = batchRows.some((r) =>
            String(r.item_code || '').trim().toLowerCase() === row.item_code.toLowerCase()
            && r.kill_date === row.kill_date
            && r.zone === row.zone);
        if (dupInBatch && !window.confirm('Same vendor code + date already in this batch. Add anyway?')) return;
        const lookup = await lookupDuplicates(row.item_code, {
            item: row.item,
            zone: row.zone,
            kill_date: row.kill_date,
        });
        if (lookup?.risk === 'active') {
            const a = lookup.active[0];
            const ok = window.confirm(
                `Already ACTIVE on the board: ${a?.item || row.item} (${a?.item_code || row.item_code}) · ${a?.zone || ''} · ${a?.kill_date || ''}.\n\nAdd another row anyway?`,
            );
            if (!ok) return;
        } else if (lookup?.risk === 'same_date' || lookup?.risk === 'archived') {
            const m = (lookup.same_date?.[0] || lookup.archived?.[0] || lookup.matches?.[0]);
            const ok = window.confirm(
                `Found in archive (${m?.status}): ${m?.item || row.item} · ${m?.item_code || row.item_code} · ${m?.kill_date || ''}.\n\nContinue?`,
            );
            if (!ok) return;
        }
        setBatchRows((rows) => [...rows, row]);
        setItemName('');
        setItemCode('');
        setKillDate('');
        setQty('1');
        setDupHint(null);
        setCatalogHit(null);
        setNameSuggestions([]);
        autoNameRef.current = '';
        resolvedCodeRef.current = '';
        setScanStatus({ msg: '', ok: null });
        showToast(`Added — batch now ${batchRows.length + 1}`);
    };

    const submitBatch = async () => {
        if (!batchRows.length) return;
        setSubmitting(true);
        setSubmitError('');
        const pending = [...batchRows];
        let saved = 0;
        let failure = '';
        // Drop rows as they land so a mid-batch failure cannot re-save the earlier ones.
        for (const row of pending) {
            const id = `K-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
            try {
                await postAction({
                    table: 'kill_dates',
                    action: 'insert',
                    data: {
                        id,
                        item: row.item,
                        item_code: row.item_code,
                        zone: row.zone,
                        kill_date: row.kill_date,
                        quantity: normalizeQty(row.quantity),
                        status: 'Active',
                    },
                    token,
                    deviceToken: token ? '' : getStationDeviceToken('markdown'),
                });
                saved += 1;
                setBatchRows((rows) => rows.filter((r) => r !== row));
            } catch (e) {
                failure = e.message || 'Submit failed';
                break;
            }
        }
        setSubmitting(false);
        setArchiveRefresh((n) => n + 1);
        await sync();
        if (failure) {
            setSubmitError(
                saved
                    ? `Saved ${saved} row(s), then failed: ${failure}. The rest are still queued below.`
                    : `Nothing saved: ${failure}`,
            );
        } else {
            showToast(`Saved ${saved} row(s) to the board`);
        }
    };

    const markKillSold = async (id) => {
        if (!window.confirm('Mark this item as sold through?')) return;
        try {
            await postAction({
                table: 'kill_dates',
                action: 'update',
                data: { status: 'Closed' },
                id_col: 'id',
                id_val: id,
                token,
                deviceToken: token ? '' : getStationDeviceToken('markdown'),
            });
            showToast('Item cleared from expiry board.');
            await sync();
        } catch (e) {
            showToast(e.message);
        }
    };

    const board = useMemo(() => {
        if (!data) return null;
        const today = data.storeDate || '';
        const active = (data.kill_dates || []).filter((k) => k.status === 'Active');
        const warnings = data.kill_warnings || [];
        const pull = active.filter((k) => k.kill_date && today && k.kill_date <= today);
        const warn = warnings.filter((w) => !pull.some((p) => p.id === w.id));
        return { pull, warn };
    }, [data]);

    const setAisleChip = (n) => {
        setAisle(String(n));
        setZone(zoneFromAisle(n));
    };

    return (
        <div className="markdown-portal container">
            <PortalBackBar />
            <main id="main" className="markdown-main">
            <div className="sticky-top">
                <div className="header">
                    <div>
                        <div className="title">{TAB_TITLES[tab]}</div>
                        {tab === 'fifo' && batchRows.length ? <span className="badge">BATCH: {batchRows.length}</span> : null}
                    </div>
                    <div className="meta">
                        <strong>{user}</strong>
                        {live ? <span className="badge live">LIVE</span> : null}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: 8, padding: '0 0 10px', flexWrap: 'wrap' }}>
                    <button type="button" className={`aisle-chip ${tab === 'fifo' ? 'active' : ''}`} onClick={() => setTab('fifo')}>FIFO</button>
                    <button type="button" className={`aisle-chip ${tab === 'shrink' ? 'active' : ''}`} onClick={() => setTab('shrink')}>SHRINK</button>
                    <button type="button" className={`aisle-chip ${tab === 'archive' ? 'active' : ''}`} onClick={() => setTab('archive')}>ARCHIVE</button>
                    <button type="button" className={`aisle-chip ${tab === 'items' ? 'active' : ''}`} onClick={() => setTab('items')}>ITEMS</button>
                </div>
            </div>

            {toast ? <div className="toast show">{toast}</div> : null}

            {tab === 'shrink' ? (
                <MarkdownShrinkPanel token={token} showToast={showToast} />
            ) : tab === 'archive' ? (
                <MarkdownArchivePanel token={token} showToast={showToast} refreshKey={archiveRefresh} />
            ) : tab === 'items' ? (
                <MarkdownItemsPanel token={token} />
            ) : (
            <>
            <div className="entry-card">
                <p className="notice-msg" style={{ margin: '0 0 14px 0' }}>
                    Walk the aisle: tap aisle → LIVE CAMERA or TYPE CODE → item → date → qty → Add to batch.
                </p>
                <div className="form-group">
                    <label className="label" htmlFor="md-aisle">Aisle #</label>
                    <div className="aisle-row">
                        {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                            <button
                                key={n}
                                type="button"
                                className={`aisle-chip ${String(aisle) === String(n) ? 'active' : ''}`}
                                onClick={() => setAisleChip(n)}
                            >
                                A{n}
                            </button>
                        ))}
                    </div>
                    <input id="md-aisle" className="input" type="number" min="1" max="99" value={aisle} onChange={(e) => { setAisle(e.target.value); setZone(zoneFromAisle(e.target.value)); }} />
                </div>
                <div className="form-group">
                    <label className="label" htmlFor="md-vendor-code">Vendor / barcode</label>
                    <BarcodeCameraPanel
                        camera={camera}
                        status={scanStatus}
                        buttonClass="btn btn-sm"
                        typeMode={scanTypeMode}
                        onToggleTypeMode={() => {
                            setScanTypeMode((v) => {
                                const next = !v;
                                requestAnimationFrame(() => {
                                    if (next) itemCodeRef.current?.focus();
                                });
                                return next;
                            });
                        }}
                    />
                    <input
                        ref={itemCodeRef}
                        id="md-vendor-code"
                        className="input"
                        value={itemCode}
                        onChange={(e) => { setItemCode(e.target.value); setDupHint(null); setCatalogHit(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); resolveCode(itemCode); } }}
                        inputMode={scanTypeMode ? 'numeric' : 'none'}
                        enterKeyHint="done"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        placeholder={scanTypeMode ? 'Type vendor code / UPC, then Enter' : 'Scan barcode (keyboard stays closed)'}
                    />
                    {catalogHit ? (
                        <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: '#0f8', textTransform: 'none' }}>
                            Known item: <strong>{catalogHit.description || '(no description on file)'}</strong>
                            {catalogHit.matched_via === 'alias' ? ` — linked to code ${catalogHit.code}` : ''}
                            {catalogHit.times_seen ? ` · logged ${catalogHit.times_seen}×` : ''}
                        </p>
                    ) : itemCode.trim().length >= 4 ? (
                        <p style={{ margin: '8px 0 0', fontSize: '0.78rem', color: '#888', textTransform: 'none' }}>
                            Not on file yet — start typing the description to pick it off the item
                            list, or just type it in. Either way this code is remembered next time.
                        </p>
                    ) : null}
                    {dupHint ? (
                        <div
                            className="notice-card"
                            style={{
                                marginTop: 10,
                                marginBottom: 0,
                                borderLeftColor: dupHint.risk === 'active' ? '#f66' : '#f90',
                                textTransform: 'none',
                            }}
                        >
                            <div style={{ color: dupHint.risk === 'active' ? '#f66' : '#f90', fontWeight: 700, fontSize: '0.8rem' }}>
                                {dupHint.risk === 'active' ? 'ALREADY ON THE BOARD' : 'SEEN BEFORE IN ARCHIVE'}
                            </div>
                            {dupHint.matches.slice(0, 4).map((m) => (
                                <div key={m.id} style={{ fontSize: '0.78rem', color: '#ccc', marginTop: 4 }}>
                                    {m.status} · {m.item || '(no description)'} · {m.zone || 'General'} · {m.kill_date || '—'}
                                    {m.logged_by ? ` · by ${m.logged_by}` : ''}
                                </div>
                            ))}
                            {dupHint.matches.length > 4 ? (
                                <div style={{ fontSize: '0.72rem', color: '#888', marginTop: 4 }}>
                                    +{dupHint.matches.length - 4} more — see the ARCHIVE tab
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
                <div className="form-group">
                    <label className="label" htmlFor="md-item-name">Item description</label>
                    <input ref={itemNameRef} id="md-item-name" className="input" value={itemName} onChange={(e) => setItemName(e.target.value)} autoComplete="off" />
                    {nameSuggestions.length ? (
                        <div style={{ marginTop: 8 }}>
                            <div style={{ fontSize: '0.72rem', color: '#888', marginBottom: 4 }}>FROM THE ITEM LIST</div>
                            {nameSuggestions.map((s) => (
                                <button
                                    key={s.code}
                                    type="button"
                                    className="btn btn-sm"
                                    style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, textTransform: 'none' }}
                                    onClick={() => pickSuggestion(s)}
                                >
                                    {s.description} <span style={{ color: '#888' }}>· {s.raw_code || s.code}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
                <div className="row-3">
                    <div className="form-group">
                        <label className="label" htmlFor="md-kill-date">Expiration date</label>
                        <input id="md-kill-date" className="input" type="date" value={killDate} onChange={(e) => setKillDate(e.target.value)} />
                    </div>
                    <div className="form-group">
                        <label className="label" htmlFor="md-zone">Zone</label>
                        <select id="md-zone" className="input" value={zone} onChange={(e) => setZone(e.target.value)}>
                            {KILL_DATE_ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
                        </select>
                    </div>
                    <div className="form-group">
                        <label className="label" htmlFor="md-qty">Qty on shelf</label>
                        <div className="qty-stepper">
                            <button type="button" className="qty-btn" onClick={() => setQty(String(Math.max(1, normalizeQty(qty) - 1)))}>−</button>
                            <input id="md-qty" className="input" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
                            <button type="button" className="qty-btn" onClick={() => setQty(String(normalizeQty(qty) + 1))}>+</button>
                        </div>
                    </div>
                </div>
            </div>

            {submitError ? (
                <div
                    className="notice-card"
                    style={{ borderLeftColor: '#f66', textTransform: 'none' }}
                    role="alert"
                >
                    <div style={{ color: '#f66', fontWeight: 700, fontSize: '0.8rem' }}>SUBMIT FAILED</div>
                    <div style={{ fontSize: '0.85rem', color: '#eee', marginTop: 6 }}>{submitError}</div>
                    <div style={{ fontSize: '0.78rem', color: '#aaa', marginTop: 6 }}>
                        If it says your session expired, sign back in — the queued rows below are kept.
                    </div>
                    <button type="button" className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setSubmitError('')}>DISMISS</button>
                </div>
            ) : null}

            {batchRows.length ? (
                <div id="batch-queue">
                    <div className="label">Queued rows</div>
                    {batchRows.map((r, i) => (
                        <div className="batch-item" key={`${r.item_code}-${i}`}>
                            <div className="batch-item-text">{r.item}</div>
                            <div className="batch-item-meta">{r.item_code} · {r.zone} · {r.kill_date} · qty {r.quantity}</div>
                            <button type="button" className="btn btn-red btn-sm" onClick={() => setBatchRows((rows) => rows.filter((_, idx) => idx !== i))}>REMOVE</button>
                        </div>
                    ))}
                </div>
            ) : null}

            <MarkdownImportPanels
                token={token}
                showToast={showToast}
                onImported={sync}
                onBatchAdd={(row) => {
                    setBatchRows((rows) => [...rows, {
                        item: row.item,
                        item_code: row.item_code,
                        zone: row.zone || 'General',
                        kill_date: row.kill_date,
                        quantity: normalizeQty(row.quantity),
                    }]);
                }}
            />

            <details className="collapsible" open>
                <summary>▸ Live expiry board</summary>
                <div className="notice-card" style={{ marginTop: 8, borderLeftColor: 'var(--green)' }}>
                    <div style={{ textTransform: 'none', fontSize: '0.9rem', maxHeight: 240, overflowY: 'auto', color: '#ddd' }}>
                        {!board ? <div style={{ opacity: 0.65 }}>Loading…</div> : null}
                        {board && !board.pull.length && !board.warn.length ? (
                            <div style={{ opacity: 0.65 }}>No active expiry on the board yet.</div>
                        ) : null}
                        {board?.pull.length ? (
                            <>
                                <div style={{ color: '#f66', fontWeight: 'bold', marginBottom: 6 }}>PULL TODAY ({board.pull.length})</div>
                                {board.pull.map((k) => (
                                    <div key={k.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(168,85,247,0.15)' }}>
                                        <strong style={{ color: '#f66' }}>{k.zone || 'General'}</strong> {k.item}
                                        <br />
                                        <small>{k.kill_date} · qty {normalizeQty(k.quantity)}</small>
                                    </div>
                                ))}
                            </>
                        ) : null}
                        {board?.warn.length ? (
                            <>
                                <div style={{ color: '#f90', fontWeight: 'bold', margin: '12px 0 6px' }}>7-DAY ({board.warn.length})</div>
                                {board.warn.slice(0, 12).map((k) => (
                                    <div key={k.id} style={{ padding: '8px 0', borderBottom: '1px solid rgba(168,85,247,0.15)' }}>
                                        <strong style={{ color: '#f90' }}>{k.zone || 'General'}</strong> {k.item}
                                        <br />
                                        <small>{k.kill_date} · qty {normalizeQty(k.quantity)}</small>
                                        <br />
                                        <button type="button" className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => markKillSold(k.id)}>SOLD THROUGH</button>
                                    </div>
                                ))}
                            </>
                        ) : null}
                    </div>
                </div>
            </details>

            <div className="sticky-actions" style={{ display: 'flex' }}>
                <button type="button" className="btn btn-green" onClick={addToBatch}>ADD TO BATCH</button>
                <button type="button" className="btn" disabled={!batchRows.length || submitting} onClick={submitBatch}>
                    {submitting ? 'SUBMITTING…' : `SUBMIT (${batchRows.length})`}
                </button>
            </div>
            </>
            )}
            </main>
        </div>
    );
}
