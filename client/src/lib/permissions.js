/**
 * Normalize a comma-separated staff permissions string to lowercase tokens.
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parsePermissionTokens(raw) {
    return String(raw || '')
        .split(',')
        .map((p) => String(p).trim().toLowerCase())
        .filter(Boolean);
}

/**
 * True when the permissions list includes the given permission (case/space insensitive).
 * @param {unknown} raw
 * @param {string} perm
 */
export function hasPermission(raw, perm) {
    const needle = String(perm || '').trim().toLowerCase();
    if (!needle) return false;
    return parsePermissionTokens(raw).includes(needle);
}
