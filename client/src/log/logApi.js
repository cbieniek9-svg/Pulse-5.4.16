import { fetchJson as sharedFetchJson, httpError, resolveUrl } from '../lib/api.js';

function fetchJson(path, token, opts = {}) {
    return sharedFetchJson(path, {
        ...opts,
        headers: {
            'Content-Type': 'application/json',
            'x-session-token': token || '',
            ...(opts.headers || {}),
        },
    });
}

export function fetchReport(token, storeDate) {
    return fetchJson(`/api/receiving/report?date=${encodeURIComponent(storeDate)}`, token);
}

export function saveReportDay(token, payload) {
    return fetchJson('/api/receiving/report/day', token, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export function saveReportLine(token, payload) {
    return fetchJson('/api/receiving/report/lines', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export async function downloadReportWorkbook(token, storeDate) {
    const res = await fetch(
        resolveUrl(`/api/export/edmonton-receiving-report?date=${encodeURIComponent(storeDate)}`),
        { headers: { 'x-session-token': token || '' } },
    );
    if (!res.ok) throw await httpError(res, 'Export failed');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="([^"]+)"/);
    const filename = match?.[1] || `Edmonton-Receiving-Report-${storeDate}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export function deleteReportLine(token, lineId) {
    return fetchJson(`/api/receiving/report/lines/${encodeURIComponent(lineId)}`, token, {
        method: 'DELETE',
    });
}

export function scanReportDocument(token, payload) {
    return fetchJson('/api/receiving/report/import-scan', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function commitReportImport(token, payload) {
    return fetchJson('/api/receiving/report/import-commit', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function deleteShrinkLine(token, shrinkId) {
    return fetchJson(`/api/receiving/report/shrink-lines/${encodeURIComponent(shrinkId)}`, token, {
        method: 'DELETE',
    });
}

export function fetchPeriodDashboard(token, anchorDate, periodStart = '') {
    const params = new URLSearchParams();
    if (anchorDate) params.set('date', anchorDate);
    if (periodStart) params.set('period_start', periodStart);
    return fetchJson(`/api/receiving/report/period?${params.toString()}`, token);
}

export function setCostingMethod(token, payload) {
    return fetchJson('/api/receiving/report/period/costing-method', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function fetchPeriodFreightRate(token, periodStart, department = '') {
    const params = new URLSearchParams({ period_start: periodStart });
    if (department) params.set('department', department);
    return fetchJson(`/api/receiving/report/period/freight-rate?${params.toString()}`, token);
}

export function setPeriodFreightRate(token, payload) {
    return fetchJson('/api/receiving/report/period/freight-rate', token, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export function fetchFreightAllocProfile(token, periodStart) {
    const params = new URLSearchParams({ period_start: periodStart });
    return fetchJson(`/api/receiving/report/period/freight-alloc-profile?${params.toString()}`, token);
}

export function saveFreightAllocProfile(token, payload) {
    return fetchJson('/api/receiving/report/period/freight-alloc-profile', token, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export function confirmFreightAllocProfile(token, payload) {
    return fetchJson('/api/receiving/report/period/freight-alloc-profile/confirm', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function copyFreightAllocProfile(token, payload) {
    return fetchJson('/api/receiving/report/period/freight-alloc-profile/copy', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function setActualFreightBills(token, payload) {
    return fetchJson('/api/receiving/report/period/actual-freight-bills', token, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export function certifyReceivingDay(token, payload) {
    return fetchJson('/api/receiving/report/day/certify', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function overrideFreightRecon(token, payload) {
    return fetchJson('/api/receiving/report/day/freight-override', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function acknowledgeOverflow(token, payload) {
    return fetchJson('/api/receiving/report/day/overflow-ack', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function acknowledgeDuplicateInvoice(token, payload) {
    return fetchJson('/api/receiving/report/day/exception-ack', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function fetchSalesNumbers(token, anchorDate) {
    return fetchJson(`/api/receiving/report/sales?date=${encodeURIComponent(anchorDate)}`, token);
}

export function saveSalesNumber(token, payload) {
    return fetchJson('/api/receiving/report/sales', token, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export function confirmRemainingSalesZero(token, payload) {
    return fetchJson('/api/receiving/report/sales/confirm-zero', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function fetchReceivingTotals(token, anchorDate) {
    return fetchJson(`/api/receiving/report/receiving-totals?date=${encodeURIComponent(anchorDate)}`, token);
}

export function fetchMarginDashboard(token, anchorDate) {
    return fetchJson(`/api/receiving/report/margin?date=${encodeURIComponent(anchorDate)}`, token);
}

export function saveMarginDashboard(token, payload) {
    return fetchJson('/api/receiving/report/margin', token, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export async function downloadFullPeriodWorkbook(token, anchorDate) {
    const res = await fetch(
        resolveUrl(`/api/export/edmonton-receiving-report-period?date=${encodeURIComponent(anchorDate)}`),
        { headers: { 'x-session-token': token || '' } },
    );
    if (!res.ok) throw await httpError(res, 'Export failed');
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const match = cd.match(/filename="([^"]+)"/);
    const filename = match?.[1] || `Edmonton-Receiving-Report-period-${anchorDate}.xlsx`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

export function importWorkbook(token, payload = {}) {
    const rate = payload.rate_percent ?? payload.ratePercent ?? payload.period_freight_rate_percent;
    return fetchJson('/api/receiving/report/import-workbook', token, {
        method: 'POST',
        body: JSON.stringify({
            filename: payload.filename,
            contentBase64: payload.contentBase64,
            replace_period: !!(payload.replace_period ?? payload.replacePeriod),
            fill_sales: payload.fill_sales === true || payload.fillSales === true,
            dry_run: !!(payload.dry_run ?? payload.dryRun),
            rate_percent: rate === '' || rate == null ? undefined : Number(rate),
        }),
    });
}

export function saveShrinkLine(token, payload) {
    return fetchJson('/api/receiving/report/shrink-lines', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function saveDeptMargin(token, payload) {
    return fetchJson('/api/receiving/report/dept-margin', token, {
        method: 'PUT',
        body: JSON.stringify(payload),
    });
}

export function saveRebateLine(token, payload) {
    return fetchJson('/api/receiving/report/rebate-lines', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function deleteRebateLine(token, rebateId) {
    return fetchJson(`/api/receiving/report/rebate-lines/${encodeURIComponent(rebateId)}`, token, {
        method: 'DELETE',
    });
}

export function saveRecount(token, payload) {
    return fetchJson('/api/receiving/report/recounts', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function deleteRecount(token, recountId) {
    return fetchJson(`/api/receiving/report/recounts/${encodeURIComponent(recountId)}`, token, {
        method: 'DELETE',
    });
}

export function archiveSalesHistory(token, periodStart) {
    return fetchJson('/api/receiving/report/sales-history/archive', token, {
        method: 'POST',
        body: JSON.stringify({ period_start: periodStart }),
    });
}

export function snapshotPeriod(token, periodStart) {
    return fetchJson('/api/receiving/report/period/snapshot', token, {
        method: 'POST',
        body: JSON.stringify({ period_start: periodStart }),
    });
}

export function activatePeriod(token, payload) {
    return fetchJson('/api/receiving/report/period/activate', token, {
        method: 'POST',
        body: JSON.stringify({ ...payload, confirm_operational_change: true }),
    });
}

export function fetchCountCycle(token, anchorDate) {
    return fetchJson(`/api/receiving/report/count-cycle?date=${encodeURIComponent(anchorDate)}`, token);
}

export function saveCountCycle(token, payload) {
    return fetchJson('/api/receiving/report/count-cycle', token, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}

export function fetchWorkbookVendors(token) {
    return fetchJson('/api/receiving/report/vendors', token);
}

export function fetchFinancialLogAccess(token) {
    return fetchJson('/api/receiving/report/access', token);
}

export function claimFinancialLogShadow(token) {
    return fetchJson('/api/receiving/report/shadow/claim', token, {
        method: 'POST',
        body: JSON.stringify({}),
    });
}

export function fetchDockReconciliation(token, anchorDate) {
    return fetchJson(`/api/receiving/report/dock-reconciliation?date=${encodeURIComponent(anchorDate)}`, token);
}

export function submitPeriod(token, periodStart) {
    return fetchJson('/api/receiving/report/period/submit', token, {
        method: 'POST',
        body: JSON.stringify({ period_start: periodStart }),
    });
}

export function approvePeriod(token, periodStart) {
    return fetchJson('/api/receiving/report/period/approve', token, {
        method: 'POST',
        body: JSON.stringify({ period_start: periodStart }),
    });
}

export function closePeriod(token, periodStart) {
    return fetchJson('/api/receiving/report/period/close', token, {
        method: 'POST',
        body: JSON.stringify({ period_start: periodStart }),
    });
}

export function reopenPeriod(token, periodStart, note) {
    return fetchJson('/api/receiving/report/period/reopen', token, {
        method: 'POST',
        body: JSON.stringify({ period_start: periodStart, note }),
    });
}
