import { DEPT_FIELDS } from './logUtils.js';

export const GRID_FIELD_ORDER = [
    'invoice_number',
    'supplier_name',
    ...DEPT_FIELDS.map((field) => field.key),
    'notes',
];

export function gridFieldSelector(rowIdx, fieldKey) {
    return `[data-grid-row="${rowIdx}"][data-grid-field="${fieldKey}"]`;
}

export function focusGridField(container, rowIdx, fieldKey) {
    const el = container?.querySelector?.(gridFieldSelector(rowIdx, fieldKey));
    if (el) {
        el.focus();
        if (typeof el.select === 'function') el.select();
    }
    return el;
}

export function focusNextGridField(container, rowIdx, fieldKey, reverse = false) {
    const idx = GRID_FIELD_ORDER.indexOf(fieldKey);
    if (idx < 0) return;
    const nextIdx = reverse ? idx - 1 : idx + 1;
    if (nextIdx >= 0 && nextIdx < GRID_FIELD_ORDER.length) {
        focusGridField(container, rowIdx, GRID_FIELD_ORDER[nextIdx]);
        return;
    }
    const nextRow = reverse ? rowIdx - 1 : rowIdx + 1;
    if (nextRow >= 0) {
        const targetField = reverse ? GRID_FIELD_ORDER[GRID_FIELD_ORDER.length - 1] : GRID_FIELD_ORDER[0];
        focusGridField(container, nextRow, targetField);
    }
}

/**
 * Excel puts a trailing newline on every copy, so only trailing blank lines are
 * dropped — a blank line in the middle is a real empty row and must keep its
 * position, or every row below it shifts up onto the wrong invoice.
 */
export function parseClipboardGrid(text) {
    const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return lines.map((line) => line.split('\t'));
}

/**
 * A paste is grid-shaped if it has tabs (multiple columns) or several lines
 * (one column down a run of rows) — copying a single column of amounts out of
 * Excel produces the latter and must not land as one blob in one cell.
 */
export function isGridPaste(text) {
    const value = String(text || '');
    if (value.includes('\t')) return true;
    return parseClipboardGrid(value).length > 1;
}

export function mapPasteRow(cells) {
    const out = {};
    GRID_FIELD_ORDER.forEach((key, idx) => {
        if (cells[idx] !== undefined) out[key] = cells[idx];
    });
    return out;
}
