import { fetchJson } from './api.js';

/**
 * POST /api/action — mirrors public/js/tgp-api.js postAction.
 * @param {object} p
 * @param {string} p.table
 * @param {string} p.action
 * @param {object} [p.data]
 * @param {string} [p.id_col]
 * @param {string|number} [p.id_val]
 * @param {string} [p.token]
 * @param {string} [p.deviceToken]
 * @param {object} [p.userContext]
 */
export async function postAction({
    table, action, data, id_col, id_val, token, deviceToken, userContext,
}) {
    const body = { table, action, data, id_col, id_val, userContext };
    if (token) body.token = token;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['x-session-token'] = token;
    if (!token && deviceToken) headers['x-device-token'] = deviceToken;
    return fetchJson('/api/action', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}
