import { fetchJson, resolveUrl } from '../lib/api.js';

function authHeaders(token, { json = true } = {}) {
    const headers = {};
    if (token) headers['x-session-token'] = token;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
}

export async function getSafeLoginOptions() {
    return fetchJson('/api/safe/login-options');
}

export async function listInspections(token, { limit = 24, status = '', from = '', to = '' } = {}) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const qs = params.toString();
    return fetchJson(`/api/safety/inspections${qs ? `?${qs}` : ''}`, { headers: authHeaders(token) });
}

export async function getInspection(token, runId) {
    return fetchJson(`/api/safety/inspections/${encodeURIComponent(runId)}`, { headers: authHeaders(token) });
}

export async function createInspection(token, body = {}) {
    return fetchJson('/api/safety/inspections', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
    });
}

export async function saveInspection(token, runId, body) {
    return fetchJson(`/api/safety/inspections/${encodeURIComponent(runId)}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify(body),
    });
}

export async function submitInspection(token, runId) {
    return fetchJson(`/api/safety/inspections/${encodeURIComponent(runId)}/submit`, {
        method: 'POST',
        headers: authHeaders(token),
        body: '{}',
    });
}

export async function fetchInspectionPrint(token, runId, printWindow = null) {
    const url = resolveUrl(`/api/export/safety-inspection?run_id=${encodeURIComponent(runId)}`);
    const res = await fetch(url, { headers: authHeaders(token, { json: false }) });
    if (!res.ok) {
        let msg = 'Print failed';
        try {
            const d = await res.json();
            msg = d.error || msg;
        } catch (_) { /* non-JSON */ }
        throw new Error(msg);
    }
    const html = await res.text();
    const win = printWindow && !printWindow.closed ? printWindow : window.open('', '_blank');
    if (!win) throw new Error('Allow popups to print the inspection form.');
    win.document.open();
    win.document.write(html);
    win.document.close();
    try { win.focus(); } catch (_) { /* ignore */ }
}

export async function listInvestigations(token, { limit = 24, status = '' } = {}) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (status) params.set('status', status);
    const qs = params.toString();
    return fetchJson(`/api/safety/investigations${qs ? `?${qs}` : ''}`, { headers: authHeaders(token) });
}

export async function getInvestigation(token, id) {
    return fetchJson(`/api/safety/investigations/${encodeURIComponent(id)}`, { headers: authHeaders(token) });
}

export async function createInvestigation(token, body = {}) {
    return fetchJson('/api/safety/investigations', {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify(body),
    });
}

export async function saveInvestigation(token, id, body) {
    return fetchJson(`/api/safety/investigations/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: authHeaders(token),
        body: JSON.stringify(body),
    });
}

export async function submitInvestigation(token, id) {
    return fetchJson(`/api/safety/investigations/${encodeURIComponent(id)}/submit`, {
        method: 'POST',
        headers: authHeaders(token),
        body: '{}',
    });
}

export async function reopenInvestigation(token, id) {
    return fetchJson(`/api/safety/investigations/${encodeURIComponent(id)}/reopen`, {
        method: 'POST',
        headers: authHeaders(token),
        body: '{}',
    });
}

export async function uploadInvestigationAttachment(token, id, file) {
    const form = new FormData();
    form.append('file', file);
    const name = file.name.toLowerCase();
    form.append('kind', name.includes('sketch') ? 'sketch' : file.type === 'application/pdf' ? 'pdf' : 'photo');
    const res = await fetch(resolveUrl(`/api/safety/investigations/${encodeURIComponent(id)}/attachments`), {
        method: 'POST',
        headers: authHeaders(token, { json: false }),
        body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data.error || 'Upload failed');
        if (data.code) err.code = data.code;
        throw err;
    }
    return data;
}

export async function deleteInvestigationAttachment(token, id, attId) {
    return fetchJson(`/api/safety/investigations/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attId)}`, {
        method: 'DELETE',
        headers: authHeaders(token),
    });
}

export async function saveInvestigationSignature(token, id, role, dataUrl) {
    return fetchJson(`/api/safety/investigations/${encodeURIComponent(id)}/signatures/${role}`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ dataUrl }),
    });
}

export async function downloadInvestigationPdf(token, id) {
    const url = resolveUrl(`/api/safety/investigations/${encodeURIComponent(id)}/export.pdf`);
    const res = await fetch(url, { headers: authHeaders(token, { json: false }) });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'PDF download failed.');
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `Incident_Investigation_${id}.pdf`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}
