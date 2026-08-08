'use strict';

const { readSpreadsheetBuffer, sheetToObjects } = require('./spreadsheet-read.cjs');

/**
 * Store item catalog: one description per code, so scanning a shelf tag or barcode
 * fills the item in instead of being retyped every time.
 *
 * Two code shapes live side by side on the floor:
 *   - the short vendor code printed on the shelf tag (e.g. 6429609)
 *   - the full UPC/EAN on the package
 * They point at the same product, so `item_code_aliases` maps any extra code back
 * to a single catalog row.
 */

/**
 * Codes are compared without punctuation, case, or leading zeros so that a tag
 * typed as "064-29609" matches a scan of "6429609".
 * @param {string} raw
 * @returns {string} '' when the code is unusable
 */
function normalizeCode(raw) {
    let s = String(raw ?? '').trim().toUpperCase();
    if (!s) return '';
    s = s.replace(/[\s\-_.]/g, '');
    if (!s) return '';
    if (/^\d+$/.test(s)) {
        const stripped = s.replace(/^0+/, '');
        return stripped || '0';
    }
    return s;
}

function cleanText(raw, max = 200) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
}

/** "$5.79" / "24.41" → number, or null when the cell is blank / unusable. */
function parseMoney(raw) {
    const s = String(raw ?? '').replace(/[$,\s]/g, '').trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * SMS Price List "S.Dept." numbers → store major-department names.
 * Unknown codes keep a readable "Dept N" label so reports still group.
 */
const SMS_SUB_DEPARTMENTS = {
    1: 'Grocery',
    2: 'Food Service Paper & Supplies',
    3: 'Health & Beauty Aids',
    5: 'Dairy',
    6: 'Meat',
    7: 'General Merch',
    8: 'Commercial General Merch',
    13: 'Pop and Chips',
    14: 'Confectionary',
    18: 'Commercial Bakery',
    19: 'Deli',
    20: 'Frozen Foods',
    21: 'Bakery',
    22: 'Produce',
    23: 'Produce Sell Off',
    28: 'Frozen Seafood',
    29: 'Frozen Meat',
    47: 'French Fries — Food Service',
    53: 'Dairy Milk',
};

/**
 * Turn an S.Dept cell ("5", "5-Dairy", "Dairy") into the store's major name.
 */
function resolveDepartment(raw) {
    const cleaned = cleanText(raw, 80);
    if (!cleaned) return '';
    const numbered = cleaned.match(/^(\d+)\s*[-–.:]?\s*(.*)$/);
    if (numbered) {
        const code = Number(numbered[1]);
        if (SMS_SUB_DEPARTMENTS[code]) return SMS_SUB_DEPARTMENTS[code];
        if (numbered[2] && /[A-Za-z]/.test(numbered[2])) return cleanText(numbered[2], 60);
        if (Number.isFinite(code)) return `Dept ${code}`;
    }
    if (/^\d+$/.test(cleaned)) {
        const code = Number(cleaned);
        return SMS_SUB_DEPARTMENTS[code] || `Dept ${code}`;
    }
    return cleanText(cleaned, 60);
}

/** Case-pack cells are whole counts ("6", "12"). */
function parseCaseQty(raw) {
    const s = String(raw ?? '').replace(/[,\s]/g, '').trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n);
}

/**
 * SMS "Price List with Cost" prints V.Code as
 * "The Grocery People - Re 317636" (vendor name + prefix + number).
 * The trailing digits are the vendor item number worth keeping as an alias.
 */
function extractVendorItemCode(raw) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const bare = normalizeCode(s);
    if (bare && /^\d+$/.test(bare) && bare.length >= 4) return bare;
    const m = s.match(/(\d{4,})\s*$/);
    return m ? normalizeCode(m[1]) : '';
}

/**
 * UPC-A / EAN-13 check digit for a code body (the barcode minus its last digit).
 * Weights are anchored to the right, so leading zeros do not change the result.
 * @param {string} body digits only
 */
function upcCheckDigit(body) {
    let sum = 0;
    for (let i = 0; i < body.length; i += 1) {
        const digit = Number(body[body.length - 1 - i]);
        sum += i % 2 === 0 ? digit * 3 : digit;
    }
    return (10 - (sum % 10)) % 10;
}

/** Below this, a numeric code is a shelf/vendor code, not a barcode — leave it alone. */
const BARCODE_MIN_DIGITS = 8;

/**
 * Every form a single product code might be stored under, best match first.
 *
 * A scanner returns the whole barcode including its trailing check digit
 * (057316020840), while head-office item files list the same product without it
 * (5731602084). Both directions are tried, but only when the check digit actually
 * validates, so unrelated codes can't collide.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function codeCandidates(raw) {
    const base = normalizeCode(raw);
    if (!base) return [];
    const out = [base];
    const push = (candidate) => {
        const n = normalizeCode(candidate);
        if (n && !out.includes(n)) out.push(n);
    };

    if (!/^\d+$/.test(base) || base.length < BARCODE_MIN_DIGITS) return out;

    // Scanned a full barcode; the catalog may hold it with the check digit removed.
    for (const width of [12, 13]) {
        if (base.length > width) continue;
        const padded = base.padStart(width, '0');
        const body = padded.slice(0, -1);
        if (Number(padded[padded.length - 1]) === upcCheckDigit(body)) push(body);
    }

    // Typed the short form; the catalog may hold the full barcode.
    if (base.length <= 12) push(base + upcCheckDigit(base));

    return out;
}

/** Descriptions are matched case-insensitively when auto-linking a new barcode. */
function descriptionKey(raw) {
    return cleanText(raw).toLowerCase();
}

const HEADER_WORDS = new Set([
    'CODE', 'ITEMCODE', 'ITEM', 'ITEMNUMBER', 'SKU', 'UPC', 'BARCODE', 'PLU',
    'DESCRIPTION', 'PRODUCT', 'TOTAL', 'SUBTOTAL', 'PAGE', 'REPORT',
]);

/**
 * Head-office item files are printed reports, so they carry page headers, department
 * banners and title lines between the real rows. None of those are products.
 *
 * @param {{ code?: string, description?: string }} row
 * @returns {string|null} why the row is not an item, or null when it is fine
 */
