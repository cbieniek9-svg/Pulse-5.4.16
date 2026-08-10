'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'public', 'js', 'reports', 'sections');
const ordersPath = path.join(root, 'orders.js');
const handoffPath = path.join(root, 'handoff.js');
const orders = fs.readFileSync(ordersPath, 'utf8');
const handoff = fs.readFileSync(handoffPath, 'utf8');

function sliceByFunction(src, startName, endName) {
    const s = src.indexOf(`function ${startName}`);
    if (s < 0) throw new Error(`Missing start anchor: ${startName}`);
    if (!endName) return src.slice(s).trim();
    const e = src.indexOf(`function ${endName}`, s + 1);
    if (e < 0) throw new Error(`Missing end anchor: ${endName}`);
    return src.slice(s, e).trim();
}

function assertJs(label, code) {
    try {
        new vm.Script(code, { filename: label });
    } catch (e) {
        throw new Error(`Invalid JS for ${label}: ${e.message}`);
    }
}

const orderHistory = [
    sliceByFunction(orders, 'buildOrderTodayBlock', 'buildOrderLearnBlock'),
    sliceByFunction(orders, 'buildOrderLearnBlock', 'rosterSuggestionConfidenceLabel'),
].join('\n\n');

const rosterSuggestions = [
    sliceByFunction(orders, 'rosterSuggestionConfidenceLabel', 'buildFinishHealthSection'),
].join('\n\n');

const learnStart = orders.indexOf('function buildFinishHealthSection');
if (learnStart < 0) throw new Error('Missing start anchor: buildFinishHealthSection');
const learnMetrics = orders.slice(learnStart).trim();

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
if (handoffStart < 0) throw new Error('Missing start anchor: buildHandoffPanel');
const deliveriesAnchor = handoff.indexOf('html += `<div class="section" id="sec-deliveries">');
if (deliveriesAnchor < 0) throw new Error('Missing handoff deliveries anchor: sec-deliveries');
const handoffBeforeDeliveries = handoff.slice(handoffStart, deliveriesAnchor).trim();
const handoffEndAnchor = handoff.indexOf('html += \'</div>\';', deliveriesAnchor);
if (handoffEndAnchor < 0) throw new Error('Missing handoff end anchor after sec-deliveries');
const handoffEnd = handoff.slice(handoffEndAnchor).trim();

const newHandoff = `${handoff.slice(0, handoffStart).trim()}\n\n${handoffBeforeDeliveries}\n\n  html += buildDeliveriesSection(d, rangeLabel, deliveries);\n\n${handoffEnd}`;

const outputs = {
    'order-history.js': `${orderHistory}\n`,
    'roster-suggestions.js': `${rosterSuggestions}\n`,
    'learn-metrics.js': `${learnMetrics}\n`,
    'deliveries.js': `${deliveriesFn}\n`,
    'handoff.js': `${newHandoff}\n`,
};

for (const [name, code] of Object.entries(outputs)) {
    assertJs(name, code);
}

for (const [name, code] of Object.entries(outputs)) {
    fs.writeFileSync(path.join(root, name), code);
}

fs.unlinkSync(ordersPath);

console.log('Split orders.js -> order-history, roster-suggestions, learn-metrics');
console.log('Extracted deliveries.js and updated handoff.js');
