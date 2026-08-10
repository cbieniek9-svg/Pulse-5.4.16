'use strict';

const { parseFlexibleDate, ZONE_CANONICAL } = require('./markdown-parse.cjs');
const { normalizeDate } = require('./staff-schedule-import.cjs');
const { parseKillDate } = require('./markdown-excel-import.cjs');

const FIFO_HEADER_ALIASES = {
    date_logged: ['datelogged', 'date logged', 'logged', 'logdate'],
    aisle: ['aislelocation', 'aisle', 'location'],
    item_code: ['vendorcode', 'vendor code', 'code', 'upc', 'tag'],
    item: ['itemdescription', 'item description', 'description', 'product', 'item'],
    quantity: ['quantity', 'qty', 'count'],
    kill_date: ['expirationdate', 'expiration date', 'expdate', 'exp date', 'expiry', 'killdate', 'kill date'],
    notes: ['actiontakennotes', 'action taken notes', 'notes', 'action', 'comment'],
};

function normalizeHeader(v) {
    return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeAisleLocation(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { zone: 'General', aisle: '' };
    const lower = text.toLowerCase();
    if (lower.includes('bakery')) return { zone: 'Bakery', aisle: 'Bakery' };
    const m = text.match(/aisle\s*(\d{1,2})/i) || text.match(/^A?\s*(\d{1,2})$/i);
    if (m) {
        const label = `A${parseInt(m[1], 10)}`;
        return { zone: ZONE_CANONICAL.includes(label) ? label : 'General', aisle: label };
    }
    if (lower.includes('till')) return { zone: 'General', aisle: 'Tills' };
    const direct = ZONE_CANONICAL.find((z) => z.toLowerCase() === lower);
    if (direct) return { zone: direct, aisle: direct };
    return { zone: 'General', aisle: text.slice(0, 40) };
}

function isFifoAuditHeaderRow(row) {
    const joined = (row || []).map((c) => normalizeHeader(c)).join('|');
    return /aisle|location/.test(joined)
        && /vendor|code/.test(joined)
        && /expir|kill|date/.test(joined)
        && /description|item|product/.test(joined);
}

/**
 * @param {Array<Array>} rows
 * @param {number} refYear
 */
function rowsToFifoAuditCandidates(rows, refYear = new Date().getFullYear()) {
    const nonEmpty = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    if (!nonEmpty.length) return { candidates: [], errors: ['No data rows found.'], format: 'fifo' };

    const headerRow = nonEmpty.find(isFifoAuditHeaderRow);
    if (!headerRow) return { candidates: [], errors: ['Not a FIFO Audit Log sheet (missing expected headers).'], format: 'fifo' };

    const headerIdx = nonEmpty.indexOf(headerRow);
    const colMap = {};
    headerRow.forEach((cell, idx) => {
        const key = normalizeHeader(cell);
        if (!key) return;
        for (const [field, aliases] of Object.entries(FIFO_HEADER_ALIASES)) {
            if (aliases.includes(key) && colMap[field] == null) colMap[field] = idx;
        }
    });

    const errors = [];
    const candidates = [];
    for (let i = headerIdx + 1; i < nonEmpty.length; i++) {
        const row = nonEmpty[i];
        const rowNum = i + 1;
        const item = colMap.item != null ? String(row[colMap.item] ?? '').trim() : '';
        const itemCode = colMap.item_code != null ? String(row[colMap.item_code] ?? '').trim() : '';
        const aisleRaw = colMap.aisle != null ? row[colMap.aisle] : '';
        const killDateRaw = colMap.kill_date != null ? row[colMap.kill_date] : '';
        const kill_date = parseKillDate(killDateRaw, refYear);
        const { zone } = normalizeAisleLocation(aisleRaw);

        if (!item && !itemCode && !kill_date && !String(aisleRaw ?? '').trim()) continue;
        if (!item) {
            errors.push(`Row ${rowNum}: missing item description.`);
            continue;
        }
        if (!kill_date) {
            errors.push(`Row ${rowNum}: invalid expiration date "${String(killDateRaw ?? '').trim()}".`);
            continue;
        }

        candidates.push({
            row: rowNum,
            item: item.slice(0, 200),
            item_code: itemCode.slice(0, 64),
            zone,
            kill_date,
            status: 'Active',
            notes: colMap.notes != null ? String(row[colMap.notes] ?? '').trim().slice(0, 200) : '',
            date_logged: colMap.date_logged != null ? normalizeDate(row[colMap.date_logged], refYear) : '',
            quantity: colMap.quantity != null ? String(row[colMap.quantity] ?? '').trim() : '',
        });
    }

    if (!candidates.length && !errors.length) errors.push('No valid FIFO audit rows found after the header row.');
    return { candidates, errors, format: 'fifo' };
}

function detectExcelImportFormat(rows) {
    const nonEmpty = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    if (nonEmpty.some(isFifoAuditHeaderRow)) return 'fifo';
    return 'markdown';
}

module.exports = {
    rowsToFifoAuditCandidates,
    detectExcelImportFormat,
    normalizeAisleLocation,
    isFifoAuditHeaderRow,
};