function catalogRowIssue(row = {}) {
    const code = normalizeCode(row.code);
    if (!code) return 'missing code';
    // Excel rewrites long barcodes as 8.41006E+11 on save, destroying the digits.
    // Anchored: a description read as a code ("DOVE MEN BW ACTIVE + FRESH") also
    // contains "E+" once spaces are stripped, and that is a mapping fault, not a
    // rounded barcode. normalizeCode has already removed the decimal point.
    if (/^\d+E\+\d+$/.test(code)) return 'code mangled into scientific notation by a spreadsheet';
    if (HEADER_WORDS.has(code)) return 'repeated column header';
    // Price books stand in a NOUPC-<item number> code for stock that has no barcode
    // at all. Nothing can ever scan it, so it must not become a catalog code.
    if (/^NOUPC\d*$/.test(code)) return 'placeholder for an item with no barcode';
    const numeric = /^\d+$/.test(code);
    if (numeric && code.length < 4) return 'department or section heading';
    if (!numeric && !cleanText(row.description)) return 'report title line';
    return null;
}

/**
 * Drop rows a previous import mistook for products.
 * @param {object} db
 * @returns {{ removed: number, by_reason: Record<string, number> }}
 */
function purgeCatalogJunk(db) {
    const rows = db.all('SELECT code, description FROM item_catalog');
    const byReason = {};
    let removed = 0;

    const apply = () => {
        for (const row of rows) {
            const issue = catalogRowIssue(row);
            if (!issue) continue;
            db.run('DELETE FROM item_catalog WHERE code = ?', row.code);
            db.run('DELETE FROM item_code_aliases WHERE code = ? OR alias_code = ?', row.code, row.code);
            byReason[issue] = (byReason[issue] || 0) + 1;
            removed += 1;
        }
    };
    if (db.transaction) db.transaction(apply)();
    else apply();

    return { removed, by_reason: byReason };
}

/**
 * Resolve a code to its catalog row, following aliases and barcode check-digit forms.
 * @param {object} db
 * @param {string} rawCode
 * @returns {object|null}
 */
function lookupItem(db, rawCode) {
    const candidates = codeCandidates(rawCode);
    for (let i = 0; i < candidates.length; i += 1) {
        const code = candidates[i];
        const direct = db.get('SELECT * FROM item_catalog WHERE code = ?', code);
        if (direct) {
            return { ...direct, matched_code: code, matched_via: i === 0 ? 'code' : 'barcode' };
        }
        const alias = db.get('SELECT * FROM item_code_aliases WHERE alias_code = ?', code);
        if (alias) {
            const row = db.get('SELECT * FROM item_catalog WHERE code = ?', alias.code);
            if (row) return { ...row, matched_code: code, matched_via: 'alias' };
        }
    }
    return null;
}

/**
 * Free-text search over descriptions and codes, for the "can't find the tag" case.
 * @param {object} db
 * @param {{ q?: string, limit?: number }} opts
 */
