'use strict';

/**
 * Store item catalog so scanning a code fills in the description instead of
 * staff retyping it. Seeded from every item row already logged.
 *
 * Backfill SQL is frozen here so later item-catalog.cjs changes cannot alter
 * what this migration historically did on upgrade.
 */

function normalizeCodeFrozen(raw) {
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

function cleanTextFrozen(raw, max = 200) {
    const s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
}

function tableExists(db, name) {
    return !!db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
        name,
    );
}

/** Frozen historical backfill — INSERT OR IGNORE only (no live upsertItem). */
function backfillFromHistoryFrozen(db, now) {
    let scanned = 0;
    let created = 0;

    const seed = (codeRaw, description, zone, department) => {
        const code = normalizeCodeFrozen(codeRaw);
        if (!code) return;
        scanned += 1;
        const result = db.run(
            `INSERT OR IGNORE INTO item_catalog
                (code, raw_code, description, zone, department, size,
                 retail_price, unit_cost, case_cost, case_qty,
                 source, times_seen, first_seen, last_seen, updated_by)
             VALUES (?,?,?,?,?,'',NULL,NULL,NULL,NULL,'learned',1,?,?,?)`,
            code,
            cleanTextFrozen(codeRaw, 60),
            cleanTextFrozen(description),
            cleanTextFrozen(zone, 40),
            cleanTextFrozen(department, 60),
            now,
            now,
            '',
        );
        if (result?.changes) created += 1;
    };

    if (tableExists(db, 'kill_dates')) {
        const rows = db.all(
            `SELECT item_code, item, zone FROM kill_dates
              WHERE COALESCE(TRIM(item_code),'') != ''
              ORDER BY rowid ASC`,
        ) || [];
        for (const r of rows) seed(r.item_code, r.item, r.zone, '');
    }
    if (tableExists(db, 'floor_shrink_sku')) {
        const rows = db.all(
            `SELECT sku, item, zone FROM floor_shrink_sku
              WHERE COALESCE(TRIM(sku),'') != ''
              ORDER BY rowid ASC`,
        ) || [];
        for (const r of rows) seed(r.sku, r.item, r.zone, '');
    }
    if (tableExists(db, 'receiving_shrink_lines')) {
        const rows = db.all(
            `SELECT sku, description, department FROM receiving_shrink_lines
              WHERE COALESCE(TRIM(sku),'') != ''
              ORDER BY rowid ASC`,
        ) || [];
        for (const r of rows) seed(r.sku, r.description, '', r.department);
    }

    return { scanned, created };
}

module.exports = {
    name: '051_item_catalog',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS item_catalog (
                code TEXT PRIMARY KEY,
                raw_code TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                zone TEXT NOT NULL DEFAULT '',
                department TEXT NOT NULL DEFAULT '',
                size TEXT NOT NULL DEFAULT '',
                retail_price REAL,
                unit_cost REAL,
                case_cost REAL,
                case_qty INTEGER,
                source TEXT NOT NULL DEFAULT 'learned',
                times_seen INTEGER NOT NULL DEFAULT 0,
                first_seen TEXT NOT NULL DEFAULT '',
                last_seen TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_item_catalog_desc ON item_catalog(description);

            CREATE TABLE IF NOT EXISTS item_code_aliases (
                alias_code TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'learned',
                created_at TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_item_code_aliases_code ON item_code_aliases(code);
        `);

        // CREATE IF NOT EXISTS will not add columns if an earlier failed run left the
        // table behind (SQLite DDL auto-commits). Ensure the price columns exist before
        // seeding — upsertItem writes them, and 052 is a no-op when they are already here.
        const cols = new Set(
            (db.all('PRAGMA table_info(item_catalog)') || []).map((c) => c.name),
        );
        const add = (name, ddl) => {
            if (!cols.has(name)) db.exec(`ALTER TABLE item_catalog ADD COLUMN ${ddl}`);
        };
        add('retail_price', 'retail_price REAL');
        add('unit_cost', 'unit_cost REAL');
        add('case_cost', 'case_cost REAL');
        add('case_qty', 'case_qty INTEGER');

        const result = backfillFromHistoryFrozen(db, new Date().toISOString());
        console.log(`[MIGRATION] item_catalog seeded ${result.created} item(s) from ${result.scanned} historical row(s)`);
    },
};
