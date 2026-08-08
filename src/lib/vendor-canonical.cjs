'use strict';

const DEFAULT_VENDOR_ALIASES = [
    { canonical: 'TGP', aliases: ['TGP', 'The Grocery People', 'TGP order'] },
    { canonical: 'Coke', aliases: ['Coke', 'coca cola', 'coca-cola', 'coca-cola canada'] },
    { canonical: 'Pepsi', aliases: ['Pepsi', 'pesis', 'pepsico'] },
    { canonical: 'Canada Bread', aliases: ['Canada Bread', 'canada bread'] },
    { canonical: 'Complete', aliases: ['Complete', 'complete purchasing'] },
    { canonical: 'Frito Lay (Retail)', aliases: ['Frito Lay (Retail)', 'frito lay retail', 'frito retail', 'frito lay'] },
    { canonical: 'Frito Lay (Vending)', aliases: ['Frito Lay (Vending)', 'frito lay vending', 'frito vending'] },
    { canonical: 'Italian Bakery', aliases: ['Italian Bakery', 'italian bakery'] },
    { canonical: 'Old Dutch', aliases: ['Old Dutch', 'old dutch'] },
    { canonical: 'Kenelli', aliases: ['Kenelli'] },
    { canonical: 'Arctic Ice', aliases: ['Arctic Ice', 'Artic Ice', 'artic ice'] },
    { canonical: 'Calahoo Meats', aliases: ['Calahoo Meats', 'calahoo meats'] },
    { canonical: 'Canadian Linen', aliases: ['Canadian Linen', 'canadian linen'] },
    { canonical: 'Direct Plus Food Group', aliases: ['Direct Plus Food Group', 'direct plus food group'] },
    { canonical: 'G&L Distributors', aliases: ['G&L Distributors', 'g&l distributors', 'g and l distributors'] },
    { canonical: 'Grimms', aliases: ['Grimms', "Grimm's"] },
    { canonical: 'Shasky', aliases: ['Shasky'] },
];

function normalizeVendorWhitespace(value) {
    return String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function titleCaseVendor(value) {
    const clean = normalizeVendorWhitespace(value);
    if (!clean) return '';
    const upperKeep = new Set(['TGP', 'G&L']);
    return clean.split(' ').map((part) => {
        const normalized = part.replace(/[^\w&]/g, '').toUpperCase();
        if (upperKeep.has(normalized)) return normalized;
        if (/^\([^)]+\)$/.test(part)) return part.toUpperCase();
        if (part.includes('&')) {
            return part.split('&').map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p)).join('&');
        }
        return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    }).join(' ');
}

