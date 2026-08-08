// ═══════════════════════════════════════════════════════════════════════════════
// TGP CENTER STORE — MOBILE CLIENT (version: preload __TGP_BUILD__ + /api/sync appVersion)
// ═══════════════════════════════════════════════════════════════════════════════

// ── 1. STATE & CONFIG ─────────────────────────────────────────────────────────

const API_BASE     = (typeof TgpApi !== 'undefined' ? TgpApi.apiBase() : (window.location.protocol === 'file:' ? 'http://127.0.0.1:3001' : ''));
let fullData       = null;
let currentUser    = localStorage.getItem('tgp_user')  || '';
let currentToken   = sessionStorage.getItem('tgp_token') || localStorage.getItem('tgp_token') || '';
if (currentToken && !sessionStorage.getItem('tgp_token')) {
    try { sessionStorage.setItem('tgp_token', currentToken); localStorage.removeItem('tgp_token'); } catch (_) { /* ignore */ }
}
let isAuthed       = !!(currentUser && currentToken);
let lastInputTime  = 0;
let dirtyFields    = new Set();
let offlineQueue   = (() => { try { return JSON.parse(localStorage.getItem('tgp_offline_queue') || '[]'); } catch(_) { return []; } })();
let weatherStr     = '';
let streamHandle   = null;
let sessionKeepaliveTimer = null;
/** Per-vendor receiving checkbox — survives SSE re-renders (exp_id → boolean). */
const recvTaskPrefs = new Map();
let syncInFlight   = false;
let queuedForceSync = false;

/** Auth screen: show build version from Electron preload before logged-in sync runs. */
(function applyPreloadAppVersion() {
    try {
        const v = globalThis.__TGP_BUILD__?.appVersion;
        if (!v) return;
        const el = document.getElementById('app-version-label');
        if (el) el.textContent = `VERSION ${v}`;
    } catch (_) { /* ignore */ }
})();

// ── 2. UTILITIES ──────────────────────────────────────────────────────────────

