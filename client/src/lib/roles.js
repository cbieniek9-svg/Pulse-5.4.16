export function normalizeRole(role) {
    return String(role || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isManagerRole(role) {
    const normalized = normalizeRole(role);
    return normalized === 'manager' || normalized === 'store manager';
}
