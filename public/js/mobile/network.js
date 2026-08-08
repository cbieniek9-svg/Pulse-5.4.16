// ── 4. NETWORK ────────────────────────────────────────────────────────────────

/**
 * Base POST helper. Always checks res.ok, always parses JSON safely.
 * Throws a proper Error with the server's message on failure.
 */
async function postJson(url, body) {
    if (typeof TgpApi !== 'undefined') return TgpApi.postJson(url, body, currentToken);
    const fullUrl = url.startsWith('/') ? API_BASE + url : url;
    const payload = { ...body, token: currentToken };
    const res = await fetch(fullUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
    });
    if (!res.ok) {
        let msg = `Request failed (${res.status})`;
        try { const d = await res.json(); msg = d.error || msg; } catch (_) {}
        const err = new Error(msg);
        err.status = res.status;
        if (res.status === 401) handleSessionExpired();
        throw err;
    }
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : { success: true };
}

/** Remove closed/deleted rows locally so DONE feels instant; SSE delta reconciles. */
function applyOptimisticAction(table, action, data, id_col, id_val) {
    if (!fullData) return false;
    if (action === 'update' && (data?.status === 'Closed' || data?.status === 'Complete')) {
        if (table === 'tasks' && id_col === 'task_id' && id_val != null) {
            fullData.tasks = (fullData.tasks || []).filter((t) => String(t.task_id) !== String(id_val));
            if (String(id_val).startsWith('AUTO-PULL-')) {
                const killId = String(id_val).slice('AUTO-PULL-'.length);
                fullData.kill_dates = (fullData.kill_dates || []).filter((k) => String(k.id) !== killId);
                if (Array.isArray(fullData.kill_warnings)) {
                    fullData.kill_warnings = fullData.kill_warnings.filter((w) => String(w.id) !== killId);
                }
            }
            renderData();
            return true;
        }
        if (table === 'oos' && id_col === 'oos_id' && id_val != null) {
            fullData.oos = (fullData.oos || []).filter((o) => String(o.oos_id) !== String(id_val));
            renderData();
            return true;
        }
        if (table === 'special_orders' && id_col === 'order_id' && id_val != null) {
            fullData.orders = (fullData.orders || []).filter((o) => String(o.order_id) !== String(id_val));
            renderData();
            return true;
        }
    }
    if (action === 'delete' && table === 'tasks' && id_col === 'task_id' && id_val != null) {
        fullData.tasks = (fullData.tasks || []).filter((t) => String(t.task_id) !== String(id_val));
        renderData();
        return true;
    }
    if (action === 'delete' && table === 'ticker' && id_col === 'msg_id' && id_val != null) {
        fullData.ticker = (fullData.ticker || []).filter((t) => String(t.msg_id) !== String(id_val));
        renderData();
        return true;
    }
    if (action === 'insert' && table === 'ticker' && data?.msg_id) {
        if (!Array.isArray(fullData.ticker)) fullData.ticker = [];
        fullData.ticker.push({ msg_id: data.msg_id, message: data.message || '' });
        renderData();
        return true;
    }
    return false;
}