/** HTML-escape every piece of server data before inserting into the DOM */
const esc = (typeof TgpApi !== 'undefined' ? TgpApi.esc : (v) => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'));

/** Collision-proof ID using crypto.randomUUID (always available in Electron/Chromium) */
const genId = (prefix = '') => {
    const uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return prefix ? `${prefix}-${uid}` : uid;
};

const upperCase    = (v) => String(v ?? '').trim().toUpperCase();
const titleCase    = (v) => String(v ?? '').trim().split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const datestamp    = (d = new Date()) => { const p = new Intl.DateTimeFormat('en-CA').formatToParts(d), v = p.reduce((a,x)=>{ if(x.type!=='literal') a[x.type]=x.value; return a; },{}); return `${v.year}-${v.month}-${v.day}`; };
const storeToday   = () => fullData?.storeDate || datestamp();
let shiftPphTickTimer = null;

function liveOrderPieceTotal(kpis, counts, settings) {
    if (kpis?.shift_total_pieces != null) return kpis.shift_total_pieces;
    if (typeof TgpShiftPph !== 'undefined' && TgpShiftPph.resolveLiveOrderPieces) {
        return TgpShiftPph.resolveLiveOrderPieces(counts || kpis, settings?.Hardware_Arrived);
    }
    const c = counts || {};
    const g = Number(c.grocery || c.g || 0);
    const f = Number(c.frozen || c.f || 0);
    const h = Number(c.hardware || c.h || 0);
    const includeHw = settings?.Hardware_Arrived === '1';
    return g + f + (includeHw ? h : 0);
}

function renderPphKpiTile(k) {
    const pph = k?.shift_active && k.shift_pph != null
        ? k.shift_pph
        : (k?.shift_pph_final != null ? k.shift_pph_final : '—');
    const std = k?.shift_standard_pph || 55;
    const pphLow = k?.shift_active && k.shift_pph != null && k.shift_pph < std;
    const pphEl = $el('k-pph');
    const pphLbl = $el('k-pph-label');
    const pphBox = $el('k-pph-box');
    if (pphLbl) pphLbl.textContent = k?.shift_active ? 'ACTUAL PPH' : 'PPH';
    if (pphEl) {
        pphEl.textContent = String(pph);
        pphEl.style.color = pphLow ? '#f90' : (k?.shift_active && k.shift_pph != null ? '#0f8' : '');
    }
    if (pphBox) {
        pphBox.style.background = pphLow ? 'rgba(42, 26, 10, 0.6)' : 'rgba(11, 26, 46, 0.6)';
        pphBox.style.borderRightColor = pphLow ? '#f90' : '#00e5ff';
    }
}

function refreshLiveShiftKpis() {
    if (!fullData?.kpis?.shift_active || !fullData.settings?.Order_Start) return;
    if (typeof TgpShiftPph === 'undefined') return;
    const k = fullData.kpis;
    const total = liveOrderPieceTotal(k, fullData.counts, fullData.settings);
    const pph = TgpShiftPph.computeLiveShiftPph(fullData.settings.Order_Start, total);
    if (pph == null) return;
    k.shift_pph = pph;
    k.shift_total_pieces = total;
    const startMs = Date.parse(fullData.settings.Order_Start);
    if (Number.isFinite(startMs)) {
        k.shift_elapsed = TgpShiftPph.formatElapsed(Math.round((Date.now() - startMs) / 60000));
    }
    renderPphKpiTile(k);
}

function startShiftPphTicker() {
    if (shiftPphTickTimer) return;
    shiftPphTickTimer = setInterval(() => {
        if (!fullData?.kpis?.shift_active) return;
        refreshLiveShiftKpis();
        if (fullData.staff?.find((s) => s.name === currentUser && (s.role === 'Manager' || s.role === 'Store Manager'))) {
            renderMgrExceptionInbox(fullData);
        }
    }, 30000);
}
const dayName      = (d = new Date()) => new Intl.DateTimeFormat('en-US',{weekday:'long'}).format(d);
/** No background sync / no SSE-driven full re-render until this long after the last text field activity */
const TYPING_QUIET_MS = 30000;

const markInput    = () => { lastInputTime = Date.now(); };
const markDirty    = (id) => { dirtyFields.add(id); markInput(); };
const markSettingsDirty = (el) => {
    const id = el?.id || '';
    if (/^(zsec-|zown-|zname-|slabel-|ssub-|set-|groc|froz|stf|hdw|s-notes)/.test(id)) markDirty(id);
};
const getUserCtx   = () => currentUser ? { name: currentUser, token: currentToken } : null;

/** Any text-like control (including dynamically injected rows) bumps typing idle clock */
(function wireGlobalTypingGuard() {
    const bump = (e) => {
        const t = e.target;
        if (!t || t.disabled) return;
        const tag = (t.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA') { markInput(); return; }
        if (tag === 'SELECT') {
            markSettingsDirty(t);
            markInput();
            return;
        }
        if (tag === 'INPUT') {
            const type = (t.type || '').toLowerCase();
            if (['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'hidden'].includes(type)) return;
            markSettingsDirty(t);
            markInput();
            return;
        }
        if (t.isContentEditable) markInput();
    };
    document.addEventListener('input', bump, true);
    document.addEventListener('change', bump, true);
    document.addEventListener('compositionend', bump, true);
})();

let postTypingTimer     = null;
let pendingDeltaRender  = false;
let deferredSyncAfterTyping = false;

function scheduleTypingAwareFlush() {
    const delay = Math.max(0, TYPING_QUIET_MS - (Date.now() - lastInputTime) + 50);
    if (postTypingTimer) clearTimeout(postTypingTimer);
    postTypingTimer = setTimeout(function arm() {
        postTypingTimer = null;
        if (Date.now() - lastInputTime < TYPING_QUIET_MS) {
            postTypingTimer = setTimeout(arm, TYPING_QUIET_MS - (Date.now() - lastInputTime) + 50);
            return;
        }
        if (deferredSyncAfterTyping) {
            deferredSyncAfterTyping = false;
            pendingDeltaRender = false;
            void sync(true);
            return;
        }
        if (pendingDeltaRender) {
            pendingDeltaRender = false;
            renderData();
        }
    }, delay);
}

function requestDeferredRenderData(urgent = false) {
    if (urgent || Date.now() - lastInputTime >= TYPING_QUIET_MS) {
        renderData();
        return;
    }
    pendingDeltaRender = true;
    scheduleTypingAwareFlush();
}

function requestDeferredSync(urgent = false) {
    if (urgent || Date.now() - lastInputTime >= TYPING_QUIET_MS) {
        void sync(true);
        return;
    }
    deferredSyncAfterTyping = true;
    scheduleTypingAwareFlush();
}

function recvTaskWantTask(expId) {
    if (recvTaskPrefs.has(expId)) return recvTaskPrefs.get(expId);
    return true;
}

window.setRecvTaskPref = (expId, checked) => {
    recvTaskPrefs.set(String(expId), !!checked);
};

function handleSessionExpired() {
    // Several failing requests can land at once after a restart; only bounce out once.
    if (!isAuthed && !currentToken) return;
    sessionStorage.removeItem('tgp_token');
    localStorage.removeItem('tgp_token');
    currentToken = '';
    isAuthed = false;
    streamHandle?.close();
    streamHandle = null;
    if (sessionKeepaliveTimer) {
        clearInterval(sessionKeepaliveTimer);
        sessionKeepaliveTimer = null;
    }
    showNotice('Session expired — please sign in again.', 'error');
    const authScr = $el('auth-screen');
    const appScr = $el('app-screen');
    if (authScr) authScr.style.display = 'flex';
    if (appScr) appScr.style.display = 'none';
    fetchLoginStaff();
}

if (typeof TgpApi !== 'undefined') TgpApi.onSessionExpired(handleSessionExpired);

function startSessionKeepalive() {
    if (sessionKeepaliveTimer) return;
    sessionKeepaliveTimer = setInterval(() => {
        if (!currentToken || document.hidden) return;
        void sync(true);
    }, 4 * 60 * 1000);
}

/** For `<input type="datetime-local">` from server ISO strings */
const isoToDatetimeLocal = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const datetimeLocalToIso = (s) => {
    if (!s || !String(s).trim()) return null;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
};

/** Null-safe element getter */
const $el = (id) => document.getElementById(id);