function searchItems(db, opts = {}) {
    const q = cleanText(opts.q).toLowerCase();
    let limit = parseInt(opts.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 25;
    if (limit > 100) limit = 100;
    if (!q) return [];
    const like = `%${q}%`;
    return db.all(
        `SELECT * FROM item_catalog
          WHERE LOWER(description) LIKE ?
             OR code LIKE ?
             OR LOWER(COALESCE(raw_code,'')) LIKE ?
          ORDER BY times_seen DESC, description ASC
          LIMIT ?`,
        like,
        like,
        like,
        limit,
    );
}

/**
 * Insert or refresh one catalog entry.
 * A blank description never overwrites a known one; a manual/CSV description wins
 * over one that was learned from a FIFO row.
 *
 * @param {object} db
 * @param {{ code: string, description?: string, zone?: string, department?: string,
 *           size?: string, retail_price?: number|null, unit_cost?: number|null,
 *           case_cost?: number|null, case_qty?: number|null,
 *           source?: string, actor?: string, now?: string }} entry
 * @returns {{ code: string, created: boolean, updated: boolean }|null}
 */
function upsertItem(db, entry = {}) {
    const code = normalizeCode(entry.code);
    if (!code) return null;

    const description = cleanText(entry.description);
    const zone = cleanText(entry.zone, 40);
    const department = cleanText(entry.department, 60);
    const size = cleanText(entry.size, 60);
    const retailPrice = entry.retail_price == null ? null : Number(entry.retail_price);
    const unitCost = entry.unit_cost == null ? null : Number(entry.unit_cost);
    const caseCost = entry.case_cost == null ? null : Number(entry.case_cost);
    const caseQty = entry.case_qty == null ? null : Number(entry.case_qty);
    const source = cleanText(entry.source, 20) || 'learned';
    const actor = cleanText(entry.actor, 60);
    const now = entry.now || new Date().toISOString();

    const existing = db.get('SELECT * FROM item_catalog WHERE code = ?', code);
    if (!existing) {
        db.run(
            `INSERT INTO item_catalog
                (code, raw_code, description, zone, department, size,
                 retail_price, unit_cost, case_cost, case_qty,
                 source, times_seen, first_seen, last_seen, updated_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`,
            code,
            cleanText(entry.code, 60),
            description,
            zone,
            department,
            size,
            Number.isFinite(retailPrice) ? retailPrice : null,
            Number.isFinite(unitCost) ? unitCost : null,
            Number.isFinite(caseCost) ? caseCost : null,
            Number.isFinite(caseQty) ? caseQty : null,
            source,
            now,
            now,
            actor,
        );
        return { code, created: true, updated: false };
    }

    const authoritative = source === 'csv' || source === 'manual';
    const nextDescription = description && (authoritative || !existing.description)
        ? description
        : existing.description;
    const nextZone = zone || existing.zone;
    const nextDepartment = department || existing.department;
    const nextSize = size || existing.size;
    const nextSource = authoritative ? source : existing.source;
    // Price-list uploads overwrite money fields; floor learning never clears them.
    const nextRetail = authoritative && Number.isFinite(retailPrice) ? retailPrice : existing.retail_price;
    const nextUnitCost = authoritative && Number.isFinite(unitCost) ? unitCost : existing.unit_cost;
    const nextCaseCost = authoritative && Number.isFinite(caseCost) ? caseCost : existing.case_cost;
    const nextCaseQty = authoritative && Number.isFinite(caseQty) ? caseQty : existing.case_qty;

    db.run(
        `UPDATE item_catalog
            SET description = ?, zone = ?, department = ?, size = ?,
                retail_price = ?, unit_cost = ?, case_cost = ?, case_qty = ?,
                source = ?, times_seen = times_seen + 1, last_seen = ?, updated_by = ?
          WHERE code = ?`,
        nextDescription,
        nextZone,
        nextDepartment,
        nextSize,
        nextRetail,
        nextUnitCost,
        nextCaseCost,
        nextCaseQty,
        nextSource,
        now,
        actor || existing.updated_by || '',
        code,
    );
    return {
        code,
        created: false,
        updated: nextDescription !== existing.description || nextZone !== existing.zone,
    };
}

/**
 * Fold a standalone catalog row into another item, keeping whatever the surviving
 * row is missing. Used when a barcode was learned as its own product before we knew
 * it was really the package code for an item already on file.
 *
 * @param {object} db
 * @param {string} fromCode row to absorb (already normalized)
 * @param {string} targetCode surviving item (already normalized)
 * @returns {boolean}
 */
function absorbCatalogRow(db, fromCode, targetCode) {
    const from = db.get('SELECT * FROM item_catalog WHERE code = ?', fromCode);
    if (!from) return false;

    db.run(
        `UPDATE item_catalog
            SET description = CASE WHEN COALESCE(TRIM(description),'') = '' THEN ? ELSE description END,
                zone        = CASE WHEN COALESCE(TRIM(zone),'') = ''        THEN ? ELSE zone END,
                department  = CASE WHEN COALESCE(TRIM(department),'') = ''  THEN ? ELSE department END,
                size        = CASE WHEN COALESCE(TRIM(size),'') = ''        THEN ? ELSE size END,
                times_seen  = times_seen + ?
          WHERE code = ?`,
        from.description || '',
        from.zone || '',
        from.department || '',
        from.size || '',
        Number(from.times_seen) || 0,
        targetCode,
    );
    // Codes that pointed at the absorbed row must follow it to the surviving item.
    db.run('UPDATE item_code_aliases SET code = ? WHERE code = ?', targetCode, fromCode);
    db.run('DELETE FROM item_catalog WHERE code = ?', fromCode);
    return true;
}

/**
 * Point an extra code (usually a scanned UPC) at an existing catalog item.
 *
 * When the alias is already a product row of its own the link is refused, because
 * blindly collapsing two items would lose one. Pass `merge` for the cases where the
 * caller knows better — a clerk picking the right product after a bad scan, or an
 * item file that lists both codes for one product.
 *
 * @param {object} db
 * @param {string} aliasCode
 * @param {string} targetCode
 * @param {{ source?: string, actor?: string, now?: string, merge?: boolean }} [opts]
 * @returns {boolean} false when the target is missing, or the alias is a real item and merge was not asked for
 */
function linkAlias(db, aliasCode, targetCode, opts = {}) {
    const alias = normalizeCode(aliasCode);
    const target = normalizeCode(targetCode);
    if (!alias || !target || alias === target) return false;
    if (!db.get('SELECT code FROM item_catalog WHERE code = ?', target)) return false;
    if (db.get('SELECT code FROM item_catalog WHERE code = ?', alias)) {
        if (!opts.merge) return false;
        if (!absorbCatalogRow(db, alias, target)) return false;
    }

    db.run(
        `INSERT INTO item_code_aliases (alias_code, code, source, created_at, created_by)
         VALUES (?,?,?,?,?)
         ON CONFLICT(alias_code) DO UPDATE SET code = excluded.code`,
        alias,
        target,
        cleanText(opts.source, 20) || 'learned',
        opts.now || new Date().toISOString(),
        cleanText(opts.actor, 60),
    );
    return true;
}

/**
 * Called whenever the floor logs an item. Learns the code, and if the same
 * description already exists under a different code, links the two.
 *
 * @param {object} db
 * @param {{ code: string, description?: string, zone?: string, actor?: string,
 *           source?: string, now?: string }} entry
 */
function learnFromEntry(db, entry = {}) {
    const code = normalizeCode(entry.code);
    if (!code) return null;
    const description = cleanText(entry.description);

    const existing = lookupItem(db, code);
    if (existing) {
        // Resolved through a check-digit form, so this scan is a second code for a
        // product we already know. Remember it and the next lookup is a direct hit.
        if (existing.code !== code) {
            linkAlias(db, code, existing.code, { source: 'learned', actor: entry.actor, now: entry.now });
        }
        return upsertItem(db, { ...entry, code: existing.code, description });
    }

    // A brand-new code carrying a description we already know is almost always the
    // package barcode for an item previously logged by its shelf tag. Alias it rather
    // than splitting one product across two catalog rows.
    if (description) {
        const twin = db.get(
            `SELECT code FROM item_catalog
              WHERE LOWER(description) = ?
              ORDER BY times_seen DESC LIMIT 1`,
            descriptionKey(description),
        );
        if (twin) {
            linkAlias(db, code, twin.code, { source: 'learned', actor: entry.actor, now: entry.now });
            return upsertItem(db, { ...entry, code: twin.code, description });
        }
    }

    return upsertItem(db, { ...entry, code, description });
}

/**
 * Rebuild the catalog from item rows already in the database.
 * Safe to run repeatedly — upsert only fills gaps.
 *
 * @param {object} db
 * @param {{ now?: string }} opts
 * @returns {{ scanned: number, created: number }}
 */
function backfillFromHistory(db, opts = {}) {
    const now = opts.now || new Date().toISOString();
    let scanned = 0;
    let created = 0;

    const apply = (rows, map) => {
        for (const row of rows || []) {
            const entry = map(row);
            if (!entry?.code) continue;
            scanned += 1;
            const res = upsertItem(db, { ...entry, source: 'learned', now });
            if (res?.created) created += 1;
        }
    };

    const table = (name) => !!db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        name,
    );

    if (table('kill_dates')) {
        apply(
            db.all(
                `SELECT item_code, item, zone FROM kill_dates
                  WHERE COALESCE(TRIM(item_code),'') != ''
                  ORDER BY rowid ASC`,
            ),
            (r) => ({ code: r.item_code, description: r.item, zone: r.zone }),
        );
    }
    if (table('floor_shrink_sku')) {
        apply(
            db.all(
                `SELECT sku, item, zone FROM floor_shrink_sku
                  WHERE COALESCE(TRIM(sku),'') != ''
                  ORDER BY rowid ASC`,
            ),
            (r) => ({ code: r.sku, description: r.item, zone: r.zone }),
        );
    }
    if (table('receiving_shrink_lines')) {
        apply(
            db.all(
                `SELECT sku, description, department FROM receiving_shrink_lines
                  WHERE COALESCE(TRIM(sku),'') != ''
                  ORDER BY rowid ASC`,
            ),
            (r) => ({ code: r.sku, description: r.description, department: r.department }),
        );
    }

    return { scanned, created };
}

