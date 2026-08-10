import { fetchJson } from './api.js';

function authHeaders(token) {
    return token ? { 'x-session-token': token } : {};
}

/** Resolve one code (vendor tag or scanned barcode) to a catalog item, or null. */
export async function lookupItem(token, code) {
    const clean = String(code || '').trim();
    if (!clean || !token) return null;
    const res = await fetchJson(`/api/items/lookup?code=${encodeURIComponent(clean)}`, {
        cache: 'no-store',
        headers: authHeaders(token),
    });
    return res?.found ? res.item : null;
}

export async function searchItems(token, q, limit = 25) {
    const clean = String(q || '').trim();
    if (!clean || !token) return { rows: [], stats: null };
    const params = new URLSearchParams({ q: clean, limit: String(limit) });
    const res = await fetchJson(`/api/items/search?${params}`, {
        cache: 'no-store',
        headers: authHeaders(token),
    });
    return { rows: res?.rows || [], stats: res?.stats || null };
}

export async function getItemCatalogStats(token) {
    if (!token) return null;
    const res = await fetchJson('/api/items/search?q=&limit=1', {
        cache: 'no-store',
        headers: authHeaders(token),
    });
    return res?.stats || null;
}

export async function linkAlias(token, aliasCode, code) {
    return fetchJson('/api/items/link-alias', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ alias_code: aliasCode, code }),
    });
}

/**
 * `skipKnown` adds only codes the catalog cannot already resolve — use it for a
 * supplementary file (a price book) so it widens barcode coverage without
 * restating names the head-office item file owns.
 */
export async function importItemCsv(token, {
    filename, contentBase64, dryRun, skipKnown,
}) {
    return fetchJson('/api/items/import-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({
            filename, contentBase64, dry_run: !!dryRun, skip_known: !!skipKnown,
        }),
    });
}

export async function rebuildItemCatalog(token) {
    return fetchJson('/api/items/rebuild', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({}),
    });
}

/** Remove page headers, department banners and spreadsheet-mangled codes. */
export async function cleanupItemCatalog(token) {
    return fetchJson('/api/items/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({}),
    });
}
