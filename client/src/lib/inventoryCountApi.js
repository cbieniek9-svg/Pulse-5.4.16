import { fetchJson, resolveUrl } from './api.js';

const COUNT_SESSION_KEY = 'tgp_count_session';

function authHeaders(token, json = false) {
    const h = { 'x-session-token': token || '' };
    if (json) h['Content-Type'] = 'application/json';
    return h;
}

export async function getInventoryConfig() {
    return fetchJson('/api/inventory/config');
}

export async function createSession(token, locationOrOpts, maybeOpts) {
    const opts = typeof locationOrOpts === 'object' && locationOrOpts != null
        ? locationOrOpts
        : { location: locationOrOpts, ...(maybeOpts || {}) };
    return fetchJson('/api/inventory/sessions', {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({
            location: opts.location,
            session_type: opts.session_type || opts.type || 'location',
        }),
    });
}

export async function listSessions(token, status = 'all', sessionType) {
    const qs = new URLSearchParams({ status: String(status || 'all') });
    if (sessionType) qs.set('session_type', sessionType);
    return fetchJson(`/api/inventory/sessions?${qs.toString()}`, {
        headers: authHeaders(token),
    });
}

export async function getBackstockSummary(token, { includeExported = false, source = 'committed' } = {}) {
    const qs = new URLSearchParams();
    if (includeExported) qs.set('include_exported', '1');
    if (source) qs.set('source', source);
    const q = qs.toString();
    return fetchJson(`/api/inventory/backstock/summary${q ? `?${q}` : ''}`, {
        headers: authHeaders(token),
    });
}

export async function closeBackstockSession(token, sessionId) {
    return fetchJson(`/api/inventory/sessions/${encodeURIComponent(sessionId)}/close-backstock`, {
        method: 'POST',
        headers: authHeaders(token, true),
        body: '{}',
    });
}

export async function closeLocationSession(token, sessionId) {
    return fetchJson(`/api/inventory/sessions/${encodeURIComponent(sessionId)}/close-location`, {
        method: 'POST',
        headers: authHeaders(token, true),
        body: '{}',
    });
}

export async function fetchSessionPrintHtml(token, sessionId) {
    const res = await fetch(resolveUrl(`/api/inventory/sessions/${encodeURIComponent(sessionId)}/print`), {
        method: 'GET',
        headers: authHeaders(token),
    });
    if (!res.ok) {
        let msg = 'Print failed';
        try { msg = (await res.json()).error || msg; } catch (_) { /* non-JSON */ }
        throw new Error(msg);
    }
    return res.text();
}

export async function finalizeOrderDraft(token, sessionId, body = {}) {
    return fetchJson(`/api/inventory/sessions/${encodeURIComponent(sessionId)}/finalize-order`, {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify(body),
    });
}

export async function getOrderReport(token, sessionId, { refresh = false } = {}) {
    const qs = refresh ? '?refresh=1' : '';
    return fetchJson(`/api/inventory/sessions/${encodeURIComponent(sessionId)}/order-report${qs}`, {
        headers: authHeaders(token),
    });
}

export async function getSession(token, sessionId) {
    return fetchJson(`/api/inventory/sessions/${encodeURIComponent(sessionId)}`, {
        headers: authHeaders(token),
    });
}

export async function updateSessionLocation(token, sessionId, location) {
    return fetchJson(`/api/inventory/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'PATCH',
        headers: authHeaders(token, true),
        body: JSON.stringify({ location }),
    });
}

export async function reopenSession(token, sessionId, controls = {}) {
    return fetchJson(`/api/inventory/sessions/${encodeURIComponent(sessionId)}/reopen`, {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({
            reason: controls.reason || '',
            confirm_pin: controls.confirm_pin || '',
        }),
    });
}

export async function exportSessionCsv(token, sessionId) {
    const res = await fetch(resolveUrl(`/api/inventory/sessions/${encodeURIComponent(sessionId)}/export`), {
        method: 'POST',
        headers: authHeaders(token, true),
        body: '{}',
    });
    if (!res.ok) {
        let msg = 'Export failed';
        try { msg = (await res.json()).error || msg; } catch (_) { /* non-JSON */ }
        throw new Error(msg);
    }
    const blob = await res.blob();
    const disp = res.headers.get('Content-Disposition') || '';
    const match = disp.match(/filename=([^;]+)/i);
    const filename = match ? match[1].replace(/"/g, '') : `Inventory_Count_${sessionId}.csv`;
    return { blob, filename };
}

export async function submitScan(token, { session_id, upc, quantity, uom }) {
    return fetchJson('/api/inventory/scan', {
        method: 'POST',
        headers: authHeaders(token, true),
        body: JSON.stringify({ session_id, upc, quantity, uom }),
    });
}

export async function getActiveScans(token, sessionId) {
    return fetchJson(`/api/inventory/active?session_id=${encodeURIComponent(sessionId)}`, {
        headers: authHeaders(token),
    });
}

export async function updateLine(token, lineId, { upc, quantity, uom }) {
    return fetchJson(`/api/inventory/lines/${lineId}`, {
        method: 'PATCH',
        headers: authHeaders(token, true),
        body: JSON.stringify({ upc, quantity, uom }),
    });
}

export async function deleteLine(token, lineId) {
    return fetchJson(`/api/inventory/lines/${lineId}`, {
        method: 'DELETE',
        headers: authHeaders(token),
    });
}

export function persistCountSessionId(id) {
    try {
        if (id) sessionStorage.setItem(COUNT_SESSION_KEY, id);
        else sessionStorage.removeItem(COUNT_SESSION_KEY);
    } catch (_) { /* ignore */ }
}

export function readCountSessionId() {
    try { return sessionStorage.getItem(COUNT_SESSION_KEY) || ''; } catch (_) { return ''; }
}

export function clearCountSessionId() {
    persistCountSessionId(null);
}
