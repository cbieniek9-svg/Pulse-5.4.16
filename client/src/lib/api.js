const API_HOST = 'http://127.0.0.1:3001';

export function apiBase() {
    if (typeof window !== 'undefined' && window.location?.protocol === 'file:') return API_HOST;
    return '';
}

export function resolveUrl(url) {
    if (/^https?:\/\//i.test(url)) return url;
    const base = apiBase();
    return url.startsWith('/') ? base + url : url;
}

/**
 * AuthProvider registers its logout here so a dead session returns every portal to
 * the login screen, rather than leaving stale data on screen behind a raw error.
 * @type {null | (() => void)}
 */
let sessionExpiredHandler = null;

export function onSessionExpired(fn) {
    sessionExpiredHandler = typeof fn === 'function' ? fn : null;
}

/** Operator-facing copy for stable API error codes (backup / EOD / reports). */
const OPERATOR_ERROR_COPY = {
    EOD_BUSY: 'End-of-day is already running. Wait for it to finish, then retry.',
    EOD_POST_BACKUP_REQUIRED:
        'Store day purge finished, but the post-purge backup failed. Retry EOD or backup before relying on this store day.',
    EOD_PRE_BACKUP_REQUIRED: 'Pre-purge backup failed. End-of-day did not run.',
    EOD_BACKUP_INCOMPLETE: 'End-of-day backup incomplete. Retry before relying on this store day.',
    BACKUP_SOURCE_UNAVAILABLE:
        'Selected backup could not be opened. Reports were not switched to live data.',
    BACKUP_VERIFICATION_FAILED: 'Backup verification failed. A verified copy was not produced.',
    BACKUP_PACKAGE_IO_FAILED: 'Backup package could not be written.',
    INVENTORY_PERMISSION_REQUIRED:
        'Inventory count permission required. Ask a manager to grant Inventory in Settings → Staff.',
    INVENTORY_SESSION_LOCKED:
        'This count session is locked. Reopen it before editing lines or scanning.',
};

/**
 * Format an API failure for notices/toasts: always prefer `CODE: message` when a code exists.
 * @param {{ message?: string, code?: string } | Error | null | undefined} err
 * @param {string} [fallback]
 */
export function formatApiError(err, fallback = 'Request failed') {
    const code = err?.code ? String(err.code) : '';
    const raw = (err?.message && String(err.message).trim()) || fallback;
    const friendly = code ? OPERATOR_ERROR_COPY[code] : '';
    const generic = !err?.message
        || /^Request failed/i.test(raw)
        || /^Download failed/i.test(raw)
        || /^Export failed/i.test(raw)
        || /^HTTP \d+/i.test(raw);
    const body = (generic && friendly) ? friendly : raw;
    if (code && !body.includes(code)) return `${code}: ${body}`;
    return body;
}

/**
 * Build an Error carrying the HTTP status and API `code`, and trip the session handler on 401.
 * Use from any call site that reads a raw Response (blob downloads, exports).
 */
export async function httpError(res, fallback) {
    let msg = fallback || `Request failed (${res.status})`;
    let code = null;
    try {
        const d = await res.json();
        code = d.code || null;
        msg = d.error || d.message || msg;
        if (!(d.error || d.message) && code && OPERATOR_ERROR_COPY[code]) {
            msg = OPERATOR_ERROR_COPY[code];
        }
    } catch (_) {
        try { msg = (await res.text()) || msg; } catch (_) { /* body already consumed */ }
    }
    const err = new Error(formatApiError({ message: msg, code }, msg));
    err.status = res.status;
    if (code) err.code = code;
    // 401 means the session is gone. 403 means signed in without permission,
    // which must not sign the user out.
    if (res.status === 401 && sessionExpiredHandler) {
        try { sessionExpiredHandler(); } catch (_) { /* handler must not mask the error */ }
    }
    return err;
}

export async function fetchJson(url, options = {}) {
    const res = await fetch(resolveUrl(url), options);
    if (!res.ok) throw await httpError(res);
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : { success: true };
}

export async function mobileAuth(name, pin) {
    const cleanName = String(name ?? '').trim().replace(/\s+/g, ' ');
    const cleanPin = String(pin ?? '').trim();
    return fetchJson('/api/mobile-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cleanName, pin: cleanPin }),
    });
}

export async function getSync(token = '') {
    const headers = {};
    if (token) headers['x-session-token'] = token;
    return fetchJson('/api/sync', { headers });
}

export async function getReady() {
    return fetchJson('/api/ready');
}

/** Best-effort server-side revoke on sign-out; the client clears its token either way. */
export function revokeSession(token) {
    if (!token) return Promise.resolve();
    return fetchJson('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-session-token': token },
        body: JSON.stringify({ token }),
    }).catch(() => { /* signing out locally regardless */ });
}

export function filterLoginStaff(syncData) {
    const staff = syncData?.staff || [];
    const settings = syncData?.settings || {};
    const unassignedEnabled = syncData?.features?.unassignedLogin !== false && settings.Unassigned_Option_Enabled !== '0';
    return staff.filter((s) => {
        if (!unassignedEnabled && s.name === 'Unassigned') return false;
        return true;
    });
}
