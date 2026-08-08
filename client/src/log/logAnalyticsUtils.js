import { parseAmount, parseAmountOrNull, isInvalidAmount } from './logUtils.js';

export const SHRINK_BUCKETS = [
    { key: 'bakery', label: 'Bakery' },
    { key: 'dairy', label: 'Dairy' },
    { key: 'freezer', label: 'Freezer' },
    { key: 'grocery', label: 'Grocery' },
    { key: 'meat', label: 'Meat' },
    { key: 'produce', label: 'Produce' },
];

export const PURCHASE_COLUMNS = [
    { key: 'grocery', label: 'Grocery Purchases' },
    { key: 'tobacco', label: 'Tobacco Purchases' },
    { key: 'meat', label: 'Meat Purchases' },
    { key: 'bakery', label: 'Bakery Purchases' },
    { key: 'bakery_in_store', label: 'Bakery In Store' },
    { key: 'deli', label: 'Deli Purchases' },
    { key: 'produce', label: 'Produce Purchases' },
    { key: 'produce_shrink', label: 'Produce Shrink' },
    { key: 'dairy', label: 'Dairy Purchases' },
    { key: 'pharmacy', label: 'Pharmacy Purchases' },
];

export function formatMoney(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return n.toLocaleString('en-CA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

export function formatPct(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return `${(n * 100).toFixed(2)}%`;
}

export function formatShortDate(value) {
    if (!value) return '—';
    const dt = new Date(`${value}T12:00:00`);
    if (Number.isNaN(dt.getTime())) return value;
    return dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Same rules as the daily grid — invalid non-empty text must not become $0. */
export function parseSheetAmount(raw) {
    return parseAmount(raw);
}

export { parseAmountOrNull, isInvalidAmount };

export function weekLabel(weekNum, weekEnding) {
    return `WK${weekNum} · ${formatShortDate(weekEnding)}`;
}