/**
 * Preferred SMS export: "Price List with Cost"
 *   Code | Description | Vendor | V.Code | S.Dept. | Regular/Qty | Base cost | Case | Unit cost | Margin
 *
 * Code = UPC (scan). V.Code is printed as "The Grocery People - Re 317636" — the trailing
 * digits become the alias. Regular/Qty = unit retail, Base cost = case cost, Case = pack
 * count, Unit cost = each cost.
 *
 * Older "Customer Price Catalog" still works: UPC + Case Code (shelf tag). Its Unit Code
 * column is ignored — SMS derives it as "7" + the Case Code padded to seven digits.
 */
const HEADER_ALIASES = {
    // Bare `code` first so Price List with Cost uses the UPC column as primary.
    code: [
        'code', 'item_code', 'itemcode', 'itemid', 'item_id', 'item id', 'sku',
        'plu', 'item #', 'item#', 'item number',
        'upc', 'barcode', 'case code', 'casecode', 'case_code',
    ],
    description: ['description', 'longdescription', 'long_description', 'long description', 'item', 'item_description', 'itemdescription', 'name', 'product', 'desc', 'descriptor'],
    zone: ['zone', 'aisle', 'location'],
    department: [
        'department', 'majordepartment', 'major_department', 'major department', 'dept', 'category',
        's.dept.', 's.dept', 'sdept', 'subdept', 'sub dept', 'sub-department',
    ],
    size: ['size', 'pack', 'pack_size', 'packsize'],
    alias_code: [
        'alias', 'alias_code',
        'v.code', 'vcode', 'v_code',
        'case code', 'casecode', 'case_code',
        'upc', 'barcode', 'alt_code', 'altcode', 'second_code',
    ],
    retail_price: ['regular/qty', 'regular / qty', 'regular qty', 'regular', 'reg price', 'retail', 'retail price', 'each price'],
    unit_cost: ['unit cost', 'unitcost', 'unit_cost', 'each cost'],
    case_cost: ['base cost', 'basecost', 'base_cost', 'case cost', 'casecost', 'case_cost'],
    case_qty: ['case', 'case qty', 'caseqty', 'case_qty', 'case pack', 'casepack', 'pack qty'],
};

/** Columns SMS emits that are derived or irrelevant for the catalog. */
const IGNORED_HEADERS = new Set([
    'unit code', 'unitcode', 'unit_code',
    'margin', 'vendor',
]);

/** Every label that can appear in a heading row, used to spot repeated page headers. */
const KNOWN_HEADER_LABELS = new Set([
    ...Object.values(HEADER_ALIASES).flat(),
    ...IGNORED_HEADERS,
    'base cost', 'unit cost', 'cost', 'base', 'unit', 'qty', 'price',
]);

function splitCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (quoted) {
            if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') quoted = false;
            else cur += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
}

function mapHeaders(headerCells) {
    const lower = headerCells.map((h) => {
        const name = String(h || '').trim().toLowerCase();
        return IGNORED_HEADERS.has(name) ? '' : name;
    });
    const idx = {};
    for (const [field, names] of Object.entries(HEADER_ALIASES)) {
        for (const name of names) {
            const at = lower.indexOf(name);
            // `upc` doubles as a code and an alias header; only claim it once.
            if (at >= 0 && !Object.values(idx).includes(at)) { idx[field] = at; break; }
        }
    }
    return idx;
}

/**
 * Column groups in the header, one per product on a line.
 *
 * Price books are printed two-up, so a single row carries two products side by side
 * (`Code,Description,...,Code,Description,...`). A header name that appears more than
 * once is the tell; head-office item files never repeat one.
 *
 * @param {string[]} headerCells
 * @returns {Array<Record<string, number>>} column maps, already offset to the full row
 */
function mapHeaderBlocks(headerCells) {
    const lower = headerCells.map((h) => String(h || '').trim().toLowerCase());
    const counts = new Map();
    for (const h of lower) if (h) counts.set(h, (counts.get(h) || 0) + 1);

    let startName = null;
    for (const h of lower) {
        if (h && counts.get(h) > 1) { startName = h; break; }
    }
    const starts = [];
    if (startName) lower.forEach((h, i) => { if (h === startName) starts.push(i); });
    if (starts.length < 2) return [mapHeaders(headerCells)];

    const blocks = [];
    for (let b = 0; b < starts.length; b += 1) {
        const from = starts[b];
        const to = b + 1 < starts.length ? starts[b + 1] : headerCells.length;
        const idx = mapHeaders(headerCells.slice(from, to));
        const shifted = {};
        for (const [field, at] of Object.entries(idx)) shifted[field] = at + from;
        if (shifted.code != null) blocks.push(shifted);
    }
    return blocks.length ? blocks : [mapHeaders(headerCells)];
}

/**
 * Rows that carry enough cells to be a product line, sampled across the whole file so
 * page furniture near the top cannot skew the shape of the data.
 */
