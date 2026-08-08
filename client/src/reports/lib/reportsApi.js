import { fetchJson, httpError, resolveUrl } from '../../lib/api.js';
import { parseRosterText } from './reportHelpers.js';

async function postJson(token, url, body, opts = {}) {
    return fetchJson(url, {
        method: opts.method || 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-session-token': token,
        },
        body: JSON.stringify({ ...body, token }),
    });
}

async function downloadResponseBlob(token, url, filename, opts = {}) {
    const r = await fetch(resolveUrl(url), {
        method: opts.method || 'GET',
        headers: { ...(opts.headers || {}), 'x-session-token': token },
        body: opts.body,
    });
    if (!r.ok) throw await httpError(r, `Download failed (${r.status})`);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
        URL.revokeObjectURL(a.href);
        a.remove();
    }, 500);
}

async function openExportPopup(token, url, loadingTitle, errorTitle) {
    const win = window.open('', '_blank');
    if (!win) {
        alert('Popup blocked. Allow popups for this app and try again.');
        return null;
    }
    win.document.write(`<!doctype html><title>${loadingTitle}</title><body style="font-family:Arial,sans-serif;margin:24px">Loading…</body>`);
    win.document.close();
    try {
        const r = await fetch(resolveUrl(url), { headers: { 'x-session-token': token } });
        if (!r.ok) throw await httpError(r, `Export failed (${r.status})`);
        const html = await r.text();
        win.document.open();
        win.document.write(html);
        win.document.close();
        try { win.focus(); } catch (_) { /* ignore */ }
        return win;
    } catch (e) {
        win.document.open();
        win.document.write(`<!doctype html><title>${errorTitle}</title><body style="font-family:Arial,sans-serif;margin:24px;color:#900"><h1>${errorTitle}</h1><p>${e.message}</p></body>`);
        win.document.close();
        alert(e.message);
        return null;
    }
}

function addStoreDays(dateStr, delta) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Number(delta || 0));
    return dt.toISOString().slice(0, 10);
}

