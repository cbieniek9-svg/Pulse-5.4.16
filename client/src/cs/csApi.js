import { fetchJson, mobileAuth, resolveUrl } from '../lib/api.js';

const CS_DEVICE_TOKEN_KEY = 'tgp.cs.deviceToken';

export function captureCsDeviceTokenFromUrl() {
    if (typeof window === 'undefined' || !window.location || !window.localStorage) return '';
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '');
    const deviceToken = hashParams.get('deviceToken') || '';
    if (!deviceToken) return window.localStorage.getItem(CS_DEVICE_TOKEN_KEY) || '';
    window.localStorage.setItem(CS_DEVICE_TOKEN_KEY, deviceToken);
    hashParams.delete('deviceToken');
    const remainingHash = hashParams.toString();
    url.hash = remainingHash ? `#${remainingHash}` : '';
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return deviceToken;
}

captureCsDeviceTokenFromUrl();

export function getCsDeviceToken() {
    if (typeof window === 'undefined' || !window.localStorage) return '';
    return window.localStorage.getItem(CS_DEVICE_TOKEN_KEY) || '';
}

export function getCsSession() {
    return {
        user: sessionStorage.getItem('tgp_cs_user') || '',
        token: sessionStorage.getItem('tgp_cs_token') || '',
    };
}

export function setCsSession(name, token) {
    sessionStorage.setItem('tgp_cs_user', name);
    sessionStorage.setItem('tgp_cs_token', token);
}

export function clearCsSession() {
    sessionStorage.removeItem('tgp_cs_user');
    sessionStorage.removeItem('tgp_cs_token');
}

export function actorContext(user, token) {
    if (token && user) return { token, name: user };
    return {};
}

export function csFullOn(cfg) {
    return !!(cfg?.csFull || cfg?.betacs);
}

export function crmOn(cfg) {
    return !!(cfg?.crm && csFullOn(cfg));
}

export const upper = (v) => String(v || '').trim().toUpperCase();

function authHeaders(token, extra = {}) {
    return {
        ...extra,
        ...(token ? { 'x-session-token': token } : {}),
    };
}

export async function printCsOrder(orderId, token) {
    if (!orderId) return;
    const tok = token || getCsSession().token;
    const res = await fetch(resolveUrl(`/api/cs/orders/${encodeURIComponent(orderId)}/print`), {
        headers: authHeaders(tok),
        cache: 'no-store',
    });
    if (!res.ok) {
        let msg = 'Print failed';
        try {
            const data = await res.json();
            msg = data.error || msg;
        } catch (_) { /* ignore */ }
        throw new Error(msg);
    }
    const html = await res.text();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function getPortalConfig() {
    return fetchJson('/api/cs/config', { cache: 'no-store' });
}

export async function csApiAction(body, user, token) {
    const sessionToken = token || getCsSession().token;
    const deviceToken = sessionToken ? '' : getCsDeviceToken();
    if (!sessionToken && !deviceToken) {
        const error = new Error('CS desk pairing required before submitting orders.');
        error.code = 'STATION_DEVICE_AUTH_REQUIRED';
        throw error;
    }
    const auth = actorContext(user, sessionToken);
    return fetchJson('/api/action', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(sessionToken ? { 'x-session-token': sessionToken } : {}),
            ...(deviceToken ? { 'x-device-token': deviceToken } : {}),
        },
        body: JSON.stringify({ ...body, ...auth }),
    });
}

export async function getLoginStaff() {
    return fetchJson('/api/cs/login-staff', { cache: 'no-store' });
}

export async function csLogin(name, pin) {
    return mobileAuth(name, pin);
}

export async function getDueOrders(token) {
    const tok = token || getCsSession().token;
    return fetchJson('/api/cs/due-orders', {
        cache: 'no-store',
        headers: authHeaders(tok),
    });
}

export async function getCustomerByPhone(phone, token) {
    const tok = token || getCsSession().token;
    return fetchJson(`/api/cs/customer-by-phone?phone=${encodeURIComponent(phone)}`, {
        cache: 'no-store',
        headers: authHeaders(tok),
    });
}

export async function getBetacsRoutes(token) {
    const tok = token || getCsSession().token;
    return fetchJson('/api/betacs/routes', { headers: authHeaders(tok) });
}

export async function getBetacsTakenBy(token) {
    const tok = token || getCsSession().token;
    return fetchJson('/api/betacs/taken-by', { headers: authHeaders(tok) });
}

export async function getBetacsOrders(token) {
    const tok = token || getCsSession().token;
    return fetchJson('/api/betacs/orders', { headers: authHeaders(tok) });
}

export async function searchCustomers(q, token) {
    const tok = token || getCsSession().token;
    return fetchJson(`/api/cs/customers?q=${encodeURIComponent(q)}`, {
        cache: 'no-store',
        headers: authHeaders(tok),
    });
}

export async function createCustomer(name, phone, token) {
    const tok = token || getCsSession().token;
    return fetchJson('/api/cs/customers', {
        method: 'POST',
        headers: authHeaders(tok, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name, phone }),
    });
}

export async function getCustomer(customerId, token) {
    const tok = token || getCsSession().token;
    return fetchJson(`/api/cs/customers/${encodeURIComponent(customerId)}`, {
        cache: 'no-store',
        headers: authHeaders(tok),
    });
}

export async function updateCustomer(customerId, data, token) {
    const tok = token || getCsSession().token;
    return fetchJson(`/api/cs/customers/${encodeURIComponent(customerId)}`, {
        method: 'POST',
        headers: authHeaders(tok, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
    });
}

export async function addCustomerEvent(customerId, data, token) {
    const tok = token || getCsSession().token;
    return fetchJson(`/api/cs/customers/${encodeURIComponent(customerId)}/events`, {
        method: 'POST',
        headers: authHeaders(tok, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(data),
    });
}

export function orderMatchesQuery(order, q) {
    if (!q) return true;
    const name = String(order.customer || '').toLowerCase();
    const phone = String(order.contact || '').replace(/\D/g, '');
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3 && phone.includes(digits)) return true;
    return name.includes(q);
}