/**
 * A printed report reprints its column headings on every page. Those rows must never
 * be read as data: they drag column fill rates down when detecting the layout, and a
 * heading like "V.Code" must never be filed as a product code.
 */
function looksLikeHeaderRow(cells) {
    const filled = (cells || []).filter((c) => String(c ?? '').trim() !== '');
    if (filled.length < 3) return false;
    const labels = filled.filter(
        (c) => KNOWN_HEADER_LABELS.has(String(c).trim().toLowerCase()),
    ).length;
    return labels >= 3;
}

function sampleDataRows(bodyRows, want = 400) {
    const candidates = (bodyRows || []).filter((cells) => {
        const filled = (cells || []).filter((c) => String(c ?? '').trim() !== '');
        return filled.length >= 5 && !looksLikeHeaderRow(cells);
    });
    if (candidates.length <= want) return candidates;
    const step = candidates.length / want;
    const out = [];
    for (let i = 0; i < want; i += 1) out.push(candidates[Math.floor(i * step)]);
    return out;
}

/**
 * Per-column shape of the data: how often a column is filled, and what it looks like.
 * @returns {Array<{fill:number,intRate:number,codeRate:number,textRate:number,uniqueRate:number,moneyRate:number,smallIntRate:number}>}
 */
function profileColumns(rows) {
    const width = rows.reduce((m, r) => Math.max(m, (r || []).length), 0);
    const stats = [];
    for (let at = 0; at < width; at += 1) {
        let filled = 0;
        let int = 0;
        let code = 0;
        let text = 0;
        let money = 0;
        let smallInt = 0;
        const seen = new Set();
        for (const cells of rows) {
            const v = String((cells || [])[at] ?? '').trim();
            if (!v) continue;
            filled += 1;
            seen.add(v);
            const bare = v.replace(/[$,\s]/g, '');
            if (/^\d+$/.test(bare)) {
                int += 1;
                if (bare.replace(/^0+/, '').length >= 4) code += 1;
                if (Number(bare) > 0 && Number(bare) <= 999) smallInt += 1;
            }
            if (/^\$?\d+\.\d{1,2}$/.test(bare)) money += 1;
            if (/[A-Za-z]/.test(v)) text += 1;
        }
        const n = rows.length || 1;
        const f = filled || 1;
        stats.push({
            fill: filled / n,
            intRate: int / f,
            codeRate: code / f,
            textRate: text / f,
            uniqueRate: seen.size / f,
            moneyRate: money / f,
            smallIntRate: smallInt / f,
        });
    }
    return stats;
}

/**
 * Work out which column is which by looking at the rows themselves.
 *
 * SMS only exports the formatted report, and Crystal writes header labels into
 * whichever cell the printed text box overlaps — so "Code" sits in column 1 while the
 * codes are in column 0, and the Vendor heading covers two cells (number and name).
 * Trusting the header therefore reads every description as a code. The data does not
 * lie: codes are long unique integers, descriptions are unique text, and the vendor
 * name repeats.
 *
 * Money columns are only accepted when case cost ≈ unit cost × case pack, so a
 * guessed price is never stored.
 *
 * @param {string[][]} bodyRows
 * @returns {Record<string, number>|null}
 */
function inferColumnsFromData(bodyRows) {
    const rows = sampleDataRows(bodyRows);
    if (rows.length < 10) return null;
    const stats = profileColumns(rows);
    const idx = {};

    // Leftmost wins: the report prints the item's own code first. Uniqueness is only a
    // sanity floor here — the same UPC can legitimately repeat across vendors — but it
    // still rules out a constant column such as the store or vendor number.
    const codeAt = stats.findIndex(
        (s) => s.fill >= 0.8 && s.codeRate >= 0.8 && s.uniqueRate >= 0.25,
    );
    if (codeAt < 0) return null;
    idx.code = codeAt;

    const descAt = stats.findIndex(
        (s, i) => i !== codeAt && s.fill >= 0.8 && s.textRate >= 0.7 && s.uniqueRate >= 0.5,
    );
    if (descAt < 0) return null;
    idx.description = descAt;

    // The vendor's own number repeats across its items, so uniqueness separates it
    // from the vendor item code we actually want as an alias.
    const aliasAt = stats.findIndex(
        (s, i) => i !== codeAt && i > descAt && s.fill >= 0.6
            && s.codeRate >= 0.7 && s.uniqueRate >= 0.5,
    );
    if (aliasAt >= 0) idx.alias_code = aliasAt;

    const moneyCols = stats
        .map((s, i) => ({ ...s, i }))
        .filter((s) => s.i > descAt && s.fill >= 0.6 && s.moneyRate >= 0.7)
        .map((s) => s.i);
    const caseCols = stats
        .map((s, i) => ({ ...s, i }))
        .filter((s) => s.i > descAt && s.fill >= 0.6 && s.smallIntRate >= 0.8 && s.moneyRate < 0.3)
        .map((s) => s.i);

    // Printed order is Regular/Qty, Base cost, Case, Unit cost.
    if (moneyCols.length >= 3 && caseCols.length) {
        const [retailAt, caseCostAt, unitCostAt] = [moneyCols[0], moneyCols[1], moneyCols[2]];
        const caseQtyAt = caseCols.find((i) => i > caseCostAt && i < unitCostAt) ?? caseCols[caseCols.length - 1];
        let agree = 0;
        let checked = 0;
        for (const cells of rows) {
            const unit = parseMoney((cells || [])[unitCostAt]);
            const cased = parseMoney((cells || [])[caseCostAt]);
            const qty = parseCaseQty((cells || [])[caseQtyAt]);
            if (!unit || !cased || !qty) continue;
            checked += 1;
            // Loose on purpose: SMS unit cost carries freight and deposits that the base
            // case cost does not, so the two agree in scale rather than to the cent
            // (4.18 x 6 = 25.08 against a 24.41 case). A wrong column pairing is out by
            // far more than this, which is all the check needs to catch.
            if (Math.abs(unit * qty - cased) <= Math.max(0.1, cased * 0.05)) agree += 1;
        }
        if (checked >= 5 && agree / checked >= 0.7) {
            idx.retail_price = retailAt;
            idx.case_cost = caseCostAt;
            idx.unit_cost = unitCostAt;
            idx.case_qty = caseQtyAt;
        } else if (moneyCols.length) {
            idx.retail_price = retailAt;
        }
    } else if (moneyCols.length) {
        [idx.retail_price] = moneyCols;
    }

    // Printed order is V.Code, S.Dept., Regular/Qty — the last small-integer column
    // before the first money column is the sub-department code.
    const retailAt = idx.retail_price;
    if (retailAt != null) {
        const deptCandidates = stats
            .map((s, i) => ({ ...s, i }))
            .filter((s) => s.i > descAt
                && s.i < retailAt
                && s.i !== aliasAt
                && s.i !== codeAt
                && s.fill >= 0.5
                && s.smallIntRate >= 0.7
                && s.moneyRate < 0.3);
        if (deptCandidates.length) {
            idx.department = deptCandidates[deptCandidates.length - 1].i;
        }
    }

    return idx;
}

