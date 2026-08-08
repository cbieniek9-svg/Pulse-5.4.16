/** Mirror of server SHRINK_REASONS — labels are what we store on each line. */
export const SHRINK_REASONS = [
    { code: 'damaged', label: 'Damaged' },
    { code: 'outdated', label: 'Outdated / Expired' },
    { code: 'spoil', label: 'Spoil / Quality' },
    { code: 'theft', label: 'Theft / Unknown' },
    { code: 'vendor', label: 'Vendor defect' },
    { code: 'other', label: 'Other' },
];

export function normalizeShrinkReason(raw) {
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

/** Value for a <select> bound to SHRINK_REASONS labels. */
export function reasonSelectValue(raw) {
    const bucket = normalizeShrinkReason(raw);
    if (bucket === 'Unspecified') return '';
    return SHRINK_REASONS.some((r) => r.label === bucket) ? bucket : 'Other';
}
