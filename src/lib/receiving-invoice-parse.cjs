'use strict';

const KNOWN_SUPPLIERS = [
    'THE GROCERY PEOPLE',
    'TGP',
    'SAPUTO DAIRY PRODUCTS',
    'SAPUTO',
    'COCA COLA CANADA BOTTLING',
    'COCA COLA',
    'PEPSICO',
    'PEPSI',
    'FRITO LAY CANADA',
    'FRITO LAY',
    'OLD DUTCH FOODS',
    'OLD DUTCH',
    'CANADA BREAD COMPANY',
    'CANADA BREAD',
    'ITALIAN BAKERY',
    'STAR PRODUCE',
    'RED BULL CANADA',
    'NELLA WEST',
    'SEVEN SEAS FISH CO',
    'G & L DISTRIBUTORS',
    'ALTA AGRI-FOODS LTD',
    'PACIFIC FRESH FISH',
    'LILYDALE SOFINA FOODS',
    'UNITED DISTRIBUTION NETWORK',
    'DIRECT PLUS',
];

const REASON_PATTERNS = [
    { re: /\b50\s*%\s*credit\b/i, reason: '50% CREDIT' },
    { re: /\bshort(?:ed|ship)?\b/i, reason: 'SHORTED' },
    { re: /\bdamaged?\b/i, reason: 'DAMAGED' },
    { re: /\bout\s*dated\b|\boutdated\b/i, reason: 'OUTDATED' },
    { re: /\bpricing\s*error\b/i, reason: 'PRICING ERROR' },
    { re: /\bpoor\s*quality\b/i, reason: 'POOR QUALITY' },
    { re: /\brestocking\b|\bclaim\b/i, reason: 'RESTOCKING/CLAIM' },
    { re: /\bstore\s*transfer\b/i, reason: 'STORE TRANSFER' },
    { re: /\bwrite\s*off\b/i, reason: 'WRITE OFF' },
    { re: /\brecall\b/i, reason: 'RECALL' },
    { re: /\bmisc\b/i, reason: 'MISC' },
];

const DEPT_KEYWORDS = {
    dairy: /\b(dairy|milk|egg|yogurt|oikos|danone|cheese|cream|butter|intl delight|cottage)\b/i,
    meat: /\b(meat|beef|pork|chicken|turkey|sausage|bacon|deli meat|grimm)\b/i,
    produce: /\b(produce|tomato|onion|lettuce|apple|banana|potato|pepper|fruit|veg)\b/i,
    bakery: /\b(bakery|bread|bun|roll|muffin|bagel)\b/i,
    tobacco: /\b(tobacco|cigarette|cigar)\b/i,
    pharmacy: /\b(pharmacy|rx|otc)\b/i,
};

function roundMoney(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.round(v * 100) / 100;
}

function parseMoney(raw) {
    if (raw == null || raw === '') return null;
    let s = String(raw).replace(/[$,\s]/g, '').replace(/^\((.+)\)$/, '-$1');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? roundMoney(n) : null;
}

function extractAllMoney(line) {
    const s = String(line || '');
    const matches = s.match(/-?\(\$?\d[\d,]*\.\d{2}\)|-?\$\d[\d,]*\.\d{2}|(?:^|\s)(-\d[\d,]*\.\d{2})(?=\s|$)|(?:^|\s)(\d[\d,]*\.\d{2})(?=\s|$)/g) || [];
    return matches
        .map((token) => parseMoney(token))
        .filter((v) => v != null && Math.abs(v) < 1000000);
}

function detectReason(text) {
    const s = String(text || '');
    for (const p of REASON_PATTERNS) {
        if (p.re.test(s)) return p.reason;
    }
    if (/-/.test(s) && parseMoney(s) != null && parseMoney(s) < 0) return 'CREDIT/ADJUSTMENT';
    return '';
}

