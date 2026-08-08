export const DEPT_FIELDS = [
    { key: 'grocery', label: 'Grocery', col: 'C' },
    { key: 'tobacco', label: 'Tobacco', col: 'D' },
    { key: 'meat', label: 'Meat', col: 'E' },
    { key: 'bakery', label: 'Bakery', col: 'F' },
    { key: 'bakery_in_store', label: 'Bake Off', col: 'G' },
    { key: 'deli', label: 'Deli', col: 'H' },
    { key: 'produce', label: 'Produce', col: 'I' },
    { key: 'produce_shrink', label: 'Produce Shrink', col: 'J' },
    { key: 'dairy', label: 'Dairy', col: 'K' },
    { key: 'pharmacy', label: 'Pharmacy', col: 'L' },
    { key: 'gst', label: 'GST', col: 'M' },
];

export const FREIGHT_FIELDS = [
    { key: 'freight_grocery', label: 'Grocery' },
    { key: 'freight_tobacco', label: 'Tobacco' },
    { key: 'freight_meat', label: 'Meat' },
    { key: 'freight_bakery', label: 'Bakery' },
    { key: 'freight_bakery_in_store', label: 'Bake Off' },
    { key: 'freight_deli', label: 'Deli' },
    { key: 'freight_produce', label: 'Produce' },
    { key: 'freight_dairy', label: 'Dairy' },
    { key: 'freight_pharmacy', label: 'Pharmacy' },
];

export const GRID_ROW_COUNT = 50;
export const GRID_PAGE_SIZE = 50;

/** @deprecated Legacy display only — live math comes from the API. */
export const FREIGHT_LABELS = {
    grocery: 'Grocery',
    tobacco: '',
    meat: 'Meat',
    bakery: 'Bakery',
    bakery_in_store: 'Bake off',
    deli: 'Deli',
    produce: 'Produce',
    produce_shrink: 'Produce Shrink',
    dairy: 'Dairy',
    pharmacy: 'Pharmacy',
    gst: 'Receiving Totals',
};

export function emptyLine(kind = 'invoice') {
    return {
        line_id: '',
        line_kind: kind,
        invoice_number: '',
        supplier_name: kind === 'write_off' ? 'WRITE OFF BOOK' : '',
        grocery: '',
        tobacco: '',
        meat: '',
        bakery: '',
        bakery_in_store: '',
        deli: '',
        produce: '',
        produce_shrink: '',
        dairy: '',
        pharmacy: '',
        gst: '',
        freight_grocery: '',
        freight_tobacco: '',
        freight_meat: '',
        freight_bakery: '',
        freight_bakery_in_store: '',
        freight_deli: '',
        freight_produce: '',
        freight_dairy: '',
        freight_pharmacy: '',
        notes: '',
    };
}

export function lineFromApi(line) {
    const base = emptyLine(line?.line_kind || 'invoice');
    return {
        ...base,
        ...line,
        line_id: line?.line_id || '',
        grocery: line?.grocery ?? '',
        tobacco: line?.tobacco ?? '',
        meat: line?.meat ?? '',
        bakery: line?.bakery ?? '',
        bakery_in_store: line?.bakery_in_store ?? '',
        deli: line?.deli ?? '',
        produce: line?.produce ?? '',
        produce_shrink: line?.produce_shrink ?? '',
        dairy: line?.dairy ?? '',
        pharmacy: line?.pharmacy ?? '',
        gst: line?.gst ?? '',
        freight_grocery: line?.freight_grocery ?? '',
        freight_tobacco: line?.freight_tobacco ?? '',
        freight_meat: line?.freight_meat ?? '',
        freight_bakery: line?.freight_bakery ?? '',
        freight_bakery_in_store: line?.freight_bakery_in_store ?? '',
        freight_deli: line?.freight_deli ?? '',
        freight_produce: line?.freight_produce ?? '',
        freight_dairy: line?.freight_dairy ?? '',
        freight_pharmacy: line?.freight_pharmacy ?? '',
        has_freight: !!line?.has_freight || Number(line?.freight_total || 0) !== 0,
    };
}

/**
 * Build one page of grid rows + separate pagination metadata.
 * Does not attach `.meta` onto the rows array — callers keep meta in its own state.
 */
export function rebuildPage(lines = [], page = 0, pageSize = GRID_PAGE_SIZE) {
    const all = (lines || []).map(lineFromApi);
    const size = Math.max(1, Number(pageSize) || GRID_PAGE_SIZE);
    const totalPages = Math.max(1, Math.ceil(Math.max(all.length, 1) / size));
    const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
    const start = safePage * size;
    const pageRows = all.slice(start, start + size);
    while (pageRows.length < size) pageRows.push(emptyLine());
    return {
        rows: pageRows,
        meta: {
            page: safePage,
            pageSize: size,
            totalLines: all.length,
            totalPages,
            hasOverflow: all.length > size,
        },
    };
}

/**
 * Build one page of grid rows. Never silently drops lines: metadata exposes
 * totalLines / hasOverflow so the UI can page and warn.
 * Returns an array (backward compatible) with a `.meta` property.
 */