/** Trigger an API action; quick closes update UI immediately without blocking on full sync. @returns {Promise<boolean>} */
async function api(table, action, data, id_col, id_val, ev = null) {
    if (!navigator.onLine) {
        offlineQueue.push({ _qid: genId('Q'), table, action, data, id_col, id_val });
        try { localStorage.setItem('tgp_offline_queue', JSON.stringify(offlineQueue)); } catch (_) {}
        showNotice('Offline — action queued.', 'info', 'OFFLINE');
        return false;
    }
    const btn = (ev?.target || ev?.currentTarget)?.closest('button');
    if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
    const optimistic = applyOptimisticAction(table, action, data, id_col, id_val);
    try {
        await postJson('/api/action', { table, action, data, id_col, id_val, userContext: getUserCtx() });
        if (!optimistic) await sync(true);
        return true;
    } catch (err) {
        if (optimistic) void sync(true);
        showNotice(err.message, 'error', 'ERROR');
        return false;
    } finally {
        if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
}

/** Sync state from server. Guarded against concurrent calls; forced syncs queue if one is already running. */
async function sync(force = false) {
    if (!currentUser || !navigator.onLine) return;
    if (force && postTypingTimer) {
        clearTimeout(postTypingTimer);
        postTypingTimer = null;
        pendingDeltaRender = false;
        deferredSyncAfterTyping = false;
    }
    if (!force && Date.now() - lastInputTime < TYPING_QUIET_MS) return;
    if (syncInFlight) {
        if (force) queuedForceSync = true;
        return;
    }
    syncInFlight = true;
    try {
        const r = await fetch(API_BASE + '/api/sync', { headers: { 'x-session-token': currentToken } });
        if (r.status === 401 || r.status === 403) {
            handleSessionExpired();
            return;
        }
        if (!r.ok) {
            console.error('[SYNC] Server returned', r.status);
            setConnStatus(false);
            showNotice('Sync failed — showing last known data.', 'error', 'SYNC');
            return;
        }
        const data = await r.json();
        if (currentToken && data.sessionActive === false) {
            handleSessionExpired();
            return;
        }
        if (data?.staff) { fullData = data; refreshLiveShiftKpis(); renderData(); }
    } catch (e) {
        console.error('[SYNC] Failed:', e.message);
        setConnStatus(false);
        showNotice('Sync failed — check connection.', 'error', 'SYNC');
    } finally {
        syncInFlight = false;
        if (queuedForceSync) {
            queuedForceSync = false;
            void sync(true);
        }
    }
}

/** Settings that must not revive a cleaned store day after EOD / finish. */
const OFFLINE_DROP_SETTINGS = new Set(['Order_Start', 'Order_End', 'Active_Manager', 'Hardware_Arrived']);

function persistOfflineQueue() {
    try {
        if (offlineQueue.length) localStorage.setItem('tgp_offline_queue', JSON.stringify(offlineQueue));
        else localStorage.removeItem('tgp_offline_queue');
    } catch (_) { /* storage full / private mode */ }
}

/** Replay queued offline actions sequentially when connectivity returns */
async function replayOfflineQueue() {
    if (!offlineQueue.length || !navigator.onLine) return;
    // Replaying with a dead token fails every item and spams the login screen;
    // the queue is kept on disk until someone signs back in.
    if (!currentToken) return;
    if (replayOfflineQueue._busy) return;
    replayOfflineQueue._busy = true;

    showNotice(`Replaying ${offlineQueue.length} offline action(s)…`, 'info');
    let synced = 0;
    let dropped = 0;
    try {
        // Remove only after ACK — clearing the whole queue first lost actions on crash mid-loop.
        while (offlineQueue.length) {
            const item = offlineQueue[0];
            if (item.table === 'settings' && OFFLINE_DROP_SETTINGS.has(String(item.id_val || ''))) {
                offlineQueue.shift();
                persistOfflineQueue();
                dropped += 1;
                continue;
            }
            try {
                await postJson('/api/action', { ...item, userContext: getUserCtx() });
                offlineQueue.shift();
                persistOfflineQueue();
                synced += 1;
            } catch (e) {
                console.error('[OFFLINE REPLAY]', e.message);
                showNotice(`${offlineQueue.length} action(s) failed to sync`, 'error');
                break;
            }
        }
        if (!offlineQueue.length) {
            showNotice(
                dropped
                    ? `Offline actions synced (${dropped} stale clock/lead setting(s) dropped)`
                    : 'Offline actions synced',
                'success',
            );
        } else if (synced) {
            showNotice(`${synced} synced, ${offlineQueue.length} still queued`, 'info');
        }
        await sync(true);
    } finally {
        replayOfflineQueue._busy = false;
    }
}
window.addEventListener('online', replayOfflineQueue);

async function downloadProtectedFile(url, filename) {
    try {
        const res = await fetch(API_BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: currentToken }) });
        if (!res.ok) throw new Error('Download failed');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(await res.blob());
        a.download = filename;
        a.click();
        showNotice('File downloaded', 'success');
    } catch (e) { showNotice(e.message, 'error'); }
}
