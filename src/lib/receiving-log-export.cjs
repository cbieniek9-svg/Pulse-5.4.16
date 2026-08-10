'use strict';

const { getStoreMeta } = require('../constants/store-meta.cjs');
const { normalizeStoreTimezone } = require('./store-timezone.cjs');
const { sqliteTzOffsetModifier } = require('./store-time.cjs');
const { csvCell } = require('./csv-safe.cjs');

function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtExpectedDay(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const d = new Date(`${s}T12:00:00`);
        if (!Number.isNaN(d.getTime())) {
            return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }
    }
    return s;
}

function fmtDuration(mins) {
    const n = Number(mins);
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 60) return `${Math.round(n)}m`;
    const h = Math.floor(n / 60);
    const m = Math.round(n % 60);
    return m ? `${h}h ${m}m` : `${h}h`;
}

function resolveStoreTzModifier(db, storeDate) {
    try {
        const settings = db.getSettings ? db.getSettings() : {};
        const tz = normalizeStoreTimezone(getStoreMeta(settings).timezone).timezone;
        const ref = /^\d{4}-\d{2}-\d{2}$/.test(storeDate) ? new Date(`${storeDate}T12:00:00Z`) : new Date();
        const tzMod = sqliteTzOffsetModifier(tz, ref);
        if (!/^[+-]\d+ minutes$/.test(tzMod) || tzMod === '+0 minutes') return '';
        return tzMod;
    } catch (_) {
        return '';
    }
}

function localDateExpr(column, tzMod) {
    return tzMod ? `date(${column}, '${tzMod}')` : `date(${column})`;
}

function buildReceivingLogPayload(db, storeDate) {
    const day = String(storeDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const err = new Error('date must be YYYY-MM-DD.');
        err.status = 400;
        throw err;
    }

    const tzMod = resolveStoreTzModifier(db, day);
    const arrivalDay = localDateExpr('arrival_time', tzMod);
    const arrivedDay = localDateExpr('arrived_at', tzMod);

    const runs = db.all(`
        SELECT vendor, processed_by,
               ROUND(duration_mins, 1) AS duration_mins,
               arrival_time, completion_time
        FROM receiving_stats
        WHERE ${arrivalDay} = ?
        ORDER BY datetime(arrival_time) ASC
    `, day);

    const deliveries = db.all(`
        SELECT exp_id, vendor, status, category, expected_day,
               arrived_at, departed_at, arrived_by, departed_by, closed_by, pieces, item,
               invoice_ref
        FROM expected_orders
        WHERE category != 'hardware'
          AND arrived_at IS NOT NULL
          AND ${arrivedDay} = ?
          AND status != 'Pending'
        ORDER BY datetime(arrived_at) ASC
    `, day);

    const rows = deliveries.map((d) => {
        const stat = runs.find((r) =>
            r.arrival_time && d.arrived_at && r.arrival_time === d.arrived_at,
        );
        return {
            vendor: d.vendor,
            status: d.status,
            expected_day: d.expected_day || '',
            time_in: d.arrived_at,
            time_out: d.departed_at,
            duration_mins: stat?.duration_mins ?? null,
            by: d.departed_by || d.arrived_by || d.closed_by || '',
            category: d.category || '',
            item: d.item || '',
            invoice_ref: String(d.invoice_ref || '').trim(),
        };
    });

    const unmatchedStats = runs.filter((r) =>
        !deliveries.some((d) => d.arrived_at && r.arrival_time === d.arrived_at),
    ).map((r) => ({
        vendor: r.vendor,
        status: 'Logged',
        expected_day: '',
        time_in: r.arrival_time,
        time_out: r.completion_time,
        duration_mins: r.duration_mins,
        by: r.processed_by,
        category: '',
        item: '',
        invoice_ref: '',
    }));

    const allRows = [...rows, ...unmatchedStats].sort((a, b) => {
        const ta = Date.parse(a.time_in || a.time_out || '') || 0;
        const tb = Date.parse(b.time_in || b.time_out || '') || 0;
        return ta - tb;
    });

    const totalMins = runs.reduce((s, r) => s + (Number(r.duration_mins) || 0), 0);

    return {
        store_date: day,
        rows: allRows,
        summary: {
            delivery_count: allRows.length,
            stat_count: runs.length,
            total_duration_mins: Math.round(totalMins * 10) / 10,
        },
    };
}

function renderReceivingLogCsv(payload) {
    const header = ['date', 'vendor', 'status', 'time_in', 'time_out', 'duration_mins', 'by', 'invoice_ref', 'expected_day', 'category', 'item'];
    const lines = [header.join(',')];
    for (const r of payload.rows) {
        lines.push([
            payload.store_date,
            r.vendor,
            r.status,
            r.time_in || '',
            r.time_out || '',
            r.duration_mins ?? '',
            r.by,
            r.invoice_ref || '',
            r.expected_day || '',
            r.category,
            r.item,
        ].map(csvCell).join(','));
    }
    return lines.join('\n');
}

function renderReceivingLogPrintHtml(payload, storeDisplayName) {
    const title = `Receiving Log — ${payload.store_date}`;
    const body = payload.rows.length
        ? payload.rows.map((r) => `<tr>
            <td>${escapeHtml(r.vendor)}</td>
            <td>${escapeHtml(r.status)}</td>
            <td>${escapeHtml(fmtTime(r.time_in))}</td>
            <td>${escapeHtml(fmtTime(r.time_out))}</td>
            <td>${escapeHtml(fmtDuration(r.duration_mins))}</td>
            <td>${escapeHtml(r.by || '—')}</td>
            <td>${escapeHtml(r.invoice_ref || '—')}</td>
            <td>${escapeHtml(fmtExpectedDay(r.expected_day))}</td>
        </tr>`).join('')
        : '<tr><td colspan="8" class="empty">No receiving activity for this date.</td></tr>';

    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
  body{font-family:Arial,sans-serif;margin:24px;color:#111}
  h1{font-size:1.25rem;margin:0 0 4px}
  .sub{color:#555;font-size:0.9rem;margin-bottom:16px}
  table{width:100%;border-collapse:collapse;font-size:0.85rem}
  th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
  th{background:#f0f0f0}
  .empty{text-align:center;color:#888;padding:20px}
  .summary{margin-top:16px;font-size:0.85rem;color:#333}
  @media print{body{margin:12px} button{display:none}}
</style></head><body>
  <h1>${escapeHtml(storeDisplayName || 'TGP Store')} — Receiving Log</h1>
  <div class="sub">${escapeHtml(payload.store_date)} · ${payload.summary.delivery_count} runs · ${fmtDuration(payload.summary.total_duration_mins)} total dock time</div>
  <table>
    <thead><tr><th>VENDOR</th><th>STATUS</th><th>TIME IN</th><th>TIME OUT</th><th>DURATION</th><th>BY</th><th>INVOICE / REF #</th><th>EXPECTED</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <p class="summary">Generated ${new Date().toLocaleString()}</p>
  <button onclick="window.print()">Print</button>
</body></html>`;
}

module.exports = {
    buildReceivingLogPayload,
    renderReceivingLogCsv,
    renderReceivingLogPrintHtml,
    resolveStoreTzModifier,
    localDateExpr,
};
