import { fetchJson, httpError, resolveUrl } from '../../lib/api.js';
import { postAction } from '../../lib/actions.js';

export async function postJson(url, body, token) {
    const payload = { ...body };
    if (token) payload.token = token;
    return fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
}

export async function getJsonAuthed(url, token) {
    return fetchJson(url, { headers: { 'x-session-token': token } });
}

export function apiAction({
    table, action, data, id_col, id_val, token, user,
}) {
    return postAction({
        table,
        action,
        data,
        id_col,
        id_val,
        token,
        userContext: { name: user, token, role: 'Manager' },
    });
}

export function userCtx(user) {
    return { name: user, role: 'Manager' };
}

export async function fetchScheduleHealth(token) {
    return getJsonAuthed('/api/staff-shifts/health', token);
}

export async function fetchMaintenanceHealth(token) {
    const [healthRes, auditRes] = await Promise.all([
        getJsonAuthed('/api/maintenance/health', token),
        getJsonAuthed('/api/manager/audit-log?limit=60', token),
    ]);
    return {
        health: healthRes.health || null,
        readiness: healthRes.readiness || null,
        network: healthRes.network || null,
        release: healthRes.release || null,
        audit: auditRes.events || [],
    };
}

export async function fetchDeviceNetwork(token) {
    const result = await getJsonAuthed('/api/health', token);
    return result.network || null;
}

export async function runBackupVerification(token) {
    const res = await fetch(resolveUrl('/api/maintenance/verify-backup'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-session-token': token,
        },
        body: JSON.stringify({ token }),
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* empty */ }
    return body.result || { ok: res.ok, stage: res.ok ? 'complete' : 'failed', error: body.error || `HTTP ${res.status}` };
}

export async function secureThisStore(token) {
    const res = await fetch(resolveUrl('/api/maintenance/secure-store'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-session-token': token,
        },
        body: JSON.stringify({ token }),
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

export async function downloadLiveBackup(token) {
    const res = await fetch(resolveUrl('/api/backup-db'), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-session-token': token,
        },
        body: JSON.stringify({ token }),
    });
    if (!res.ok) throw await httpError(res, `Download failed (${res.status})`);
    return res.blob();
}

export async function saveSettingsBatch(settings, token) {
    return postJson('/api/settings-batch', { settings }, token);
}

export async function updateFinancialLogShadowSettings(token, payload) {
    const res = await fetch(resolveUrl('/api/receiving/report/shadow/settings'), {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'x-session-token': token || '',
        },
        body: JSON.stringify(payload || {}),
    });
    let body = {};
    try { body = await res.json(); } catch (_) { /* empty */ }
    if (!res.ok) throw new Error(body.error || `Shadow settings save failed (${res.status})`);
    return body;
}

export async function loadDailyRhythm(token, force = false) {
    return postJson('/api/daily-rhythm', force ? { token, force: true } : { token }, token);
}

export async function saveStaffNameAlias(payload, token) {
    return postJson('/api/staff-name-aliases/save', payload, token);
}

export async function removeStaffNameAlias(sourceName, token) {
    return postJson('/api/staff-name-aliases/remove', { source_name: sourceName }, token);
}

export async function updateStaffShiftRole(shiftId, department, token) {
    // Department only — it outranks the imported job title, so the title is preserved.
    return postJson('/api/staff-shifts/update', { id: shiftId, department, token }, token);
}

export async function previewStaffSchedule(filename, contentBase64, token) {
    return postJson('/api/staff-shifts/preview', { filename, contentBase64, token }, token);
}

export async function importStaffSchedule(filename, contentBase64, token) {
    return postJson('/api/staff-shifts/import', { filename, contentBase64, token }, token);
}

export async function saveManagerTaskTimes(payload, token) {
    return postJson('/api/manager-task-times', payload, token);
}

export async function importSafetyBlurbs(text, token) {
    return postJson('/api/manager/safety/import', { text }, token);
}

export async function postSafetyFocus(payload, token) {
    return postJson('/api/manager/safety/focus', payload, token);
}

export async function clearSafetyFocus(token) {
    return postJson('/api/manager/safety/clear-focus', {}, token);
}

export async function saveSafetyBlurb(payload, token) {
    return postJson('/api/manager/safety/blurb', payload, token);
}

export async function createDevice(label, purpose, token) {
    return postJson('/api/devices/create', { label, purpose }, token);
}

export async function authorizeDevice(id, label, purpose, token) {
    return postJson('/api/devices/authorize', { id, label, purpose }, token);
}

export async function issueDeviceToken(id, token) {
    return postJson('/api/devices/issue-token', { id }, token);
}

export async function rotateDeviceToken(id, token) {
    return postJson('/api/devices/rotate-token', { id }, token);
}

export async function repurposeDevice(id, purpose, token) {
    return postJson('/api/devices/repurpose', { id, purpose }, token);
}

export async function revokeDeviceToken(id, token) {
    return postJson('/api/devices/revoke-token', { id }, token);
}

export async function deleteDevice(id, token) {
    return postJson('/api/devices/delete', { id }, token);
}