/**
 * True when the column the header pointed at does not actually hold item codes.
 */
function headerMappingLooksWrong(blocks, bodyRows) {
    const codeAt = blocks[0]?.code;
    if (codeAt == null) return true;
    const rows = sampleDataRows(bodyRows);
    if (rows.length < 10) return false;
    return profileColumns(rows)[codeAt]?.codeRate < 0.5;
}

/**
 * Import a head-office item file or a printed price book (CSV cell grid).
 *
 * @param {object} db
 * @param {string[]} headerCells
 * @param {string[][]} bodyRows
 * @param {{ dryRun?: boolean, actor?: string, now?: string, skipKnown?: boolean }} opts
 *   `skipKnown` adds only codes that do not resolve yet, so a supplementary file can
 *   widen barcode coverage without restating names the item file already owns.
 */
function importItemTable(db, headerCells, bodyRows, opts = {}) {
    let blocks = mapHeaderBlocks(headerCells || []);
    const notes = [];

    // A formatted report export offsets its header labels from the data beneath, so the
    // rows themselves decide the layout whenever the header's code column is not codes.
    if (blocks.length <= 1 && headerMappingLooksWrong(blocks, bodyRows)) {
        const inferred = inferColumnsFromData(bodyRows);
        if (inferred) {
            const before = blocks[0]?.code;
            blocks = [inferred];
            notes.push(
                `Header labels did not line up with the rows${before == null ? '' : ` (they pointed at column ${before})`}`
                + ', which is normal for a formatted SMS export. Columns were read from the data '
                + `instead: ${Object.entries(inferred).map(([f, at]) => `${f}=col${at}`).join(', ')}.`,
            );
        }
    }

    if (!blocks.length || blocks[0].code == null) {
        const err = new Error('File needs a code column (upc / case code / sku / item_code).');
        err.status = 400;
        throw err;
    }

    const now = opts.now || new Date().toISOString();
    const actor = cleanText(opts.actor, 60);
    const errors = [];
    const skipped = {};
    // A couple of real examples per reason: when a file imports almost nothing, the
    // counts alone never say why, and the file is usually on a different machine.
    const skippedSamples = {};
    const rows = [];
    let filedByVendorCode = 0;

    for (const cells of bodyRows || []) {
        if (looksLikeHeaderRow(cells)) {
            skipped['repeated column header'] = (skipped['repeated column header'] || 0) + 1;
            continue;
        }
        for (const idx of blocks) {
            const pick = (field) => (idx[field] == null ? '' : (cells[idx[field]] ?? ''));
            const aliasRaw = pick('alias_code');
            const row = {
                code: normalizeCode(pick('code')),
                raw_code: cleanText(pick('code'), 60),
                description: cleanText(pick('description')),
                zone: cleanText(pick('zone'), 40),
                department: resolveDepartment(pick('department')),
                size: cleanText(pick('size'), 60),
                // V.Code cells look like "The Grocery People - Re 317636".
                alias_code: extractVendorItemCode(aliasRaw) || normalizeCode(aliasRaw),
                retail_price: parseMoney(pick('retail_price')),
                unit_cost: parseMoney(pick('unit_cost')),
                case_cost: parseMoney(pick('case_cost')),
                case_qty: parseCaseQty(pick('case_qty')),
            };
            // Two-up pages run out of products before they run out of lines.
            if (!row.code && !row.description) continue;
            let issue = catalogRowIssue(row);
            // Plenty of real stock carries no barcode in SMS — gift cards, handling
            // fees, bakery and packaging — so the Code cell is blank or a stub like
            // 0/1/6. The shelf tag for those shows the vendor item code, which is what
            // staff type in, so file the item under that rather than dropping it.
            if ((issue === 'missing code' || issue === 'department or section heading')
                && row.alias_code
                && row.description
                && !catalogRowIssue({ code: row.alias_code, description: row.description })) {
                row.code = normalizeCode(row.alias_code);
                row.raw_code = row.alias_code;
                row.alias_code = '';
                row.no_barcode = true;
                issue = null;
                filedByVendorCode += 1;
            }
            if (issue) {
                skipped[issue] = (skipped[issue] || 0) + 1;
                if (!skippedSamples[issue]) skippedSamples[issue] = [];
                if (skippedSamples[issue].length < 3) {
                    skippedSamples[issue].push(
                        (cells || []).slice(0, 12).map((c) => cleanText(c, 30)),
                    );
                }
                continue;
            }
            rows.push(row);
        }
    }

    errors.push(...notes);

    if (filedByVendorCode) {
        errors.push(
            `${filedByVendorCode} item${filedByVendorCode === 1 ? ' has' : 's have'} no barcode in SMS `
            + '(gift cards, handling fees, bakery, packaging). Filed under the vendor item code from '
            + 'V.Code, which is what the shelf tag shows — look those up by item code, not by scan.',
        );
    }

    const mangled = skipped['code mangled into scientific notation by a spreadsheet'] || 0;
    if (mangled) {
        errors.push(
            `${mangled} row${mangled === 1 ? '' : 's'} had a code like 8.41006E+11 — the spreadsheet `
            + 'rounded those barcodes away. Re-export from SMS as ExcelFile and upload the .xls '
            + 'directly (or format the UPC column as Text before saving CSV).',
        );
    }

    if (opts.dryRun) {
        return {
            dry_run: true,
            import_count: rows.length,
            filed_by_vendor_code: filedByVendorCode,
            errors,
            skipped,
            skipped_samples: skippedSamples,
            header_cells: (headerCells || []).slice(0, 14).map((c) => cleanText(c, 30)),
            columns: blocks[0],
            sample: rows.slice(0, 10),
        };
    }

    let imported = 0;
    let aliases = 0;
    let alreadyKnown = 0;
    // A barcode that is also some other product's item number in this same file is a
    // real product in its own right, so it must never be absorbed as a duplicate.
    const productCodes = new Set(rows.map((r) => r.code));
    const apply = () => {
        for (const row of rows) {
            // Add-only: a code that already resolves belongs to an item we trust more,
            // and re-adding it under its barcode would split the product in two.
            if (opts.skipKnown && lookupItem(db, row.code)) {
                alreadyKnown += 1;
                continue;
            }
            upsertItem(db, { ...row, source: 'csv', actor, now });
            imported += 1;
            // Placeholder barcodes (0000000000000) normalize to '0'; never alias on those.
            if (row.alias_code && row.alias_code !== '0' && row.alias_code !== row.code) {
                const merge = !productCodes.has(row.alias_code);
                if (linkAlias(db, row.alias_code, row.code, {
                    source: 'csv', actor, now, merge,
                })) aliases += 1;
            }
        }
    };
    if (db.transaction) db.transaction(apply)();
    else apply();

    return {
        dry_run: false,
        imported,
        aliases,
        already_known: alreadyKnown,
        filed_by_vendor_code: filedByVendorCode,
        errors,
        skipped,
        skipped_samples: skippedSamples,
    };
}

