'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'public', 'js', 'reports', 'sections');
const orders = fs.readFileSync(path.join(root, 'orders.js'), 'utf8');
const handoff = fs.readFileSync(path.join(root, 'handoff.js'), 'utf8');

function sliceByFunction(src, startName, endName) {
    const s = src.indexOf(`function ${startName}`);
    const e = endName ? src.indexOf(`function ${endName}`, s + 1) : src.length;
    if (s < 0) throw new Error(`Missing ${startName}`);
    return src.slice(s, e < 0 ? src.length : e).trim();
}

const orderHistory = [
    sliceByFunction(orders, 'buildOrderTodayBlock', 'buildOrderLearnBlock'),
    sliceByFunction(orders, 'buildOrderLearnBlock', 'rosterSuggestionConfidenceLabel'),
].join('\n\n');

const rosterSuggestions = [
    sliceByFunction(orders, 'rosterSuggestionConfidenceLabel', 'buildFinishHealthSection'),
].join('\n\n');

const learnMetrics = orders.slice(orders.indexOf('function buildFinishHealthSection')).trim();

const deliveriesFn = `function buildDeliveriesSection(d, rangeLabel, deliveries) {
  return \`<div class="section" id="sec-deliveries">
    <div class="section-title">DELIVERY RECEIPTS — \${esc(rangeLabel)}
      <span style="float:right;display:flex;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn" onclick="openFileMaintenanceReceivingLog('print')">PRINT REC LOG</button>
        <button type="button" class="btn" onclick="openFileMaintenanceReceivingLog('csv')">CSV</button>
      </span>
    </div>
    <p style="font-size:0.68rem;color:#666;margin:0 0 10px;text-transform:none">Managers can correct time in/out and invoice/ref # when a late time out skews receiving stats or the invoice arrives after checkout. SAVE rebuilds dock duration.</p>
    <div class="tbl-wrap"><table class="order-history-table">
      <tr><th>VENDOR</th><th>STATUS</th><th>TIME IN</th><th>TIME OUT</th><th>INVOICE / REF #</th><th>DUR</th><th>BY</th><th>SAVE</th></tr>
      \${deliveries.length
        ? deliveries.map(r => {
          const editable = !!(r.arrived_at || r.departed_at);
          const durMins = (r.arrived_at && r.departed_at)
            ? orderDurationMin(r.arrived_at, r.departed_at)
            : '—';
          if (!editable) {
            return \`<tr>
              <td style="color:var(--white);font-weight:700">\${esc(r.vendor)}</td>
              <td><span class="pill">\${esc(r.status)}</span></td>
              <td colspan="2" style="color:#666;font-size:0.72rem;text-transform:none">No dock times logged</td>
              <td>\${esc(r.invoice_ref || '')}</td>
              <td>—</td>
              <td>\${esc(r.arrived_by || r.departed_by || r.closed_by || '')}</td>
              <td>—</td>
            </tr>\`;
          }
          return \`<tr data-exp-id="\${esc(r.exp_id || '')}">
            <td style="color:var(--white);font-weight:700">\${esc(r.vendor)}<div class="piece-hint">\${esc(r.expected_day || '')}\${r.pieces ? \` · \${r.pieces} pcs\` : ''}\${r.category ? \` · \${esc(r.category)}\` : ''}</div></td>
            <td><span class="pill">\${esc(r.status)}</span></td>
            <td><input class="hist-input hist-input-time recv-arrived-at" type="datetime-local" value="\${esc(isoToDatetimeLocal(r.arrived_at))}"/></td>
            <td><input class="hist-input hist-input-time recv-departed-at" type="datetime-local" value="\${esc(isoToDatetimeLocal(r.departed_at))}"/></td>
            <td><input class="hist-input hist-input-note recv-invoice-ref" type="text" maxlength="120" value="\${esc(r.invoice_ref || '')}" placeholder="Invoice / ref #"/></td>
            <td><span class="pill recv-duration-preview">\${esc(durMins)}</span></td>
            <td style="font-size:0.72rem;color:var(--text)">\${esc(r.departed_by || r.arrived_by || r.closed_by || '')}</td>
            <td><button type="button" class="btn ok order-history-actions btn" style="padding:4px 10px;font-size:0.65rem" onclick="saveReceivingLogCorrection(this)">SAVE</button></td>
          </tr>\`;
        }).join('')
        : '<tr><td colspan="8" style="color:#444;text-align:center;padding:16px">NO DELIVERIES RECORDED FOR THIS DATE</td></tr>'}
    </table></div>
  </div>\`;
}`;

const handoffStart = handoff.indexOf('function buildHandoffPanel');
const handoffBeforeDeliveries = handoff.slice(handoffStart, handoff.indexOf('html += `<div class="section" id="sec-deliveries">')).trim();
const handoffEnd = handoff.slice(handoff.indexOf('html += \'</div>\';', handoff.indexOf('sec-deliveries'))).trim();

const newHandoff = `${handoff.slice(0, handoffStart).trim()}\n\n${handoffBeforeDeliveries}\n\n  html += buildDeliveriesSection(d, rangeLabel, deliveries);\n\n${handoffEnd}`;

fs.writeFileSync(path.join(root, 'order-history.js'), `${orderHistory}\n`);
fs.writeFileSync(path.join(root, 'roster-suggestions.js'), `${rosterSuggestions}\n`);
fs.writeFileSync(path.join(root, 'learn-metrics.js'), `${learnMetrics}\n`);
fs.writeFileSync(path.join(root, 'deliveries.js'), `${deliveriesFn}\n`);
fs.writeFileSync(path.join(root, 'handoff.js'), `${newHandoff}\n`);
fs.unlinkSync(path.join(root, 'orders.js'));

console.log('Split orders.js -> order-history, roster-suggestions, learn-metrics');
console.log('Extracted deliveries.js and updated handoff.js');
