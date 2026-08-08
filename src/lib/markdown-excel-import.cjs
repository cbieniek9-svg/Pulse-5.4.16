'use strict';

const { parseFlexibleDate, ZONE_CANONICAL } = require('./markdown-parse.cjs');
const { normalizeDate } = require('./staff-schedule-import.cjs');
const { readSpreadsheetBuffer, sheetToObjects } = require('./spreadsheet-read.cjs');

const MAX_SPREADSHEET_BYTES = 5 * 1024 * 1024;

const MARKDOWN_HEADER_ALIASES = {
    item: ['item', 'description', 'product', 'itemname', 'item name', 'productname', 'product name'],
    item_code: ['vendorcode', 'vendor code', 'code', 'upc', 'tag', 'shelftag', 'shelf tag', 'itemcode', 'item code', 'sku'],
    kill_date: ['killdate', 'kill date', 'expiration', 'expirationdate', 'expiration date', 'expdate', 'exp date', 'expiry', 'expirydate', 'bestbefore', 'best before', 'bbdate', 'outdate', 'out date'],
    zone: ['zone', 'area', 'department', 'dept'],
    aisle: ['aisle', 'aisle#', 'aisleno', 'aisle no', 'aislenumber'],
};

function normalizeHeader(v) {
    return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function zoneFromAisle(aisleRaw) {
    const n = parseInt(String(aisleRaw ?? '').replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < 1) return '';
    const label = `A${n}`;
    return ZONE_CANONICAL.includes(label) ? label : 'General';
}

function normalizeZone(raw, aisleRaw) {
    const z = String(raw ?? '').trim();
    if (z) {
        const aisleMatch = z.match(/^A?\s*(\d{1,2})$/i);
        if (aisleMatch) {
            const fixed = `A${parseInt(aisleMatch[1], 10)}`;
            if (ZONE_CANONICAL.includes(fixed)) return fixed;
        }
        const match = ZONE_CANONICAL.find((c) => c.toLowerCase() === z.toLowerCase());
        if (match) return match;
    }
    return zoneFromAisle(aisleRaw) || 'General';
}

function parseKillDate(raw, refYear) {
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
        return raw.toISOString().slice(0, 10);
    }
    const fromFlexible = parseFlexibleDate(raw, refYear);
    if (fromFlexible) return fromFlexible;
    return normalizeDate(raw, refYear);
}

async function parseMarkdownExcelUpload(filename, contentBase64) {
    const safeName = String(filename || '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120) || 'markdown';
    const buf = Buffer.from(String(contentBase64 || ''), 'base64');
    if (!buf.length) return { safeName, rows: [], errors: ['Empty upload.'] };
    if (buf.length > MAX_SPREADSHEET_BYTES) return { safeName, rows: [], errors: ['Upload is too large. Maximum spreadsheet size is 5 MB.'] };

    if (/\.csv$/i.test(safeName)) {
        const text = buf.toString('utf8');
        const rows = [];
        let row = [];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
                else if (ch === '"') quoted = false;
                else cell += ch;
            } else if (ch === '"') quoted = true;
            else if (ch === ',') { row.push(cell); cell = ''; }
            else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
            else if (ch === '\n' || ch === '\r') { row.push(cell); rows.push(row); row = []; cell = ''; }
            else cell += ch;
        }
        if (cell.length || row.length) { row.push(cell); rows.push(row); }
        return { safeName, rows, errors: [] };
    }

    if (/\.xlsx?$/i.test(safeName)) {
        try {
            const wb = await readSpreadsheetBuffer(buf, safeName);
            const sheet = wb.sheets[0];
            if (!sheet) return { safeName, rows: [], errors: ['Excel file has no sheets.'] };
            // Keep Date cells as Date (parseKillDate handles them); only null → ''.
            const rows = sheetToObjects(sheet, { header: 1 })
                .map((row) => (Array.isArray(row) ? row : []).map((c) => (c == null ? '' : c)))
                .filter((row) => row.some((c) => c !== ''));
            return { safeName, rows, errors: [] };
        } catch (e) {
            return { safeName, rows: [], errors: [`Could not parse Excel file: ${e.message}`] };
        }
    }

    return { safeName, rows: [], errors: ['Upload must be a .xlsx, .xls, or .csv file.'] };
}

/**
 * @param {Array<Array>} rows
 * @param {number} refYear
 */
function rowsToKillDateCandidates(rows, refYear = new Date().getFullYear()) {
    const nonEmpty = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    if (!nonEmpty.length) return { candidates: [], errors: ['No data rows found.'] };

    const headerRow = nonEmpty.find((r) => {
        const joined = r.map((c) => normalizeHeader(c)).join('|');
        return /item|description|product/.test(joined) && (/exp|kill|best|date/.test(joined) || /vendor|code|upc/.test(joined));
    }) || nonEmpty[0];

    const headerIdx = nonEmpty.indexOf(headerRow);
    const colMap = {};
    headerRow.forEach((cell, idx) => {
        const key = normalizeHeader(cell);
        if (!key) return;
        for (const [field, aliases] of Object.entries(MARKDOWN_HEADER_ALIASES)) {
            if (aliases.includes(key) && colMap[field] == null) colMap[field] = idx;
        }
    });

    if (colMap.item == null) return { candidates: [], errors: ['Missing Item/Description column. Use headers: Item, Vendor Code, Expiration Date, Zone (optional).'] };
    if (colMap.kill_date == null) return { candidates: [], errors: ['Missing Expiration/Kill Date column.'] };

    const errors = [];
    const candidates = [];
    for (let i = headerIdx + 1; i < nonEmpty.length; i++) {
        const row = nonEmpty[i];
        const rowNum = i + 1;
        const item = String(row[colMap.item] ?? '').trim();
        const itemCode = colMap.item_code != null ? String(row[colMap.item_code] ?? '').trim() : '';
        const killDateRaw = row[colMap.kill_date];
        const kill_date = parseKillDate(killDateRaw, refYear);
        const aisleRaw = colMap.aisle != null ? row[colMap.aisle] : '';
        const zone = normalizeZone(colMap.zone != null ? row[colMap.zone] : '', aisleRaw);

        if (!item && !itemCode && !kill_date) continue;
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
        });
    }

    if (!candidates.length && !errors.length) errors.push('No valid expiry rows found after the header row.');
    return { candidates, errors };
}

module.exports = {
    parseMarkdownExcelUpload,
    rowsToKillDateCandidates,
    normalizeZone,
    parseKillDate,
};