/**
 * Import a CSV string (tests + older callers).
 * @param {object} db
 * @param {string} csvText
 * @param {{ dryRun?: boolean, actor?: string, now?: string, skipKnown?: boolean }} opts
 */
function importItemCsv(db, csvText, opts = {}) {
    const lines = String(csvText || '')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '');
    if (!lines.length) {
        const err = new Error('CSV is empty.');
        err.status = 400;
        throw err;
    }
    const headers = splitCsvLine(lines[0]);
    const body = lines.slice(1).map(splitCsvLine);
    return importItemTable(db, headers, body, opts);
}

/** Excel / Crystal cells → plain text without scientific-notation surprises when possible. */
function cellToText(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return '';
        // toFixed keeps a long barcode as digits; String() would give back "9.78031e+12".
        return Number.isInteger(value) ? value.toFixed(0) : String(value);
    }
    return String(value).replace(/\s+/g, ' ').trim();
}

/**
 * SMS price catalogs put title / filter lines above the real column headers.
 * @param {string[][]} rows
 * @returns {number}
 */
function findHeaderRowIndex(rows) {
    const limit = Math.min(rows.length, 40);
    for (let i = 0; i < limit; i += 1) {
        const cells = (rows[i] || []).map(cellToText);
        const idx = mapHeaders(cells);
        if (idx.code != null && (
            idx.description != null || idx.size != null || idx.alias_code != null
            || idx.retail_price != null || idx.unit_cost != null || idx.case_cost != null
        )) {
            return i;
        }
    }
    return 0;
}

const MAX_ITEM_UPLOAD_BYTES = 15 * 1024 * 1024;

/**
 * Decode a Settings upload (CSV or SMS ExcelFile .xls / .xlsx) into cell grids.
 *
 * Every worksheet is returned, not just the first: Crystal Reports splits a long
 * export across sheets, and reading only sheet one drops the rest of the catalog
 * without anything looking wrong.
 *
 * @param {string} filename
 * @param {string} contentBase64
 * @returns {Promise<{ safeName: string, sheets: Array<{ name: string, rows: string[][] }>, format: string }>}
 */