export function createReportsApi(token, reportMeta = {}) {
    const reportRangeForExport = () => {
        const meta = reportMeta || {};
        const start = meta.reportStart || meta.reportDate || '';
        const end = meta.reportEnd || meta.reportDate || start;
        return { start, end };
    };

    const fileMaintenanceLogDate = () => {
        const meta = reportMeta || {};
        const reportDate = meta.reportDate || meta.reportEnd || '';
        if (reportDate && !meta.isLiveToday) return reportDate;
        return addStoreDays(reportDate || new Date().toISOString().slice(0, 10), -1) || reportDate;
    };

    return {
        async ackReportAction(actionId) {
            if (!actionId) return;
            await postJson(token, '/api/reports/ack-action', {
                action_id: actionId,
                report_date: reportMeta.reportDate,
            });
        },

        async deferRhythmFromReport(storeDate, rhythmIds) {
            if (!rhythmIds?.length) return;
            if (!confirm('Defer these rhythm tasks for today and close matching open General routines on the board?')) return;
            await postJson(token, '/api/reports/defer-rhythm', { store_date: storeDate, rhythm_ids: rhythmIds });
        },

        async applyRhythmEstimate(detail, estMins) {
            if (!detail || !estMins) return;
            const result = await postJson(token, '/api/reports/apply-rhythm-estimates', {
                updates: [{ detail, est_mins: estMins }],
            });
            if (!result.applied?.length) throw new Error('No rhythm template matched this task type.');
        },

        async addRhythmFromReport(detail, estMins, sampleCount) {
            if (!detail || !estMins) return;
            const day = prompt('Rhythm day (Monday–Sunday or Everyday):', 'Everyday');
            if (day === null || !String(day).trim()) return;
            const zone = prompt('Zone:', 'General');
            if (zone === null || !String(zone).trim()) return;
            const priority = prompt('Priority (Routine / High / Urgent):', 'Routine');
            if (priority === null || !String(priority).trim()) return;
            const estRounded = Math.round(Number(estMins) / 5) * 5;
            const msg = `Add "${detail}" to rhythm on ${String(day).trim()}?\n\nEst: ${estRounded}m (from ${sampleCount || '?'} completed samples)\nZone: ${String(zone).trim()}\nPriority: ${String(priority).trim()}`;
            if (!confirm(msg)) return;
            await postJson(token, '/api/reports/add-to-rhythm', {
                detail,
                day: String(day).trim(),
                zone: String(zone).trim(),
                priority: String(priority).trim(),
                est_mins: estMins,
            });
        },

        async downloadTrendCsv(days) {
            const end = reportMeta.reportEnd || reportMeta.reportDate || '';
            const safeDays = Number(days || 365);
            await downloadResponseBlob(
                token,
                `/api/reports/trends.csv?days=${encodeURIComponent(safeDays)}${end ? `&end=${encodeURIComponent(end)}` : ''}`,
                `tgp_trends_${end || 'latest'}_${safeDays}d.csv`,
            );
        },

        async downloadFullHistoryZip() {
            await downloadResponseBlob(token, '/api/maintenance/export-history', 'tgp_full_history.zip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ days: 365 }),
            });
        },

        async printTgpColdChain(format = 'print') {
            const { start, end } = reportRangeForExport();
            const fmt = format === 'csv' ? 'csv' : 'print';
            const url = `/api/export/tgp-cold-chain?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&format=${fmt}`;
            if (fmt === 'csv') {
                const fileLabel = start === end ? start : `${start}_${end}`;
                await downloadResponseBlob(token, url, `TGP_Cold_Chain_${fileLabel}.csv`);
                return;
            }
            await openExportPopup(token, url, 'TGP Cold Chain', 'TGP Cold Chain Error');
        },

        async printSafetyInspection(runId) {
            const id = String(runId || '').trim();
            if (!id) return;
            await openExportPopup(token, `/api/export/safety-inspection?run_id=${encodeURIComponent(id)}`, 'Safety Inspection', 'Safety Inspection Error');
        },

        async openFileMaintenanceReceivingLog(format = 'print') {
            const day = fileMaintenanceLogDate();
            const fmt = format === 'csv' ? 'csv' : 'print';
            const url = `/api/export/receiving-file-maintenance?date=${encodeURIComponent(day)}&format=${fmt}`;
            if (fmt === 'csv') {
                await downloadResponseBlob(token, url, `Receiving_Log_${day}.csv`);
                return;
            }
            await openExportPopup(token, url, 'Receiving Log', 'Receiving Log Error');
        },

        killDatesExportUrl(format) {
            return resolveUrl(`/api/export/kill-dates?format=${format}&token=${encodeURIComponent(token || '')}`);
        },

        async saveReceivingLogCorrection({ expId, arrivedAt, departedAt, invoiceRef }) {
            // datetime-local → ISO so Node parses store-local wall time (not server UTC).
            const toIso = (s) => {
                const raw = String(s || '').trim();
                if (!raw) return '';
                const d = new Date(raw);
                if (Number.isNaN(d.getTime())) {
                    throw new Error('Invalid time — check time in / time out.');
                }
                return d.toISOString();
            };
            await postJson(token, '/api/receiving-log-correction', {
                exp_id: expId,
                arrived_at: toIso(arrivedAt),
                departed_at: departedAt === '' || departedAt == null ? '' : toIso(departedAt),
                invoice_ref: invoiceRef,
            });
        },

        async saveReceivingPalletCorrection({ palletId, expId, licensePlate, department, tempC }) {
            await postJson(token, `/api/receiving/pallets/${encodeURIComponent(palletId)}`, {
                exp_id: expId,
                license_plate: licensePlate,
                department,
                temp_c: tempC === '' || tempC == null ? null : Number(tempC),
            }, { method: 'PATCH' });
        },

        async saveOrderHistoryCorrection({
            storeDate, totalPieces, staffCount, staffRoster, orderStart, orderEnd, exceptionReason,
        }) {
            await postJson(token, '/api/order-history-correction', {
                store_date: storeDate,
                total_pieces: totalPieces,
                staff_count: staffCount,
                staff_roster: staffRoster,
                order_start: orderStart,
                order_end: orderEnd,
                exception_reason: exceptionReason,
            });
        },

        async attachLiveClockToHistory(storeDate) {
            if (!confirm('Move the current live order clock onto this archived order row and clear the live clock?')) return;
            await postJson(token, '/api/order-history-attach-live-clock', { store_date: storeDate });
        },

        async deleteOrderHistoryRow(storeDate) {
            if (!confirm(`Delete order history for ${storeDate}? This cannot be undone.`)) return;
            await postJson(token, '/api/order-history-delete', { store_date: storeDate });
        },

        syncStaffCountFromRoster(rosterText) {
            const names = parseRosterText(rosterText);
            return names.length ? String(names.length) : null;
        },
    };
}
