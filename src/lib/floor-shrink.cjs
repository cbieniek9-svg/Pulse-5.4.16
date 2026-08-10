'use strict';

const { lookupItem, resolveDepartment } = require('./item-catalog.cjs');
const { readSpreadsheetBuffer, sheetToObjects } = require('./spreadsheet-read.cjs');
const { csvCell: csvEscape } = require('./csv-safe.cjs');

const SHRINK_STATUSES = new Set(['Open', 'Closed', 'Voided']);
const UNASSIGNED_DEPT = 'Unassigned';

/** Controlled reason list for logging + analytics rollups. Labels are what we store. */
const SHRINK_REASONS = [
    { code: 'damaged', label: 'Damaged' },
    { code: 'outdated', label: 'Outdated / Expired' },
    { code: 'spoil', label: 'Spoil / Quality' },
    { code: 'theft', label: 'Theft / Unknown' },
    { code: 'vendor', label: 'Vendor defect' },
    { code: 'other', label: 'Other' },
];

function money(n) {
    const v = Number(n);
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function normalizeShrinkStatus(raw) {
    const s = String(raw || 'Open').trim();
    if (SHRINK_STATUSES.has(s)) return s;
    return 'Open';
}

/**
 * Map free-text / legacy reasons onto the controlled vocabulary so mix charts work.
 * Unmatched text still buckets as Other (raw text stays on the line).
 */
function normalizeShrinkReason(raw) {
    const s = String(raw || '').trim();
    if (!s) return 'Unspecified';
    const lower = s.toLowerCase();
    for (const r of SHRINK_REASONS) {
        if (lower === r.code || lower === r.label.toLowerCase()) return r.label;
    }
    if (/\b(expir\w*|outdat\w*|past\s*date|best\s*before)\b/.test(lower)) return 'Outdated / Expired';
    if (/\b(damag\w*|crush\w*|leak\w*|torn|broken)\b/.test(lower)) return 'Damaged';
    if (/\b(spoil\w*|rot\w*|mold\w*|sour|quality|freezer\s*burn)\b/.test(lower)) return 'Spoil / Quality';
    if (/\b(theft|stolen|missing|unknown)\b/.test(lower)) return 'Theft / Unknown';
    if (/\b(vendor|supplier|defect|short\s*ship)\b/.test(lower)) return 'Vendor defect';
    return 'Other';
}

/**
 * Attach catalog unit retail / unit cost / department to a shrink row and compute
 * line totals. SKUs with no catalog match still export — prices stay blank and
 * the department falls under Unassigned.
 */
function enrichShrinkRow(db, row) {
    const qty = Number(row.quantity);
    const quantity = Number.isFinite(qty) && qty > 0 ? qty : 0;
    const hit = lookupItem(db, row.sku);
    const unitRetail = hit ? money(hit.retail_price) : null;
    const unitCost = hit ? money(hit.unit_cost) : null;
    const lineRetail = unitRetail != null ? money(unitRetail * quantity) : null;
    const lineCost = unitCost != null ? money(unitCost * quantity) : null;
    const department = resolveDepartment(hit?.department) || UNASSIGNED_DEPT;
    const reasonRaw = String(row.reason || '').trim();
    return {
        ...row,
        status: normalizeShrinkStatus(row.status),
        description: row.item || hit?.description || '',
        department,
        reason_bucket: normalizeShrinkReason(reasonRaw),
        catalog_code: hit?.code || null,
        unit_retail: unitRetail,
        unit_cost: unitCost,
        line_retail: lineRetail,
        line_cost: lineCost,
        priced: !!(unitRetail != null || unitCost != null),
    };
}

function emptyDeptBucket(name) {
    return {
        department: name,
        rows: [],
        quantity: 0,
        retail: 0,
        cost: 0,
        line_count: 0,
        priced_lines: 0,
        unpriced_lines: 0,
    };
}

/**
 * Group enriched lines by major department (Grocery, Dairy, …) with per-dept
 * and grand totals — what PRINT / CSV and the on-screen summary both use.
 */
function enrichShrinkRows(db, rows) {
    const enriched = (rows || []).map((r) => enrichShrinkRow(db, r));
    const byDept = new Map();

    for (const r of enriched) {
        const name = r.department || UNASSIGNED_DEPT;
        if (!byDept.has(name)) byDept.set(name, emptyDeptBucket(name));
        const bucket = byDept.get(name);
        bucket.rows.push(r);
        bucket.line_count += 1;
        bucket.quantity += Number(r.quantity) || 0;
        if (r.line_retail != null) bucket.retail += r.line_retail;
        if (r.line_cost != null) bucket.cost += r.line_cost;
        if (r.priced) bucket.priced_lines += 1;
        else bucket.unpriced_lines += 1;
    }

    const departments = [...byDept.values()]
        .map((b) => ({
            ...b,
            quantity: money(b.quantity) ?? b.quantity,
            retail: money(b.retail) || 0,
            cost: money(b.cost) || 0,
        }))
        .sort((a, b) => {
            if (a.department === UNASSIGNED_DEPT) return 1;
            if (b.department === UNASSIGNED_DEPT) return -1;
            return a.department.localeCompare(b.department);
        });

    // Flat row list follows department order so CSV/print stay grouped.
    const orderedRows = departments.flatMap((d) => d.rows);

    let retail = 0;
    let cost = 0;
    let priced = 0;
    let unpriced = 0;
    let quantity = 0;
    for (const d of departments) {
        retail += d.retail;
        cost += d.cost;
        priced += d.priced_lines;
        unpriced += d.unpriced_lines;
        quantity += d.quantity;
    }

    return {
        rows: orderedRows,
        departments,
        totals: {
            quantity: money(quantity) ?? quantity,
            retail: money(retail) || 0,
            cost: money(cost) || 0,
            priced_lines: priced,
            unpriced_lines: unpriced,
            line_count: orderedRows.length,
            department_count: departments.filter((d) => d.department !== UNASSIGNED_DEPT).length,
        },
    };
}

function formatMoney(n) {
    if (n == null || !Number.isFinite(Number(n))) return '';
    return Number(n).toFixed(2);
}

function shrinkReportCsv(storeDate, report) {
    const header = [
        'store_date', 'department', 'status', 'sku', 'item', 'quantity', 'reason', 'zone',
        'unit_retail', 'unit_cost', 'line_retail', 'line_cost',
        'logged_by', 'time_logged', 'catalog_code',
    ];
    const lines = [header.join(',')];
    const departments = report.departments
        || [{ department: '', rows: report.rows || [], quantity: 0, retail: 0, cost: 0 }];

    for (const dept of departments) {
        for (const r of dept.rows) {
            lines.push([
                storeDate,
                r.department || dept.department || UNASSIGNED_DEPT,
                r.status || 'Open',
                r.sku,
                r.description || r.item || '',
                r.quantity,
                r.reason || '',
                r.zone || '',
                formatMoney(r.unit_retail),
                formatMoney(r.unit_cost),
                formatMoney(r.line_retail),
                formatMoney(r.line_cost),
                r.logged_by || '',
                r.time_logged || '',
                r.catalog_code || '',
            ].map(csvEscape).join(','));
        }
        lines.push([
            storeDate,
            `SUBTOTAL ${dept.department || UNASSIGNED_DEPT}`,
            '', '', '',
            formatMoney(dept.quantity),
            '', '', '', '',
            formatMoney(dept.retail),
            formatMoney(dept.cost),
            '', '', '',
        ].map(csvEscape).join(','));
    }

    lines.push([
        storeDate,
        'GRAND TOTAL',
        '', '', '',
        formatMoney(report.totals.quantity),
        '', '', '', '',
        formatMoney(report.totals.retail),
        formatMoney(report.totals.cost),
        '', '', '',
    ].map(csvEscape).join(','));
    return `${lines.join('\r\n')}\r\n`;
}

function escHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function shrinkReportHtml(storeDate, report) {
    const departments = report.departments
        || [{ department: UNASSIGNED_DEPT, rows: report.rows || [], quantity: 0, retail: 0, cost: 0, line_count: 0 }];

    const summaryRows = departments.map((d) => `
      <tr>
        <td>${escHtml(d.department)}</td>
        <td class="num">${escHtml(d.line_count)}</td>
        <td class="num">${escHtml(formatMoney(d.quantity))}</td>
        <td class="num">${escHtml(formatMoney(d.retail))}</td>
        <td class="num">${escHtml(formatMoney(d.cost))}</td>
      </tr>`).join('');

    const detailSections = departments.map((d) => {
        const body = d.rows.map((r) => `
      <tr>
        <td>${escHtml(r.sku)}</td>
        <td>${escHtml(r.description || r.item || '')}</td>
        <td class="num">${escHtml(r.quantity)}</td>
        <td>${escHtml(r.reason || '')}</td>
        <td class="num">${escHtml(formatMoney(r.unit_retail))}</td>
        <td class="num">${escHtml(formatMoney(r.unit_cost))}</td>
        <td class="num">${escHtml(formatMoney(r.line_retail))}</td>
        <td class="num">${escHtml(formatMoney(r.line_cost))}</td>
        <td>${escHtml(r.logged_by || '')}</td>
      </tr>`).join('');
        return `
  <h2>${escHtml(d.department)}</h2>
  <table>
    <thead>
      <tr>
        <th>SKU</th><th>Item</th><th class="num">Qty</th><th>Reason</th>
        <th class="num">Unit retail</th><th class="num">Unit cost</th>
        <th class="num">Line retail</th><th class="num">Line cost</th>
        <th>Logged by</th>
      </tr>
    </thead>
    <tbody>${body || '<tr><td colspan="9">No lines.</td></tr>'}</tbody>
    <tfoot>
      <tr>
        <td colspan="2">${escHtml(d.department)} TOTAL</td>
        <td class="num">${escHtml(formatMoney(d.quantity))}</td>
        <td></td><td></td><td></td>
        <td class="num">${escHtml(formatMoney(d.retail))}</td>
        <td class="num">${escHtml(formatMoney(d.cost))}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>`;
    }).join('\n');

    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Floor Shrink ${escHtml(storeDate)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
  h1 { font-size: 1.25rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 22px 0 8px; border-bottom: 2px solid #333; padding-bottom: 4px; }
  .meta { color: #555; font-size: 0.85rem; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin-bottom: 8px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
  th { background: #f2f2f2; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  tfoot td { font-weight: bold; background: #fafafa; }
  .summary tfoot td { background: #e8e8e8; }
  .note { margin-top: 12px; font-size: 0.8rem; color: #666; }
  @media print { body { margin: 12px; } h2 { break-after: avoid; } }
</style></head><body>
  <h1>Floor Shrink by Department</h1>
  <div class="meta">Store date ${escHtml(storeDate)} · ${report.totals.line_count} line(s)
    · ${report.totals.department_count || 0} department(s)
    · ${report.totals.priced_lines} priced from catalog
    ${report.totals.unpriced_lines ? ` · ${report.totals.unpriced_lines} without catalog price` : ''}</div>

  <h2>Department summary</h2>
  <table class="summary">
    <thead>
      <tr>
        <th>Department</th>
        <th class="num">Lines</th>
        <th class="num">Qty</th>
        <th class="num">Retail</th>
        <th class="num">Cost</th>
      </tr>
    </thead>
    <tbody>${summaryRows || '<tr><td colspan="5">No shrink lines.</td></tr>'}</tbody>
    <tfoot>
      <tr>
        <td>GRAND TOTAL</td>
        <td class="num">${escHtml(report.totals.line_count)}</td>
        <td class="num">${escHtml(formatMoney(report.totals.quantity))}</td>
        <td class="num">${escHtml(formatMoney(report.totals.retail))}</td>
        <td class="num">${escHtml(formatMoney(report.totals.cost))}</td>
      </tr>
    </tfoot>
  </table>

  ${detailSections}

  <p class="note">Departments and prices come from the product catalog (Price List with Cost → S.Dept.). Lines without a catalog match show under Unassigned with blank prices.</p>
  <script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>
</body></html>`;
}

function emptyMoneyBucket() {
    return { quantity: 0, retail: 0, cost: 0, line_count: 0, priced_lines: 0 };
}

function bumpMoneyBucket(bucket, row) {
    bucket.line_count += 1;
    bucket.quantity += Number(row.quantity) || 0;
    if (row.line_retail != null) bucket.retail += row.line_retail;
    if (row.line_cost != null) bucket.cost += row.line_cost;
    if (row.priced) bucket.priced_lines += 1;
}

function finalizeMoneyBucket(bucket) {
    return {
        ...bucket,
        quantity: money(bucket.quantity) ?? bucket.quantity,
        retail: money(bucket.retail) || 0,
        cost: money(bucket.cost) || 0,
        margin_gap: money((bucket.retail || 0) - (bucket.cost || 0)) || 0,
    };
}

function emptyAnalytics(start, end) {
    return {
        start: start || '',
        end: end || '',
        totals: {
            quantity: 0,
            retail: 0,
            cost: 0,
            margin_gap: 0,
            priced_lines: 0,
            unpriced_lines: 0,
            line_count: 0,
            department_count: 0,
            potential_loss_retail: 0,
            financial_loss_cost: 0,
        },
        coverage: {
            priced_pct: 0,
            reasoned_pct: 0,
            dept_pct: 0,
            priced_lines: 0,
            reasoned_lines: 0,
            dept_lines: 0,
            line_count: 0,
        },
        by_department: [],
        by_reason: [],
        by_day: [],
        by_logged_by: [],
        top_skus: [],
        recent_lines: [],
    };
}

/**
 * Multi-day floor shrink analytics for Reports (Learn).
 * Cost = cash already spent; retail = potential sell-through left on the table.
 */
function analyzeFloorShrink(db, opts = {}) {
    const start = String(opts.start || '').trim();
    const end = String(opts.end || opts.start || '').trim();
    const topLimit = Math.min(100, Math.max(5, Number(opts.topSkuLimit) || 25));
    const recentLimit = Math.min(300, Math.max(20, Number(opts.recentLimit) || 100));
    if (!start || !end) return emptyAnalytics(start, end);

    let rawRows;
    try {
        rawRows = db.all(
            `SELECT * FROM floor_shrink_sku
             WHERE store_date BETWEEN ? AND ?
               AND COALESCE(status, 'Open') != 'Voided'
             ORDER BY store_date ASC, time_logged ASC
             LIMIT 10000`,
            start,
            end,
        );
    } catch (_) {
        return emptyAnalytics(start, end);
    }

    const report = enrichShrinkRows(db, rawRows || []);
    const rows = report.rows;

    const byReason = new Map();
    const byDay = new Map();
    const byWho = new Map();
    const bySku = new Map();

    let reasoned = 0;
    let deptAssigned = 0;

    for (const r of rows) {
        const reason = r.reason_bucket || normalizeShrinkReason(r.reason);
        if (reason !== 'Unspecified') reasoned += 1;
        if (r.department && r.department !== UNASSIGNED_DEPT) deptAssigned += 1;

        if (!byReason.has(reason)) byReason.set(reason, { reason, ...emptyMoneyBucket() });
        bumpMoneyBucket(byReason.get(reason), r);

        const day = r.store_date || '';
        if (!byDay.has(day)) byDay.set(day, { store_date: day, ...emptyMoneyBucket() });
        bumpMoneyBucket(byDay.get(day), r);

        const who = String(r.logged_by || '').trim() || 'Unknown';
        if (!byWho.has(who)) byWho.set(who, { logged_by: who, ...emptyMoneyBucket() });
        bumpMoneyBucket(byWho.get(who), r);

        const skuKey = r.catalog_code || String(r.sku || '').replace(/^0+/, '') || r.sku || 'unknown';
        if (!bySku.has(skuKey)) {
            bySku.set(skuKey, {
                sku: r.sku,
                catalog_code: r.catalog_code || null,
                item: r.description || r.item || '',
                department: r.department || UNASSIGNED_DEPT,
                reason_counts: new Map(),
                days: new Set(),
                ...emptyMoneyBucket(),
            });
        }
        const skuBucket = bySku.get(skuKey);
        bumpMoneyBucket(skuBucket, r);
        if ((r.description || r.item) && !skuBucket.item) skuBucket.item = r.description || r.item;
        if (r.department && r.department !== UNASSIGNED_DEPT) skuBucket.department = r.department;
        skuBucket.days.add(day);
        skuBucket.reason_counts.set(reason, (skuBucket.reason_counts.get(reason) || 0) + 1);
    }

    const lineCount = rows.length || 0;
    const pct = (n) => (lineCount ? Math.round((n / lineCount) * 1000) / 10 : 0);

    const top_skus = [...bySku.values()]
        .map((b) => {
            let topReason = 'Unspecified';
            let topN = 0;
            for (const [reason, n] of b.reason_counts) {
                if (n > topN) { topReason = reason; topN = n; }
            }
            const fin = finalizeMoneyBucket(b);
            return {
                sku: b.sku,
                catalog_code: b.catalog_code,
                item: b.item,
                department: b.department,
                primary_reason: topReason,
                days_seen: b.days.size,
                quantity: fin.quantity,
                retail: fin.retail,
                cost: fin.cost,
                margin_gap: fin.margin_gap,
                line_count: fin.line_count,
            };
        })
        .sort((a, b) => (b.cost - a.cost) || (b.retail - a.retail) || (b.quantity - a.quantity))
        .slice(0, topLimit);

    const recent_lines = [...rows]
        .sort((a, b) => {
            const dateCmp = String(b.store_date || '').localeCompare(String(a.store_date || ''));
            if (dateCmp) return dateCmp;
            return String(b.time_logged || '').localeCompare(String(a.time_logged || ''));
        })
        .slice(0, recentLimit)
        .map((r) => ({
            id: r.id,
            store_date: r.store_date,
            sku: r.sku,
            item: r.description || r.item || '',
            department: r.department || UNASSIGNED_DEPT,
            quantity: r.quantity,
            reason: r.reason || '',
            reason_bucket: r.reason_bucket || normalizeShrinkReason(r.reason),
            line_retail: r.line_retail,
            line_cost: r.line_cost,
            logged_by: r.logged_by || '',
            time_logged: r.time_logged || '',
            status: r.status || 'Open',
        }));

    const totals = {
        ...report.totals,
        margin_gap: money((report.totals.retail || 0) - (report.totals.cost || 0)) || 0,
        potential_loss_retail: report.totals.retail || 0,
        financial_loss_cost: report.totals.cost || 0,
    };

    return {
        start,
        end,
        totals,
        coverage: {
            priced_pct: pct(report.totals.priced_lines || 0),
            reasoned_pct: pct(reasoned),
            dept_pct: pct(deptAssigned),
            priced_lines: report.totals.priced_lines || 0,
            reasoned_lines: reasoned,
            dept_lines: deptAssigned,
            line_count: lineCount,
        },
        by_department: (report.departments || []).map((d) => ({
            department: d.department,
            quantity: d.quantity,
            retail: d.retail,
            cost: d.cost,
            margin_gap: money((d.retail || 0) - (d.cost || 0)) || 0,
            line_count: d.line_count,
            priced_lines: d.priced_lines,
        })),
        by_reason: [...byReason.values()]
            .map(finalizeMoneyBucket)
            .sort((a, b) => (b.cost - a.cost) || (b.retail - a.retail)),
        by_day: [...byDay.values()]
            .map(finalizeMoneyBucket)
            .sort((a, b) => String(a.store_date).localeCompare(String(b.store_date))),
        by_logged_by: [...byWho.values()]
            .map(finalizeMoneyBucket)
            .sort((a, b) => (b.line_count - a.line_count) || (b.cost - a.cost))
            .slice(0, 12),
        top_skus,
        recent_lines,
    };
}

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQ && line[i + 1] === '"') { cur += '"'; i += 1; }
            else inQ = !inQ;
        } else if (ch === ',' && !inQ) {
            out.push(cur.trim());
            cur = '';
        } else cur += ch;
    }
    out.push(cur.trim());
    return out;
}

function isCsvTotalRow(sku, item) {
    const s = `${sku || ''} ${item || ''}`.trim().toUpperCase();
    if (!s) return true;
    return /^(SUBTOTAL|GRAND\s*TOTAL|TOTAL)\b/.test(s)
        || /^SUBTOTAL\b/.test(String(sku || '').toUpperCase())
        || /^GRAND\s*TOTAL\b/.test(String(sku || '').toUpperCase());
}

const MAX_SHRINK_UPLOAD_BYTES = 8 * 1024 * 1024;

function shrinkCellText(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        // Keep barcode integers as full digits (avoid 9.78e+12).
        return Number.isInteger(value) ? value.toFixed(0) : String(value);
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        // UTC calendar day — local getters roll back a day west of UTC (e.g. America/Edmonton).
        return value.toISOString().slice(0, 10);
    }
    return String(value).replace(/\s+/g, ' ').trim();
}

function parseShrinkStoreDate(raw) {
    const s = shrinkCellText(raw);
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/);
    if (us) {
        return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
    }
    return '';
}

function isSmsInventoryCountReport(rows) {
    const probe = (rows || []).slice(0, 10).map((r) => (r || []).map(shrinkCellText).join(' ').toLowerCase()).join('\n');
    return probe.includes('inventory count report')
        || (probe.includes('sdept') && (probe.includes('ttlqty') || probe.includes('ttl qty')));
}

/**
 * SMS "Inventory Count Report by SubDepartment" (.xls) — bakery/produce shrink dumps.
 * Qty is COUNT Units only. Variance / TtlQty columns are ignored (junk on these exports).
 */
function parseSmsInventoryCountShrink(rows) {
    const candidates = [];
    const errors = [];
    let storeDate = '';
    let header = null;

    for (let i = 0; i < (rows || []).length; i += 1) {
        const cells = (rows[i] || []).map(shrinkCellText);
        if (!cells.some(Boolean)) continue;
        const lower = cells.map((c) => c.toLowerCase().replace(/\s+/g, ''));
        const rowText = cells.join(' ').toLowerCase();

        if (lower[0] === 'date' || lower[0] === 'date:') {
            storeDate = parseShrinkStoreDate(cells[1]) || storeDate;
        }

        if (lower.includes('sdept') && lower.includes('code') && lower.includes('description')) {
            header = {
                code: lower.indexOf('code'),
                desc: lower.indexOf('description'),
                // First "Units" column is under COUNT (Variance has TtlQty, not Units).
                units: lower.indexOf('units'),
            };
            continue;
        }

        if (!header) continue;
        if (/sub\s*department\s*totals|pda inventory|report summary|printed\s*:|page \d+\s*of|inventory count report/.test(rowText)) {
            continue;
        }
        if (/^sub\s*department/i.test(cells[0]) || /^sub\s*department/i.test(cells[header.desc] || '')) {
            continue;
        }
        // Product lines start with a numeric S.Dept code.
        if (!/^\d{1,4}$/.test(cells[0] || '')) continue;

        const sku = String(cells[header.code] || '').replace(/\s+/g, '');
        const item = cells[header.desc] || '';
        const digits = sku.replace(/\D/g, '');
        if (!sku || digits.length < 4) {
            errors.push(`Row ${i + 1}: missing/short code`);
            continue;
        }

        const units = header.units >= 0 ? Number(String(cells[header.units] || '').replace(/,/g, '')) : NaN;
        if (!Number.isFinite(units) || units === 0) {
            errors.push(`Row ${i + 1}: ${sku} has no COUNT Units`);
            continue;
        }
        const quantity = Math.round(Math.abs(units) * 1000) / 1000;

        candidates.push({
            sku: digits.length >= 4 ? digits : sku,
            item,
            quantity,
            reason: 'Inventory count',
            zone: '',
            store_date: storeDate,
            row: i + 1,
        });
    }

    return {
        ok: candidates.length > 0,
        error: candidates.length ? '' : (errors.slice(0, 5).join(' ') || 'No product rows found in Inventory Count Report.'),
        candidates,
        errors,
        headers: ['sdept', 'code', 'description', 'units'],
        has_store_date_column: !!storeDate,
        store_date: storeDate,
        format: 'sms_inventory_count',
    };
}

/**
 * Parse old-way or TGP export shrink CSVs into candidate lines.
 * Accepts sku/upc/code, qty, item, reason, store_date, zone (not department-as-zone).
 */
function parseShrinkImportCsv(rawText) {
    const raw = String(rawText || '').replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
        return { ok: false, error: 'CSV needs a header row and at least one data row.', candidates: [], errors: [], headers: [] };
    }

    const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    const idx = (names) => {
        for (const n of names) {
            const i = headers.indexOf(n);
            if (i >= 0) return i;
        }
        return -1;
    };
    const iSku = idx(['sku', 'upc', 'item_code', 'code', 'barcode', 'item_upc']);
    const iItem = idx(['item', 'description', 'name', 'product', 'item_name']);
    const iQty = idx(['quantity', 'qty', 'count', 'amount', 'units']);
    const iReason = idx(['reason', 'shrink_reason', 'cause', 'reason_bucket']);
    // Zone only — do not treat department as zone (TGP export has a department column).
    const iZone = idx(['zone', 'aisle', 'location', 'area']);
    const iDate = idx(['store_date', 'date', 'business_date', 'count_date', 'day']);
    if (iSku < 0) {
        return {
            ok: false,
            error: 'CSV must include a sku/upc/item_code/code column.',
            candidates: [],
            errors: [],
            headers,
        };
    }

    const candidates = [];
    const errors = [];
    for (let r = 1; r < lines.length; r += 1) {
        const cols = splitCsvLine(lines[r]);
        if (!cols.some(Boolean)) continue;
        const skuRaw = String(cols[iSku] || '').trim();
        const item = iItem >= 0 ? String(cols[iItem] || '').trim() : '';
        if (isCsvTotalRow(skuRaw, item)) continue;
        // Skip status/department-only noise from re-imported TGP exports when SKU cell is a date.
        if (/^\d{4}-\d{2}-\d{2}$/.test(skuRaw) && iDate < 0) {
            errors.push(`Row ${r + 1}: skipped date-looking SKU`);
            continue;
        }
        const sku = skuRaw.replace(/\s+/g, '');
        if (!sku) {
            errors.push(`Row ${r + 1}: missing SKU`);
            continue;
        }
        let quantity = iQty >= 0 ? Number(String(cols[iQty] || '').replace(/,/g, '')) : 1;
        if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;
        let storeDate = '';
        if (iDate >= 0) {
            const d = parseShrinkStoreDate(cols[iDate]);
            if (d) storeDate = d;
            else if (String(cols[iDate] || '').trim()) errors.push(`Row ${r + 1}: bad store_date "${cols[iDate]}"`);
        }
        candidates.push({
            sku,
            item,
            quantity,
            reason: iReason >= 0 ? String(cols[iReason] || '').trim().slice(0, 200) : '',
            zone: iZone >= 0 ? String(cols[iZone] || '').trim() : '',
            store_date: storeDate,
            row: r + 1,
        });
    }

    return {
        ok: candidates.length > 0,
        error: candidates.length ? '' : (errors.join(' ') || 'No valid shrink rows.'),
        candidates,
        errors,
        headers,
        has_store_date_column: iDate >= 0,
        format: 'csv',
    };
}

/**
 * Decode CSV or SMS Excel (.xls / .xlsx) shrink uploads into candidate lines.
 */
async function parseShrinkImportUpload(filename, contentBase64) {
    const safeName = String(filename || '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120) || 'shrink';
    const buf = Buffer.from(String(contentBase64 || ''), 'base64');
    if (!buf.length) {
        return { ok: false, error: 'Upload is empty.', candidates: [], errors: [], headers: [] };
    }
    if (buf.length > MAX_SHRINK_UPLOAD_BYTES) {
        return { ok: false, error: 'Upload is too large. Maximum shrink file size is 8 MB.', candidates: [], errors: [], headers: [] };
    }

    if (/\.csv$/i.test(safeName)) {
        const parsed = parseShrinkImportCsv(buf.toString('utf8'));
        return { ...parsed, filename: safeName };
    }

    if (!/\.xlsx?$/i.test(safeName)) {
        return {
            ok: false,
            error: 'Upload must be a .xls, .xlsx, or .csv file (SMS Inventory Count Report or simple SKU CSV).',
            candidates: [],
            errors: [],
            headers: [],
            filename: safeName,
        };
    }

    let rows = [];
    try {
        const wb = await readSpreadsheetBuffer(buf, safeName);
        if (!wb.sheets.length) {
            return { ok: false, error: 'Excel file has no sheets.', candidates: [], errors: [], headers: [], filename: safeName };
        }
        for (const sheet of wb.sheets) {
            const rawRows = sheetToObjects(sheet, { header: 1 });
            const grid = (rawRows || [])
                .map((row) => (Array.isArray(row) ? row : []).map((c) => (c == null ? '' : c)))
                .filter((row) => row.some((c) => c !== ''));
            rows = rows.concat(grid);
        }
    } catch (e) {
        return {
            ok: false,
            error: `Could not parse Excel file: ${e.message}`,
            candidates: [],
            errors: [],
            headers: [],
            filename: safeName,
        };
    }

    if (isSmsInventoryCountReport(rows)) {
        const parsed = parseSmsInventoryCountShrink(rows);
        return { ...parsed, filename: safeName };
    }

    // Generic spreadsheet: find a header row with sku/code and reuse CSV parser.
    let headerAt = -1;
    for (let i = 0; i < Math.min(rows.length, 40); i += 1) {
        const cells = (rows[i] || []).map(shrinkCellText);
        const lower = cells.map((c) => c.toLowerCase().replace(/\s+/g, '_'));
        if (lower.some((h) => ['sku', 'upc', 'item_code', 'code', 'barcode'].includes(h))) {
            headerAt = i;
            break;
        }
    }
    if (headerAt < 0) {
        return {
            ok: false,
            error: 'Could not find a Code/SKU header. For SMS exports use Inventory Count Report by SubDepartment.',
            candidates: [],
            errors: [],
            headers: [],
            filename: safeName,
        };
    }
    const csvLines = rows.slice(headerAt).map((r) => (r || []).map((c) => {
        const t = shrinkCellText(c);
        return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    }).join(','));
    const parsed = parseShrinkImportCsv(csvLines.join('\n'));
    return { ...parsed, filename: safeName, format: parsed.format || 'excel' };
}

function newShrinkSessionId() {
    return `FSS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function enrichShrinkSessionRow(db, s) {
    const lines = db.all(
        `SELECT status, quantity FROM floor_shrink_sku WHERE session_id = ?`,
        s.id,
    ) || [];
    const open = lines.filter((l) => normalizeShrinkStatus(l.status) === 'Open').length;
    const closed = lines.filter((l) => normalizeShrinkStatus(l.status) === 'Closed').length;
    const voided = lines.filter((l) => normalizeShrinkStatus(l.status) === 'Voided').length;
    const qty = lines
        .filter((l) => normalizeShrinkStatus(l.status) !== 'Voided')
        .reduce((sum, l) => sum + (Number(l.quantity) || 0), 0);
    return {
        ...s,
        line_count: open + closed,
        open_lines: open,
        closed_lines: closed,
        voided_lines: voided,
        quantity: money(qty) ?? qty,
    };
}

function listShrinkSessions(db, storeDate) {
    const rows = db.all(
        `SELECT * FROM floor_shrink_sessions WHERE store_date = ? ORDER BY datetime(created_at) DESC`,
        storeDate,
    ) || [];
    return rows.map((s) => enrichShrinkSessionRow(db, s));
}

/** Recent walks across dates so historical CSV/XLS imports stay visible in Markdown. */
function listRecentShrinkSessions(db, opts = {}) {
    const limit = Math.min(100, Math.max(5, Number(opts.limit) || 40));
    const rows = db.all(
        `SELECT * FROM floor_shrink_sessions
          ORDER BY store_date DESC, datetime(created_at) DESC
          LIMIT ?`,
        limit,
    ) || [];
    return rows.map((s) => enrichShrinkSessionRow(db, s));
}

function createShrinkSession(db, {
    storeDate, label, createdBy, source = 'manual', status = 'open', notes = '', now,
} = {}) {
    const stamp = now || new Date().toISOString();
    const id = newShrinkSessionId();
    const cleanLabel = String(label || '').trim().slice(0, 80) || 'Shrink walk';
    const sessStatus = status === 'closed' ? 'closed' : 'open';
    db.run(
        `INSERT INTO floor_shrink_sessions
            (id, store_date, label, status, source, created_at, created_by, closed_at, closed_by, notes)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id,
        storeDate,
        cleanLabel,
        sessStatus,
        String(source || 'manual').slice(0, 40),
        stamp,
        String(createdBy || '').slice(0, 80),
        sessStatus === 'closed' ? stamp : '',
        sessStatus === 'closed' ? String(createdBy || '').slice(0, 80) : '',
        String(notes || '').slice(0, 300),
    );
    return db.get('SELECT * FROM floor_shrink_sessions WHERE id = ?', id);
}

function getShrinkSession(db, sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return null;
    return db.get('SELECT * FROM floor_shrink_sessions WHERE id = ?', id) || null;
}

function runInTransaction(db, fn) {
    if (typeof db.transaction === 'function') {
        db.transaction(fn)();
        return;
    }
    fn();
}

function closeShrinkSession(db, { sessionId, closedBy, now } = {}) {
    const stamp = now || new Date().toISOString();
    const sess = getShrinkSession(db, sessionId);
    if (!sess) return { ok: false, error: 'Shrink count not found.' };
    if (sess.status === 'closed') return { ok: false, error: 'That shrink count is already closed.' };
    const open = db.all(
        `SELECT id FROM floor_shrink_sku WHERE session_id = ? AND COALESCE(status,'Open') = 'Open'`,
        sess.id,
    ) || [];
    runInTransaction(db, () => {
        for (const row of open) {
            db.run(
                `UPDATE floor_shrink_sku SET status = 'Closed', closed_at = ?, closed_by = ? WHERE id = ?`,
                stamp, String(closedBy || ''), row.id,
            );
        }
        db.run(
            `UPDATE floor_shrink_sessions SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?`,
            stamp, String(closedBy || ''), sess.id,
        );
    });
    return { ok: true, session: getShrinkSession(db, sess.id), closed: open.length };
}

function reopenShrinkSession(db, { sessionId, reopenedBy, now } = {}) {
    const stamp = now || new Date().toISOString();
    const sess = getShrinkSession(db, sessionId);
    if (!sess) return { ok: false, error: 'Shrink count not found.' };
    const closed = db.all(
        `SELECT id FROM floor_shrink_sku WHERE session_id = ? AND status = 'Closed'`,
        sess.id,
    ) || [];
    runInTransaction(db, () => {
        for (const row of closed) {
            db.run(
                `UPDATE floor_shrink_sku SET status = 'Open', closed_at = '', closed_by = '' WHERE id = ?`,
                row.id,
            );
        }
        db.run(
            `UPDATE floor_shrink_sessions
                SET status = 'open', closed_at = '', closed_by = ?
              WHERE id = ?`,
            '',
            sess.id,
        );
    });
    return { ok: true, session: getShrinkSession(db, sess.id), reopened: closed.length, at: stamp, by: reopenedBy };
}

module.exports = {
    SHRINK_STATUSES,
    SHRINK_REASONS,
    UNASSIGNED_DEPT,
    normalizeShrinkStatus,
    normalizeShrinkReason,
    enrichShrinkRow,
    enrichShrinkRows,
    analyzeFloorShrink,
    shrinkReportCsv,
    shrinkReportHtml,
    parseShrinkImportCsv,
    parseShrinkImportUpload,
    parseSmsInventoryCountShrink,
    MAX_SHRINK_UPLOAD_BYTES,
    listShrinkSessions,
    listRecentShrinkSessions,
    createShrinkSession,
    getShrinkSession,
    closeShrinkSession,
    reopenShrinkSession,
};
