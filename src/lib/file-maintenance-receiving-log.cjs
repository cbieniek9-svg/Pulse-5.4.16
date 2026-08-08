'use strict';

function csvCell(value) {
    const s = String(value ?? '');
    const escaped = s.replace(/"/g, '""');
    return /[",\n\r=+\-@]/.test(escaped.charAt(0)) || /[",\n\r]/.test(escaped)
        ? `"${escaped}"`
        : escaped;
}

function normalizeStoreDate(value) {
    const s = String(value || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const err = new Error('Expected date in YYYY-MM-DD format.');
        err.status = 400;
        throw err;
    }
    return s;
}

function addDays(storeDate, delta) {
    const [y, m, d] = normalizeStoreDate(storeDate).split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + Number(delta || 0));
    return dt.toISOString().slice(0, 10);
}

function hasColumn(db, table, column) {
    try {
        return (db.all(`PRAGMA table_info(${table})`) || []).some((r) => r.name === column);
    } catch (_) {
        return false;
    }
}

function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
}

function receiverName(row) {
    const inBy = String(row.arrived_by || '').trim();
    const outBy = String(row.departed_by || row.closed_by || '').trim();
    if (inBy && outBy && inBy !== outBy) return `${inBy} / out by ${outBy}`;
    return inBy || outBy || '—';
}

function normalizeRow(row) {
    const timeIn = row.arrived_at || '';
    const timeOut = row.departed_at || '';
    return {
        exp_id: row.exp_id,
        vendor: row.vendor || '',
        expected_day: row.expected_day || '',
        status: row.status || '',
        time_in: timeIn,
        // Dock time out only — never fall back to EOD archive time_closed (looks like a fake OUT).
        time_out: timeOut,
        receiver: receiverName(row),
        invoice_ref: String(row.invoice_ref || '').trim(),
        notes: timeOut ? '' : 'Not timed out',
        category: row.category || '',
    };
}