export function buildGridRows(lines = [], page = 0, pageSize = GRID_PAGE_SIZE) {
    const all = (lines || []).map(lineFromApi);
    const { rows, meta } = rebuildPage(lines, page, pageSize);
    rows.meta = {
        ...meta,
        hiddenCount: Math.max(0, all.length - meta.pageSize),
        allLines: all,
    };
    return rows;
}

export function lineFreightTotal(line) {
    return FREIGHT_FIELDS.reduce((sum, field) => sum + parseAmount(line?.[field.key]), 0);
}

export function fmtMoney(value, blankZero = false) {
    const n = Number(value);
    if (!Number.isFinite(n)) return blankZero ? '' : '—';
    if (n === 0 && blankZero) return '';
    return n.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtCell(value) {
    if (value === '' || value == null) return '';
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '';
    return fmtMoney(n, true);
}

/**
 * Money as it actually arrives from a keyboard or an Excel paste: currency symbols,
 * thousands separators, non-breaking spaces from web copies, accounting negatives
 * in parentheses, and the Unicode minus that Excel emits for some locales.
 * Returns null — not 0 — when the text is not a number, so a typo can be flagged
 * instead of being banked as zero.
 */
export function parseAmountOrNull(value) {
    if (value === '' || value == null) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    let text = String(value)
        .replace(/[\s\u00a0\u202f]/g, '')
        .replace(/[$£€¥]/g, '')
        .replace(/[\u2212\u2013\u2014]/g, '-')
        .replace(/,/g, '');
    if (!text) return null;

    let sign = 1;
    if (/^\(.*\)$/.test(text)) {
        sign = -1;
        text = text.slice(1, -1);
    }
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text)) return null;

    const n = Number(text);
    return Number.isFinite(n) ? sign * n : null;
}

export function parseAmount(value) {
    return parseAmountOrNull(value) ?? 0;
}

/** True when the user typed something in a money cell that is not a number. */
export function isInvalidAmount(value) {
    if (value === '' || value == null) return false;
    return parseAmountOrNull(value) === null;
}

/** Money cells that would silently post as $0. Keyed by field, for row-level warnings. */
export function invalidAmountFields(line) {
    if (!line) return [];
    const deptBad = DEPT_FIELDS
        .filter((field) => isInvalidAmount(line[field.key]))
        .map((field) => field.label);
    const freightBad = FREIGHT_FIELDS
        .filter((field) => isInvalidAmount(line[field.key]))
        .map((field) => `Freight ${field.label}`);
    return [...deptBad, ...freightBad];
}

export function calcDraftTotal(line) {
    return DEPT_FIELDS.reduce((sum, field) => sum + parseAmount(line[field.key]), 0);
}

export function rowHasData(line) {
    if (!line) return false;
    if (String(line.invoice_number || '').trim()) return true;
    if (String(line.supplier_name || '').trim()) return true;
    if (String(line.notes || '').trim()) return true;
    // Unparseable text still counts as data, otherwise a mistyped amount makes the row
    // look empty and it gets dropped instead of shown back to the receiver.
    if (DEPT_FIELDS.some((field) => parseAmount(line[field.key]) !== 0 || isInvalidAmount(line[field.key]))) {
        return true;
    }
    return FREIGHT_FIELDS.some(
        (field) => parseAmount(line[field.key]) !== 0 || isInvalidAmount(line[field.key]),
    );
}

export function calcFreightAllocations(freightTotal) {
    // Display-only legacy split for comparison labels — not used for live costing math.
    const LEGACY_PCT = {
        grocery: 0.478,
        tobacco: 0,
        meat: 0.099,
        bakery: 0,
        bakery_in_store: 0,
        deli: 0,
        produce: 0.159,
        produce_shrink: 0.122,
        dairy: 0.142,
        pharmacy: 0,
        gst: 0,
    };
    const total = parseAmount(freightTotal);
    const parts = {};
    DEPT_FIELDS.forEach((field) => {
        parts[field.key] = Math.round(total * (LEGACY_PCT[field.key] || 0) * 100) / 100;
    });
    return { total, parts };
}

export function calcDepartmentTotals(rows) {
    const totals = Object.fromEntries(DEPT_FIELDS.map((f) => [f.key, 0]));
    rows.forEach((row) => {
        if (!rowHasData(row)) return;
        DEPT_FIELDS.forEach((field) => {
            totals[field.key] += parseAmount(row[field.key]);
        });
    });
    DEPT_FIELDS.forEach((field) => {
        totals[field.key] = Math.round(totals[field.key] * 100) / 100;
    });
    totals.invoice_total = Math.round(
        DEPT_FIELDS.reduce((sum, field) => sum + totals[field.key], 0) * 100,
    ) / 100;
    return totals;
}

export function formatSheetDate(storeDate) {
    if (!storeDate) return '';
    const d = new Date(`${storeDate}T12:00:00`);
    if (Number.isNaN(d.getTime())) return storeDate;
    return d.toLocaleDateString('en-CA', { weekday: 'long', year: 'numeric', month: 'short', day: 'numeric' });
}