function detectDepartment(text) {
    const s = String(text || '');
    for (const [dept, re] of Object.entries(DEPT_KEYWORDS)) {
        if (re.test(s)) return dept;
    }
    return 'grocery';
}

function normalizeSupplier(raw) {
    const s = String(raw || '').trim().toUpperCase();
    if (!s) return '';
    const hit = KNOWN_SUPPLIERS.find((name) => s.includes(name) || name.includes(s));
    return hit || s;
}

function extractInvoiceNumber(text) {
    const s = String(text || '');
    let m = s.match(/\binvoice(?:\s*(?:no|number|#))?\s*[:#-]?\s*([A-Z0-9-]{4,20})/i);
    if (m) return m[1].trim();
    m = s.match(/\b(?:inv|credit)\s*#?\s*[:#-]?\s*([A-Z0-9-]{4,20})/i);
    if (m) return m[1].trim();
    m = s.match(/^([0-9]{5,12})\b/);
    if (m) return m[1];
    m = s.match(/\b([0-9]{7,12})\b/);
    return m ? m[1] : '';
}

function extractSkuToken(line) {
    const s = String(line || '').trim();
    let m = s.match(/\b(?:sku|upc|item\s*#?|code)\s*[:#-]?\s*([A-Z0-9-]{4,20})/i);
    if (m) return m[1].trim();
    m = s.match(/^([0-9]{5,14})\b/);
    if (m) return m[1];
    m = s.match(/\b([0-9]{8,14})\b/);
    return m ? m[1] : '';
}

function looksLikeHeaderNoise(line) {
    return /^(page\s+\d+|total\b|subtotal\b|gst\b|hst\b|continued\b|printed\b|tel\b|phone\b|fax\b|www\.|http)/i.test(line);
}

function detectDocType(text) {
    const s = String(text || '');
    const shrinkHits = (s.match(/\b(credit|shorted|damaged|outdated|pricing error|write off|claim|shrink)\b/gi) || []).length;
    const invoiceHits = (s.match(/\b(invoice|bill of lading|delivery receipt|purchase order)\b/gi) || []).length;
    if (shrinkHits >= 2 && shrinkHits >= invoiceHits) return 'shrink';
    if (invoiceHits >= 1) return 'invoice';
    if (shrinkHits >= 1) return 'shrink';
    return 'invoice';
}

function parseLineItem(line, context = {}) {
    if (!line || looksLikeHeaderNoise(line)) return null;
    const money = extractAllMoney(line);
    if (!money.length) return null;

    const extended = money[money.length - 1];
    const sku = extractSkuToken(line);
    const reason = detectReason(line);
    const department = detectDepartment(line);
    let description = line
        .replace(/\b(?:sku|upc|item\s*#?|code)\s*[:#-]?\s*[A-Z0-9-]+\b/ig, '')
        .replace(/-?\(?\$?\d[\d,]*(?:\.\d{2})?\)?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (sku) description = description.replace(new RegExp(`^${sku}\\b`), '').trim();

    const qtyMatch = line.match(/\b(?:qty|quantity)\s*[:#-]?\s*(\d+(?:\.\d+)?)/i);
    const quantity = qtyMatch ? Number(qtyMatch[1]) : 1;
    const unitCost = money.length > 1 ? money[money.length - 2] : null;

    if (!description && !sku && extended == null) return null;

    return {
        sku,
        description: description || sku || 'Line item',
        quantity: Number.isFinite(quantity) ? quantity : 1,
        unit_cost: unitCost,
        extended_cost: extended,
        reason: reason || context.defaultReason || '',
        department,
        invoice_number: context.invoiceNumber || '',
        supplier_name: context.supplierName || '',
    };
}

function rollupDepartments(shrinkLines) {
    const totals = {
        grocery: 0,
        tobacco: 0,
        meat: 0,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0,
        produce_shrink: 0,
        dairy: 0,
        pharmacy: 0,
        gst: 0,
    };
    shrinkLines.forEach((line) => {
        const amt = roundMoney(line.extended_cost);
        const dept = String(line.department || 'grocery').toLowerCase();
        // Negative produce belongs only in produce_shrink — never also in produce,
        // or calcLineTotal (produce + produce_shrink) double-counts the same shrink.
        if (dept === 'produce_shrink' || (dept === 'produce' && amt < 0)) {
            totals.produce_shrink += amt;
        } else if (Object.prototype.hasOwnProperty.call(totals, dept)) {
            totals[dept] += amt;
        } else {
            totals.grocery += amt;
        }
    });
    Object.keys(totals).forEach((k) => { totals[k] = roundMoney(totals[k]); });
    return totals;
}

function parseReceivingDocumentText(text, opts = {}) {
    const raw = String(text || '').replace(/\r/g, '\n');
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    const errors = [];
    const docType = opts.doc_type && opts.doc_type !== 'auto'
        ? String(opts.doc_type).toLowerCase()
        : detectDocType(raw);

    let invoiceNumber = '';
    let supplierName = '';
    let invoiceTotal = null;
    const shrinkCandidates = [];

    for (const line of lines) {
        if (!invoiceNumber) {
            const found = extractInvoiceNumber(line);
            if (found) invoiceNumber = found;
        }
        if (!supplierName) {
            const supplierHit = KNOWN_SUPPLIERS.find((name) => line.toUpperCase().includes(name));
            if (supplierHit) supplierName = supplierHit;
        }
        if (invoiceTotal == null && /\b(invoice total|total invoice|amount due)\b/i.test(line)) {
            const money = extractAllMoney(line);
            if (money.length) invoiceTotal = money[money.length - 1];
        }
    }

    supplierName = normalizeSupplier(supplierName);
    const defaultReason = detectReason(raw);

    lines.forEach((line) => {
        const item = parseLineItem(line, {
            invoiceNumber,
            supplierName,
            defaultReason,
        });
        if (!item) return;
        if (Math.abs(item.extended_cost) < 0.005 && !item.sku) return;
        shrinkCandidates.push(item);
    });

    if (!invoiceNumber && shrinkCandidates.length) {
        invoiceNumber = shrinkCandidates[0].invoice_number || extractInvoiceNumber(lines[0] || '');
    }

    const deptTotals = rollupDepartments(shrinkCandidates);
    if (invoiceTotal == null) {
        invoiceTotal = roundMoney(shrinkCandidates.reduce((s, r) => s + Number(r.extended_cost || 0), 0));
    }

    const notes = shrinkCandidates
        .map((r) => r.reason)
        .filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i)
        .slice(0, 3)
        .join('; ');

    const invoiceCandidate = {
        line_kind: docType === 'shrink' ? 'write_off' : 'invoice',
        invoice_number: invoiceNumber,
        supplier_name: supplierName || 'UNKNOWN SUPPLIER',
        notes,
        ...deptTotals,
    };

    if (!shrinkCandidates.length) {
        errors.push('No SKU/amount lines detected — try a clearer PDF scan or enter manually.');
    }
    if (!invoiceNumber) errors.push('Invoice number not detected — verify before import.');
    if (!supplierName) errors.push('Supplier not detected — verify before import.');

    return {
        doc_type: docType,
        invoice_candidate: invoiceCandidate,
        shrink_candidates: shrinkCandidates,
        summary: {
            line_count: shrinkCandidates.length,
            total_shrink: roundMoney(shrinkCandidates.reduce((s, r) => s + Number(r.extended_cost || 0), 0)),
            sku_count: new Set(shrinkCandidates.map((r) => r.sku).filter(Boolean)).size,
            departments: deptTotals,
        },
        errors,
        stats: {
            ocr_lines: lines.length,
            invoice_number: invoiceNumber,
            supplier_name: supplierName,
        },
    };
}

module.exports = {
    parseReceivingDocumentText,
    parseMoney,
    detectDepartment,
    detectReason,
    rollupDepartments,
    roundMoney,
};