async function parseItemCatalogUpload(filename, contentBase64) {
    const safeName = String(filename || '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120) || 'catalog';
    const buf = Buffer.from(String(contentBase64 || ''), 'base64');
    if (!buf.length) {
        const err = new Error('Upload is empty.');
        err.status = 400;
        throw err;
    }
    if (buf.length > MAX_ITEM_UPLOAD_BYTES) {
        const err = new Error('Upload is too large. Maximum catalog file size is 15 MB.');
        err.status = 400;
        throw err;
    }

    if (/\.csv$/i.test(safeName)) {
        const lines = buf.toString('utf8').replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .filter((l) => l.trim() !== '');
        return {
            safeName, sheets: [{ name: safeName, rows: lines.map(splitCsvLine) }], format: 'csv',
        };
    }

    if (/\.xlsx?$/i.test(safeName)) {
        try {
            // Raw numeric cells keep full barcode digits (not Excel's "9.78E+12" display).
            // Text-formatted SMS exports stay strings, so leading zeros survive when present.
            const wb = await readSpreadsheetBuffer(buf, safeName);
            if (!wb.sheets.length) {
                const err = new Error('Excel file has no sheets.');
                err.status = 400;
                throw err;
            }
            const sheets = wb.sheets.map((sheet) => {
                const rawRows = sheetToObjects(sheet, { header: 1 });
                return {
                    name: sheet.name,
                    rows: (rawRows || [])
                        .map((row) => (Array.isArray(row) ? row : []).map(cellToText))
                        .filter((row) => row.some(Boolean)),
                };
            }).filter((s) => s.rows.length);
            return { safeName, sheets, format: 'excel' };
        } catch (e) {
            if (e.status) throw e;
            const err = new Error(`Could not parse Excel file: ${e.message}`);
            err.status = 400;
            throw err;
        }
    }

    const err = new Error('Upload must be a .xls, .xlsx, or .csv file (SMS → ExcelFile).');
    err.status = 400;
    throw err;
}

/**
 * Import a catalog file from Settings (CSV or SMS Excel export).
 * @param {object} db
 * @param {string} filename
 * @param {string} contentBase64
 * @param {{ dryRun?: boolean, actor?: string, now?: string, skipKnown?: boolean }} opts
 */
async function importItemUpload(db, filename, contentBase64, opts = {}) {
    const parsed = await parseItemCatalogUpload(filename, contentBase64);
    if (!parsed.sheets.length) {
        const err = new Error('File is empty.');
        err.status = 400;
        throw err;
    }

    // Sheets of a split export repeat the same header, so they are gathered into one
    // pass; a sheet laid out differently is imported on its own rather than ignored.
    const groups = new Map();
    const sheetsUsed = [];
    let headerRow = 0;
    let rowsRead = 0;
    for (const sheet of parsed.sheets) {
        const headerAt = findHeaderRowIndex(sheet.rows);
        const headers = sheet.rows[headerAt] || [];
        const body = sheet.rows.slice(headerAt + 1);
        if (mapHeaders(headers).code == null || !body.length) continue;
        if (!sheetsUsed.length) headerRow = headerAt + 1;
        sheetsUsed.push(sheet.name);
        rowsRead += body.length;
        const key = JSON.stringify(headers);
        const group = groups.get(key) || { headers, body: [] };
        group.body.push(...body);
        groups.set(key, group);
    }
    if (!groups.size) {
        // Let the single-table path raise the usual "needs a code column" message.
        const first = parsed.sheets[0];
        const headerAt = findHeaderRowIndex(first.rows);
        return importItemTable(db, first.rows[headerAt] || [], first.rows.slice(headerAt + 1), opts);
    }

    const totals = {
        imported: 0, aliases: 0, already_known: 0, import_count: 0, errors: [], skipped: {},
    };
    const sample = [];
    const skippedSamples = {};
    let headerCells = [];
    let columns = null;
    let dryRun = false;
    for (const group of groups.values()) {
        const part = importItemTable(db, group.headers, group.body, opts);
        dryRun = part.dry_run;
        totals.imported += part.imported || 0;
        totals.aliases += part.aliases || 0;
        totals.already_known += part.already_known || 0;
        totals.import_count += part.import_count || 0;
        totals.errors.push(...(part.errors || []));
        for (const [reason, n] of Object.entries(part.skipped || {})) {
            totals.skipped[reason] = (totals.skipped[reason] || 0) + n;
        }
        for (const [reason, examples] of Object.entries(part.skipped_samples || {})) {
            if (!skippedSamples[reason]) skippedSamples[reason] = examples;
        }
        if (!headerCells.length) headerCells = part.header_cells || [];
        if (!columns) columns = part.columns || null;
        if (sample.length < 10) sample.push(...(part.sample || []).slice(0, 10 - sample.length));
    }

    return {
        ...totals,
        sample,
        skipped_samples: skippedSamples,
        header_cells: headerCells,
        columns,
        dry_run: dryRun,
        format: parsed.format,
        header_row: headerRow,
        rows_read: rowsRead,
        sheets: sheetsUsed,
    };
}

function listAliasesForCode(db, code) {
    const normalized = normalizeCode(code);
    if (!normalized) return [];
    return db.all(
        'SELECT alias_code, source, created_at FROM item_code_aliases WHERE code = ? ORDER BY alias_code ASC',
        normalized,
    ) || [];
}

/**
 * Best vendor / shelf item number for ordering (SMS V.Code trailing digits).
 * Prefers shorter numeric aliases over full UPC barcode.
 * @param {object} db
 * @param {object|null} item lookupItem row
 * @returns {string|null}
 */
function resolveVendorCode(db, item) {
    if (!item || !item.code) return null;
    const primary = String(item.code);
    const aliases = listAliasesForCode(db, primary).map((a) => String(a.alias_code || '').trim()).filter(Boolean);
    const pool = [];
    if (item.matched_via === 'alias' && item.matched_code) pool.push(String(item.matched_code));
    for (const a of aliases) pool.push(a);
    pool.push(primary);

    const scored = [];
    const seen = new Set();
    for (const raw of pool) {
        const code = normalizeCode(raw) || raw;
        if (!code || seen.has(code)) continue;
        seen.add(code);
        const digits = /^\d+$/.test(code);
        const len = code.length;
        // Full barcodes are usually 8+; V.Codes are typically 4–7 trailing digits.
        const looksVendor = digits && len >= 4 && len < BARCODE_MIN_DIGITS;
        const looksShortPrimary = digits && len < BARCODE_MIN_DIGITS;
        let score = 0;
        if (looksVendor) score += 100;
        else if (looksShortPrimary) score += 80;
        else if (digits && len < 12) score += 40;
        else score += 10;
        score += Math.max(0, 20 - len); // shorter wins
        scored.push({ code, score });
    }
    scored.sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
    const best = scored[0];
    if (!best) return null;
    // If the only hit is a long barcode, still return it — better than blank for the relay.
    return best.code;
}

function catalogStats(db) {
    const total = db.get('SELECT COUNT(*) AS c FROM item_catalog')?.c ?? 0;
    const described = db.get("SELECT COUNT(*) AS c FROM item_catalog WHERE COALESCE(TRIM(description),'') != ''")?.c ?? 0;
    const aliasCount = db.get('SELECT COUNT(*) AS c FROM item_code_aliases')?.c ?? 0;
    const junk = (db.all('SELECT code, description FROM item_catalog') || [])
        .filter((row) => catalogRowIssue(row)).length;
    return {
        total, described, aliases: aliasCount, junk,
    };
}

module.exports = {
    normalizeCode,
    parseMoney,
    parseCaseQty,
    extractVendorItemCode,
    resolveDepartment,
    SMS_SUB_DEPARTMENTS,
    upcCheckDigit,
    codeCandidates,
    descriptionKey,
    catalogRowIssue,
    purgeCatalogJunk,
    lookupItem,
    listAliasesForCode,
    resolveVendorCode,
    searchItems,
    upsertItem,
    linkAlias,
    learnFromEntry,
    backfillFromHistory,
    importItemCsv,
    importItemTable,
    importItemUpload,
    parseItemCatalogUpload,
    findHeaderRowIndex,
    MAX_ITEM_UPLOAD_BYTES,
    catalogStats,
};
