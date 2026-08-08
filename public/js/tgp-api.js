/**
 * Shared HTTP client for Command Center portals (mobile, reports, rec, markdown).
 * Single-store: same origin or 127.0.0.1:3001 under file://.
 */
(function (global) {
    'use strict';

    const API_HOST = 'http://127.0.0.1:3001';

    /** Kill-date / markdown zones (keep in sync with markdown-parse.cjs ZONE_CANONICAL). */
    const KILL_DATE_ZONES = [
        'Dairy', 'Bakery', 'Produce', 'Freezer',
        'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
        'Pop', 'Water', 'Jerry', 'Seasonal', 'General',
    ];

    function apiBase() {
        if (global.location?.protocol === 'file:') return API_HOST;
        return '';
    }

    function esc(v) {
        return String(v ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function resolveUrl(url) {
        if (/^https?:\/\//i.test(url)) return url;
        const base = apiBase();
        return url.startsWith('/') ? base + url : url;
    }

    /**
     * Portals register a callback here so a dead session sends the user back to the
     * login screen instead of surfacing "Request failed (401)" on whatever they tapped.
     * @type {null | (() => void)}
     */
    let sessionExpiredHandler = null;

    /** @param {() => void} fn */
    function onSessionExpired(fn) {
        sessionExpiredHandler = typeof fn === 'function' ? fn : null;
    }

    /**
     * @param {string} url
     * @param {RequestInit} [options]
     */
    async function fetchJson(url, options = {}) {
        const res = await fetch(resolveUrl(url), options);
        if (!res.ok) {
            let msg = `Request failed (${res.status})`;
            try {
                const d = await res.json();
                msg = d.error || msg;
            } catch (_) { /* non-JSON body */ }
            const err = new Error(msg);
            err.status = res.status;
            // 401 is reserved for "session is gone"; 403 means signed in but not permitted,
            // so it must not bounce the user out.
            if (res.status === 401 && sessionExpiredHandler) {
                try { sessionExpiredHandler(); } catch (_) { /* handler must not mask the error */ }
            }
            throw err;
        }
        const ct = res.headers.get('content-type') || '';
        return ct.includes('application/json') ? res.json() : { success: true };
    }

    /**
     * @param {string} name
     * @param {string} pin
     */
    async function mobileAuth(name, pin) {
        return fetchJson('/api/mobile-auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, pin }),
        });
    }

    /**
     * @param {string} [token]
     */
    async function getSync(token = '') {
        const headers = {};
        if (token) headers['x-session-token'] = token;
        return fetchJson('/api/sync', { headers });
    }

    /**
     * @param {object} p
     * @param {string} p.table
     * @param {string} p.action
     * @param {object} [p.data]
     * @param {string} [p.id_col]
     * @param {string|number} [p.id_val]
     * @param {string} [p.token]
     * @param {object} [p.userContext]
     */
    async function postAction({ table, action, data, id_col, id_val, token, userContext }) {
        return fetchJson('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table, action, data, id_col, id_val, token, userContext }),
        });
    }

    /**
     * @param {string} url
     * @param {object} body
     * @param {string} [token]
     */
    async function postJson(url, body, token) {
        const payload = { ...body };
        if (token) payload.token = token;
        return fetchJson(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
    }

    /**
     * Staff rows eligible for portal login dropdowns (respects manager System Profiles toggles).
     * @param {object} syncData — `/api/sync` payload
     */
    function filterLoginStaff(syncData) {
        const staff = syncData?.staff || [];
        const settings = syncData?.settings || {};
        const unassignedEnabled = syncData?.features?.unassignedLogin !== false && settings.Unassigned_Option_Enabled !== '0';
        return staff.filter((s) => {
            if (!unassignedEnabled && s.name === 'Unassigned') return false;
            return true;
        });
    }

    global.TgpApi = {
        API_HOST,
        KILL_DATE_ZONES,
        apiBase,
        esc,
        resolveUrl,
        fetchJson,
        onSessionExpired,
        mobileAuth,
        getSync,
        postAction,
        postJson,
        filterLoginStaff,
    };
})(typeof window !== 'undefined' ? window : globalThis);