function vendorAliasKey(value) {
    const clean = normalizeVendorWhitespace(value).toLowerCase();
    return clean
        .replace(/&/g, ' and ')
        .replace(/[()]/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function ensureVendorAliasSchema(db) {
    if (!db || typeof db.exec !== 'function') return false;
    db.exec(`
        CREATE TABLE IF NOT EXISTS receiving_vendor_aliases (
            alias_key TEXT PRIMARY KEY,
            alias_text TEXT NOT NULL,
            canonical_vendor TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            source TEXT NOT NULL DEFAULT 'seed',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_receiving_vendor_aliases_canonical
            ON receiving_vendor_aliases(canonical_vendor, active);
    `);
    return true;
}

function insertAlias(db, aliasText, canonical, source = 'seed') {
    const alias = normalizeVendorWhitespace(aliasText);
    const vendor = normalizeVendorWhitespace(canonical);
    const key = vendorAliasKey(alias);
    if (!alias || !vendor || !key || !db || typeof db.run !== 'function') return false;
    const now = new Date().toISOString();
    db.run(
        `INSERT OR IGNORE INTO receiving_vendor_aliases
            (alias_key, alias_text, canonical_vendor, active, source, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?)`,
        key, alias, vendor, 1, source, now, now,
    );
    return true;
}

function seedDefaultVendorAliases(db) {
    if (!ensureVendorAliasSchema(db)) return false;
    DEFAULT_VENDOR_ALIASES.forEach((entry) => {
        insertAlias(db, entry.canonical, entry.canonical, 'seed');
        (entry.aliases || []).forEach((alias) => insertAlias(db, alias, entry.canonical, 'seed'));
    });
    return true;
}

function resolveVendorAlias(db, value) {
    const schemaReady = ensureVendorAliasSchema(db);
    const raw = normalizeVendorWhitespace(value).slice(0, 120);
    if (!raw) return { original: '', vendor: '', changed: false, aliasKey: '' };
    const key = vendorAliasKey(raw);
    let row = null;
    if (schemaReady && key && db && typeof db.get === 'function') {
        row = db.get(
            'SELECT canonical_vendor FROM receiving_vendor_aliases WHERE alias_key=? AND active=1',
            key,
        );
    }
    const vendor = normalizeVendorWhitespace(row?.canonical_vendor || titleCaseVendor(raw)).slice(0, 120);
    return { original: raw, vendor, changed: vendor !== raw, aliasKey: key };
}

function normalizeVendorInput(db, value) {
    seedDefaultVendorAliases(db);
    return resolveVendorAlias(db, value).vendor;
}

function listCanonicalVendors(db) {
    const schemaReady = seedDefaultVendorAliases(db);
    const names = new Set();

    const add = (value) => {
        const vendor = normalizeVendorWhitespace(value);
        if (vendor) names.add(vendor);
    };

    if (schemaReady && db && typeof db.all === 'function') {
        db.all(`
            SELECT DISTINCT canonical_vendor AS vendor
              FROM receiving_vendor_aliases
             WHERE active=1
        `).forEach((r) => add(r.vendor));
    }

    try {
        db.all("SELECT DISTINCT vendor FROM expected_orders WHERE vendor IS NOT NULL AND trim(vendor)!=''")
            .forEach((r) => add(resolveVendorAlias(db, r.vendor).vendor));
    } catch (_) {}

    try {
        db.all("SELECT DISTINCT vendor FROM vendor_schedule WHERE vendor IS NOT NULL AND trim(vendor)!=''")
            .forEach((r) => add(resolveVendorAlias(db, r.vendor).vendor));
    } catch (_) {}

    return Array.from(names).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function normalizeExistingVendorTable(db, table, column) {
    if (!db || typeof db.all !== 'function' || typeof db.run !== 'function') return 0;
    const rows = db.all(`SELECT DISTINCT ${column} AS vendor FROM ${table} WHERE ${column} IS NOT NULL AND trim(${column})!=''`);
    let changed = 0;
    rows.forEach((row) => {
        const resolved = resolveVendorAlias(db, row.vendor);
        if (resolved.changed && resolved.vendor && resolved.vendor !== row.vendor) {
            const info = db.run(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`, resolved.vendor, row.vendor);
            changed += Number(info?.changes || 0);
        }
    });
    return changed;
}

function normalizeExistingReceivingVendors(db) {
    if (!seedDefaultVendorAliases(db)) return 0;
    let changed = 0;
    try { changed += normalizeExistingVendorTable(db, 'expected_orders', 'vendor'); } catch (_) {}
    try { changed += normalizeExistingVendorTable(db, 'receiving_stats', 'vendor'); } catch (_) {}
    try { changed += normalizeExistingVendorTable(db, 'vendor_schedule', 'vendor'); } catch (_) {}
    return changed;
}

module.exports = {
    DEFAULT_VENDOR_ALIASES,
    normalizeVendorWhitespace,
    titleCaseVendor,
    vendorAliasKey,
    ensureVendorAliasSchema,
    seedDefaultVendorAliases,
    insertAlias,
    resolveVendorAlias,
    normalizeVendorInput,
    listCanonicalVendors,
    normalizeExistingReceivingVendors,
};
