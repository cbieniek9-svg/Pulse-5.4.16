'use strict';

const { listColdChainForReport, enrichColdChainRows } = require('./receiving-pallets.cjs');

function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function parseDateRange(start, end) {
    const s = String(start || '').trim();
    const e = String(end || s).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const err = new Error('start date must be YYYY-MM-DD.');
        err.status = 400;
        throw err;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e)) {
        const err = new Error('end date must be YYYY-MM-DD.');
        err.status = 400;
        throw err;
    }
    if (e < s) {
        const err = new Error('end date must be on or after start date.');
        err.status = 400;
        throw err;
    }
    return { start: s, end: e };
}

function buildColdChainPayload(db, start, end) {
    const range = parseDateRange(start, end);
    const rows = enrichColdChainRows(listColdChainForReport(db, range.start, range.end));
    const outOfRange = rows.filter((r) => Number(r.in_range) === 0).length;
    return {
        start: range.start,
        end: range.end,
        rows,
        summary: {
            pallet_count: rows.length,
            out_of_range: outOfRange,
        },
    };
}

function rangeLabel(payload) {
    return payload.start === payload.end ? payload.start : `${payload.start} → ${payload.end}`;
}

function renderColdChainCsv(payload) {
    const header = [
        'store_date', 'license_plate', 'department', 'department_label',
        'temp_c', 'temp_spot_1', 'temp_spot_2', 'temp_spot_3', 'spot_checks',
        'in_range', 'invoice_ref', 'captured_by', 'captured_at', 'notes',
    ];
    const lines = [header.join(',')];
    for (const r of payload.rows) {
        lines.push([
            r.store_date,
            r.license_plate,
            r.department,
            r.department_label || '',
            r.temp_c ?? '',
            r.temp_spot_1 ?? '',
            r.temp_spot_2 ?? '',
            r.temp_spot_3 ?? '',
            r.spot_checks || '',
            Number(r.in_range) === 0 ? 'OUT' : 'OK',
            r.invoice_ref || '',
            r.captured_by || '',
            r.captured_at || '',
            r.notes || '',
        ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
    }
    return lines.join('\n');
}

function renderColdChainPrintHtml(payload, storeDisplayName) {
    const label = rangeLabel(payload);
    const title = `TGP Cold Chain — ${label}`;
    const body = payload.rows.length
        ? payload.rows.map((r) => {
            const out = Number(r.in_range) === 0;
            const spots = r.spot_checks || (r.temp_c != null ? String(r.temp_c) : '—');
            return `<tr class="${out ? 'out' : ''}">
            <td>${escapeHtml(r.store_date || '')}</td>
            <td>${escapeHtml(r.license_plate || '')}</td>
            <td>${escapeHtml(r.department_label || r.department || '')}</td>
            <td><strong>${escapeHtml(r.temp_c ?? '')}</strong></td>
            <td class="spots">${escapeHtml(spots)}</td>
            <td>${out ? 'OUT OF TEMP' : 'OK'}</td>
            <td>${escapeHtml(r.invoice_ref || '—')}</td>
            <td>${escapeHtml(r.captured_by || '—')}</td>
            <td>${escapeHtml(r.captured_at ? new Date(r.captured_at).toLocaleString() : '—')}</td>
        </tr>`;
        }).join('')
        : '<tr><td colspan="9" class="empty">No TGP pallet logs in this date range.</td></tr>';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
  body{font-family:Arial,sans-serif;margin:24px;color:#111}
  h1{font-size:1.25rem;margin:0 0 4px}
  .sub{color:#555;font-size:0.9rem;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top}
  th{background:#f0f0f0}
  tr.out td{background:#ffe6e6}
  tr.out td:nth-child(6){font-weight:800;color:#900}
  td.spots{font-family:Consolas,monospace;font-size:0.82rem;white-space:nowrap}
  .empty{text-align:center;color:#888;padding:20px}
  .summary{margin-top:16px;font-size:0.85rem;color:#333}
  .legend{font-size:0.82rem;color:#444;margin:0 0 12px;line-height:1.4}
  @media print{body{margin:12px} button{display:none}}
</style></head><body>
  <h1>${escapeHtml(storeDisplayName || 'TGP Store')} — TGP Cold Chain Log</h1>
  <div class="sub">${escapeHtml(label)} · ${payload.summary.pallet_count} pallet${payload.summary.pallet_count === 1 ? '' : 's'}${payload.summary.out_of_range ? ` · ${payload.summary.out_of_range} OUT OF TEMP` : ''}</div>
  <p class="legend">TEMP °C is the logged value (single reading, or average of three spot checks when the first reading was out of range). Spot checks show all three readings so warehouse can see out-of-temp evidence.</p>
  <table>
    <thead><tr><th>DATE</th><th>PLATE</th><th>DEPARTMENT</th><th>TEMP °C</th><th>SPOT CHECKS</th><th>RANGE</th><th>INVOICE</th><th>BY</th><th>LOGGED</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="summary">Generated ${new Date().toLocaleString()}</p>
  <button type="button" onclick="window.print()">Print</button>
</body></html>`;
}

module.exports = {
    buildColdChainPayload,
    renderColdChainCsv,
    renderColdChainPrintHtml,
    parseDateRange,
    rangeLabel,
};
