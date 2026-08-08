'use strict';

function esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function itemLines(item) {
    return String(item || '')
        .split(/\s*\+\s*|\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
}

/**
 * Printable customer-order slip HTML (CS desk / department).
 * @param {object} order
 * @param {{ storeName?: string, printedAt?: string }} [opts]
 */
function buildCsOrderPrintHtml(order, opts = {}) {
    const o = order || {};
    const storeName = opts.storeName || 'TGP Center Store';
    const printedAt = opts.printedAt || new Date().toLocaleString('en-CA');
    const lines = itemLines(o.item);
    const itemsHtml = lines.length
        ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
        : `<p>${esc(o.item || '—')}</p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Order ${esc(o.order_id || '')}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;margin:24px;color:#111;font-size:14px}
  h1{font-size:20px;margin:0 0 4px;letter-spacing:1px}
  .sub{color:#444;margin:0 0 16px;font-size:12px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin-bottom:16px}
  .label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px}
  .val{font-size:15px;font-weight:bold;margin-top:2px}
  .items{border:1px solid #ccc;padding:12px 12px 4px;border-radius:4px;margin:16px 0}
  .items h2{font-size:12px;margin:0 0 8px;letter-spacing:1px;color:#444}
  ul{margin:0 0 8px;padding-left:20px}
  li{margin-bottom:6px;font-size:15px}
  .foot{margin-top:24px;font-size:11px;color:#666;border-top:1px solid #ddd;padding-top:8px}
  .no-print{margin-bottom:16px}
  @media print{body{margin:12px}.no-print{display:none}}
</style>
</head>
<body>
  <div class="no-print"><button type="button" onclick="window.print()">Print</button></div>
  <h1>CUSTOMER ORDER</h1>
  <p class="sub">${esc(storeName)} · ${esc(o.order_id || '')}</p>
  <div class="grid">
    <div><div class="label">Customer</div><div class="val">${esc(o.customer || '—')}</div></div>
    <div><div class="label">Phone</div><div class="val">${esc(o.contact || '—')}</div></div>
    <div><div class="label">Needed by</div><div class="val">${esc(o.needed_by || '—')}</div></div>
    <div><div class="label">Status</div><div class="val">${esc(o.status || '—')}</div></div>
    <div><div class="label">Route / Dept</div><div class="val">${esc(o.route || '—')}</div></div>
    <div><div class="label">Location</div><div class="val">${esc(o.location || '—')}</div></div>
    <div><div class="label">Taken by</div><div class="val">${esc(o.taken_by || '—')}</div></div>
    <div><div class="label">Entered by</div><div class="val">${esc(o.logged_by || '—')}</div></div>
  </div>
  <div class="items">
    <h2>Items</h2>
    ${itemsHtml}
  </div>
  ${String(o.notes || '').trim() ? `<div class="items"><h2>Notes</h2><p style="white-space:pre-wrap;margin:0 0 8px">${esc(o.notes)}</p></div>` : ''}
  <div class="foot">Printed ${esc(printedAt)}</div>
  <script>window.onload=function(){setTimeout(function(){window.print();},200);};</script>
</body>
</html>`;
}

module.exports = {
    buildCsOrderPrintHtml,
    itemLines,
};
