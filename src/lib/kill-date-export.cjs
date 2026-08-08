'use strict';

const { addDaysToDateStamp } = require('./store-time.cjs');
const { buildKillZoneMapFromSettings } = require('./kill-zone-map.cjs');

function parseZoneOwnership(settings) {
    try { return JSON.parse(settings?.Zone_Ownership || '{}'); } catch (_) { return {}; }
}

function ownerForRow(zone, settings) {
    const owners = parseZoneOwnership(settings);
    const map = buildKillZoneMapFromSettings(settings);
    if (!zone) return '';
    if (owners[zone]) return String(owners[zone]);
    const mapZone = map[zone];
    if (mapZone && owners[mapZone]) return String(owners[mapZone]);
    return '';
}

function bucketKillDates(rows, storeDate) {
    const warnEnd = addDaysToDateStamp(storeDate, 7);
    const pull = [];
    const week = [];
    for (const row of rows || []) {
        const kd = row.kill_date || '';
        if (!kd) continue;
        if (kd <= storeDate) pull.push(row);
        else if (kd <= warnEnd) week.push(row);
    }
    const sort = (a, b) => (a.kill_date || '').localeCompare(b.kill_date || '') || (a.zone || '').localeCompare(b.zone || '');
    pull.sort(sort);
    week.sort(sort);
    return { pull, week };
}

function buildKillDateExportPayload(db, storeDate, settings) {
    const active = db.all(`
        SELECT id, item, item_code, kill_date, zone, status, logged_by, quantity
        FROM kill_dates
        WHERE status = 'Active'
        ORDER BY kill_date ASC, zone ASC, item ASC
    `);
    const { pull, week } = bucketKillDates(active, storeDate);
    const enrich = (row) => ({
        ...row,
        owner: ownerForRow(row.zone, settings),
    });
    return {
        store_date: storeDate,
        pull_today: pull.map(enrich),
        next_7_days: week.map(enrich),
        total_active: active.length,
    };
}

function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderKillDatePrintHtml(payload, storeDisplayName) {
    const section = (title, color, rows) => {
        if (!rows.length) {
            return `<section class="block"><h2 style="color:${color}">${escapeHtml(title)}</h2><p class="empty">None</p></section>`;
        }
        const body = rows.map((r) =>
            `<tr>
                <td>${escapeHtml(r.zone)}</td>
                <td>${escapeHtml(r.owner || '—')}</td>
                <td>${escapeHtml(r.item)}</td>
                <td>${escapeHtml(r.item_code || '')}</td>
                <td>${escapeHtml(r.quantity != null ? r.quantity : 1)}</td>
                <td>${escapeHtml(r.kill_date)}</td>
            </tr>`,
        ).join('');
        return `<section class="block"><h2 style="color:${color}">${escapeHtml(title)} (${rows.length})</h2>
            <table><thead><tr><th>ZONE</th><th>OWNER</th><th>ITEM</th><th>CODE</th><th>QTY</th><th>OUT DATE</th></tr></thead><tbody>${body}</tbody></table></section>`;
    };

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Expiry Pull List</title>
<style>
  body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .meta { color: #555; margin-bottom: 20px; font-size: 0.9rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 0.85rem; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
  th { background: #f0f0f0; }
  .empty { color: #666; font-style: italic; }
  @media print { body { margin: 12px; } .no-print { display: none; } }
</style></head><body>
  <button class="no-print" onclick="window.print()" style="margin-bottom:16px;padding:8px 16px">Print</button>
  <h1>Expiry / Pull List</h1>
  <div class="meta">${escapeHtml(storeDisplayName || 'TGP')} · Store date ${escapeHtml(payload.store_date)} · ${payload.total_active} active on board</div>
  ${section('PULL TODAY', '#c00', payload.pull_today)}
  ${section('NEXT 7 DAYS (WARNING)', '#c60', payload.next_7_days)}
</body></html>`;
}

function renderKillDateCsv(payload) {
    const lines = ['section,zone,owner,item,item_code,quantity,kill_date,logged_by'];
    const add = (section, rows) => {
        rows.forEach((r) => {
            lines.push([
                section,
                r.zone,
                r.owner || '',
                r.item,
                r.item_code || '',
                r.quantity != null ? r.quantity : 1,
                r.kill_date,
                r.logged_by || '',
            ].map((c) => `"${String(c).replace(/"/g, '""')}"`).join(','));
        });
    };
    add('PULL_TODAY', payload.pull_today);
    add('NEXT_7_DAYS', payload.next_7_days);
    return lines.join('\n');
}

module.exports = {
    bucketKillDates,
    buildKillDateExportPayload,
    renderKillDatePrintHtml,
    renderKillDateCsv,
    ownerForRow,
};
