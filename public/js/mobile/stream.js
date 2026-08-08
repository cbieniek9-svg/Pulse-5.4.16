// ── 8. SSE STREAM ─────────────────────────────────────────────────────────────

const URGENT_DELTA_TABLES = new Set(['tasks', 'expected_orders', 'oos', 'special_orders', 'kill_dates', 'counts', 'ticker', 'comms_messages']);

function handleDelta(delta) {
    if (!fullData || !delta?.table) { requestDeferredSync(true); return; }
    const { table, action, data, id_col, id_val } = delta;
    const urgent = URGENT_DELTA_TABLES.has(table);
    /** Receiving TIME IN/OUT reshuffles expected vs on-dock lists — always full sync. */
    if (table === 'expected_orders') {
        requestDeferredSync(true);
        return;
    }
    const KEY_MAP = {
        tasks: 'tasks', oos: 'oos', special_orders: 'orders', expected_orders: 'expected',
        staff: 'staff', ticker: 'ticker', shrink_log: 'shrink', kill_dates: 'kill_dates',
        counts: 'counts', settings: 'settings', rhythm_tasks: 'rhythm_tasks',
        vendor_schedule: 'vendor_schedule', staff_shifts: 'staff_shifts', trusted_devices: 'devices',
    };
    const key = KEY_MAP[table];
    if (!key || fullData[key] === undefined) { requestDeferredSync(urgent); return; }
    try {
        if (key === 'counts' || key === 'settings') {
            if (data && typeof data === 'object') Object.assign(fullData[key], data);
        } else if (action === 'insert' && data) {
            if (Array.isArray(fullData[key])) fullData[key].push(data);
        } else if (action === 'update' && id_col && id_val != null) {
            const arr = fullData[key];
            if (Array.isArray(arr)) {
                const idx = arr.findIndex(x => String(x[id_col]) === String(id_val));
                if (idx >= 0) {
                    const terminalTask = key === 'tasks' && data?.status === 'Closed';
                    const terminalKill = key === 'kill_dates' && data?.status && data.status !== 'Active';
                    if (terminalTask) {
                        arr.splice(idx, 1);
                    } else if (terminalKill) {
                        arr.splice(idx, 1);
                        if (Array.isArray(fullData.kill_warnings)) {
                            fullData.kill_warnings = fullData.kill_warnings.filter(
                                (w) => String(w.id) !== String(id_val),
                            );
                        }
                    } else {
                        Object.assign(arr[idx], data);
                    }
                } else if (key === 'tasks') { /* closed/archived row not on open board — ignore */ }
                else if (key === 'staff_shifts' || key === 'devices') { requestDeferredSync(urgent); return; }
                else { requestDeferredSync(urgent); return; }
            }
        } else if (action === 'delete' && id_col && id_val != null) {
            if (Array.isArray(fullData[key])) fullData[key] = fullData[key].filter(x => String(x[id_col]) !== String(id_val));
        } else { requestDeferredSync(urgent); return; }
        requestDeferredRenderData(urgent);
    } catch (e) { console.error('[DELTA]', e.message); requestDeferredSync(true); }
}

function setConnStatus(ok) {
    const dot = $el('conn-dot');
    const txt = $el('conn-text');
    if (dot) {
        dot.style.background = ok ? '#00ff00' : '#ff4444';
        dot.style.boxShadow = ok ? '0 0 8px #00ff00' : '0 0 8px #ff4444';
    }
    if (txt) txt.textContent = ok ? 'SYS: OK' : 'SYS: OFFLINE';
}

function connectStream() {
    if (!currentToken || typeof TgpStream === 'undefined') return;
    streamHandle?.close();
    streamHandle = TgpStream.connect({
        apiBase: API_BASE,
        token: currentToken,
        onEvent(m) {
            if (m?.type === 'REFRESH') requestDeferredSync(true);
            else if (m?.type === 'DELTA') handleDelta(m);
        },
        onOpen() { setConnStatus(true); },
        onError() {
            setConnStatus(false);
            if (currentToken) void sync(true);
        },
    });
}