function buildFileMaintenanceReceivingLogPayload(db, storeDate) {
    const date = normalizeStoreDate(storeDate);
    const invoiceSelect = hasColumn(db, 'expected_orders', 'invoice_ref') ? 'invoice_ref' : "'' AS invoice_ref";

    // Store-local calendar day (UTC ISO substr alone drifts evening trucks / misses MDT).
    let tzMod = '';
    try {
        const { getStoreMeta } = require('../constants/store-meta.cjs');
        const { normalizeStoreTimezone } = require('./store-timezone.cjs');
        const { sqliteTzOffsetModifier } = require('./store-time.cjs');
        const settings = typeof db.getSettings === 'function'
            ? db.getSettings()
            : {};
        const tz = normalizeStoreTimezone(getStoreMeta(settings).timezone).timezone;
        tzMod = sqliteTzOffsetModifier(tz, new Date(`${date}T12:00:00Z`));
        if (!/^[+-]\d+ minutes$/.test(tzMod) || tzMod === '+0 minutes') tzMod = '';
    } catch (_) {
        tzMod = '';
    }

    const localArrived = tzMod ? `date(arrived_at, '${tzMod}')=?` : '0';
    const localDeparted = tzMod ? `date(departed_at, '${tzMod}')=?` : '0';
    const localClosed = tzMod ? `date(time_closed, '${tzMod}')=?` : '0';
    const params = tzMod
        ? [date, date, date, date, date, date]
        : [date, date, date];

    // Only real dock arrivals. Do NOT match bare expected_day — that pulls ghost
    // Archived schedule rows (never timed in) and duplicates vendors on the print log.
    const rows = db.all(
        `SELECT exp_id, vendor, expected_day, status, category, arrived_at, arrived_by,
                departed_at, departed_by, closed_by, time_closed, ${invoiceSelect}
           FROM expected_orders
          WHERE category!='hardware'
            AND arrived=1
            AND arrived_at IS NOT NULL
            AND TRIM(arrived_at)!=''
            AND (
                 substr(arrived_at,1,10)=?
              OR substr(COALESCE(departed_at,''),1,10)=?
              OR substr(COALESCE(time_closed,''),1,10)=?
              OR ${localArrived}
              OR ${localDeparted}
              OR ${localClosed}
            )
          ORDER BY COALESCE(arrived_at, departed_at, time_closed, exp_id) ASC`,
        ...params,
    ).map(normalizeRow);
    return {
        store_date: date,
        printed_at: new Date().toISOString(),
        rows,
        open_count: rows.filter((r) => !r.time_out).length,
        invoice_ref_count: rows.filter((r) => r.invoice_ref).length,
    };
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function renderFileMaintenanceReceivingLogHtml(payload, storeName = 'TGP') {
    const rows = payload.rows || [];
    const printed = payload.printed_at ? new Date(payload.printed_at).toLocaleString('en-CA') : '';
    return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>Receiving Log ${esc(payload.store_date)}</title>
<style>
  body{font-family:Arial,sans-serif;margin:24px;color:#111}
  h1{font-size:20px;margin:0 0 4px;text-transform:uppercase}
  .meta{font-size:12px;color:#555;margin-bottom:14px}
  table{border-collapse:collapse;width:100%;font-size:12px}
  th,td{border:1px solid #777;padding:6px 7px;vertical-align:top}
  th{background:#eee;text-align:left;text-transform:uppercase}
  .vendor{font-weight:700}
  .blank{display:inline-block;min-width:120px;border-bottom:1px solid #333;height:14px}
  .notes{min-width:170px}
  .open{background:#fff4cc}
  .footer{margin-top:18px;font-size:11px;color:#555}
  @media print{button{display:none} body{margin:12px} }
</style></head>
<body>
<button onclick="window.print()" style="float:right;padding:8px 14px">Print</button>
<h1>${esc(storeName)} — Receiving Log</h1>
<div class="meta">Date: ${esc(payload.store_date)} · Printed: ${esc(printed)} · Rows: ${rows.length} · Open: ${payload.open_count || 0}</div>
<table>
  <thead><tr>
    <th>Vendor</th><th>Time In</th><th>Time Out</th><th>Receiver</th><th>Invoice / Ref #</th><th>Notes</th>
  </tr></thead>
  <tbody>
  ${rows.length ? rows.map((r) => `<tr class="${r.time_out ? '' : 'open'}">
    <td class="vendor">${esc(r.vendor || '—')}</td>
    <td>${esc(fmtTime(r.time_in))}</td>
    <td>${esc(fmtTime(r.time_out))}</td>
    <td>${esc(r.receiver)}</td>
    <td>${r.invoice_ref ? esc(r.invoice_ref) : '<span class="blank"></span>'}</td>
    <td class="notes">${esc(r.notes || '')}</td>
  </tr>`).join('') : '<tr><td colspan="6" style="text-align:center;color:#666;padding:18px">No receiving rows found for this date.</td></tr>'}
  </tbody>
</table>
<div class="footer">Receiver times come from the app login used to time vendors in/out. Invoice / Ref # is optional and may be filled by hand if blank.</div>
</body></html>`;
}

function renderFileMaintenanceReceivingLogCsv(payload) {
    const header = ['Date', 'Vendor', 'Time In', 'Time Out', 'Receiver', 'Invoice / Ref #', 'Notes'];
    const rows = (payload.rows || []).map((r) => [
        payload.store_date,
        r.vendor,
        r.time_in,
        r.time_out,
        r.receiver,
        r.invoice_ref,
        r.notes || '',
    ]);
    return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

module.exports = {
    normalizeStoreDate,
    addDays,
    receiverName,
    buildFileMaintenanceReceivingLogPayload,
    renderFileMaintenanceReceivingLogHtml,
    renderFileMaintenanceReceivingLogCsv,
};
