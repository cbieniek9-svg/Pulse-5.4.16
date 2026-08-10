'use strict';

const crypto = require('crypto');
const { getPulseInventoryDb } = require('./pulse-inventory-db.cjs');
const { codeCandidates, normalizeCode } = require('./item-catalog.cjs');
const { csvCell: csvEscape } = require('./csv-safe.cjs');

const INVENTORY_COUNT_SETTING = 'Inventory_Count_Enabled';
const SESSION_TYPES = new Set(['location', 'backstock', 'order']);

/** Manager toggle; default off. Env TGP_INVENTORY_COUNT=1 forces on for tests. */
function isInventoryCountEnabled(settings) {
    const env = process.env.TGP_INVENTORY_COUNT;
    if (env != null && String(env).trim() !== '') {
        const n = String(env).trim().toLowerCase();
        if (['1', 'true', 'yes', 'on'].includes(n)) return true;
        if (['0', 'false', 'no', 'off'].includes(n)) return false;
    }
    return settings?.[INVENTORY_COUNT_SETTING] === '1';
}

function normalizeSessionType(raw) {
    const t = String(raw || 'location').trim().toLowerCase();
    return SESSION_TYPES.has(t) ? t : 'location';
}

function newSessionId() {
    return `S-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function normalizeQty(raw) {
    let quantity = Number(raw);
    if (!Number.isFinite(quantity) || quantity <= 0) quantity = 1;
    return Math.floor(quantity);
}

function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100) / 100;
}

/**
 * @param {unknown} raw
 * @param {{ sessionType: string }} opts
 * @returns {'case'|'unit'}
 */
function normalizeCountUom(raw, { sessionType } = {}) {
    const type = normalizeSessionType(sessionType);
    const trimmed = raw == null ? '' : String(raw).trim().toLowerCase();
    if (type === 'backstock' || type === 'order') {
        if (!trimmed || trimmed === 'case') return 'case';
        const err = new Error('Backstock and order drafts are case-only.');
        err.status = 400;
        err.code = 'COUNT_UOM_CASE_ONLY';
        throw err;
    }
    if (!trimmed) {
        const err = new Error('Select case or unit before scanning a location count.');
        err.status = 400;
        err.code = 'COUNT_UOM_REQUIRED';
        throw err;
    }
    if (trimmed !== 'case' && trimmed !== 'unit') {
        const err = new Error('UOM must be case or unit.');
        err.status = 400;
        err.code = 'COUNT_UOM_INVALID';
        throw err;
    }
    return trimmed;
}

function captureCountPriceSnapshot(lookupItem, upc, uom, now = new Date().toISOString()) {
    let hit = null;
    if (typeof lookupItem === 'function') {
        try { hit = lookupItem(upc); } catch (_) { hit = null; }
    }
    if (!hit) {
        return {
            unit_cost: null,
            unit_retail: null,
            department: '',
            priced_at: now,
            item_description: '',
        };
    }
    let unitCost = money(hit.unit_cost);
    let unitRetail = money(hit.retail_price);
    if (uom === 'case') {
        const caseCost = money(hit.case_cost);
        if (caseCost != null) unitCost = caseCost;
        else if (unitCost != null && Number.isFinite(Number(hit.case_qty)) && Number(hit.case_qty) > 0) {
            unitCost = money(unitCost * Number(hit.case_qty));
        }
        if (unitRetail != null && Number.isFinite(Number(hit.case_qty)) && Number(hit.case_qty) > 0) {
            unitRetail = money(unitRetail * Number(hit.case_qty));
        }
    }
    return {
        unit_cost: unitCost,
        unit_retail: unitRetail,
        department: String(hit.department || '').trim(),
        priced_at: now,
        item_description: String(hit.description || hit.item || '').trim().slice(0, 200),
    };
}

function escHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatMoneyLabel(value) {
    const n = money(value);
    if (n == null) return '—';
    return n.toFixed(2);
}

/**
 * All UPC / code forms that should be treated as the same product for matching.
 * Catalog lookup + check-digit variants (scanned 057…840 vs filed 57…84).
 * @param {string} rawUpc
 * @param {function} [lookup]
 * @returns {string[]}
 */
function productMatchKeys(rawUpc, lookup) {
    const keys = [];
    const seen = new Set();
    const push = (v) => {
        const s = String(v || '').trim();
        if (!s || seen.has(s)) return;
        seen.add(s);
        keys.push(s);
        const n = normalizeCode(s);
        if (n && !seen.has(n)) {
            seen.add(n);
            keys.push(n);
        }
    };

    push(rawUpc);
    for (const c of codeCandidates(rawUpc)) push(c);

    if (typeof lookup === 'function') {
        const tryLookup = (code) => {
            try {
                const hit = lookup(code);
                if (!hit) return;
                if (hit.code) {
                    push(hit.code);
                    for (const c of codeCandidates(hit.code)) push(c);
                }
                if (hit.matched_code) push(hit.matched_code);
            } catch (_) { /* ignore */ }
        };
        tryLookup(rawUpc);
        // Memory may store a normalized/stripped form; try every candidate.
        for (const c of [...keys]) tryLookup(c);
    }
    return keys;
}

/** Prefer catalog primary code when known, else normalized scanned digits. */
function preferCanonicalUpc(rawUpc, lookup) {
    if (typeof lookup === 'function') {
        try {
            const hit = lookup(rawUpc);
            if (hit?.code) return String(hit.code);
        } catch (_) { /* ignore */ }
    }
    return normalizeCode(rawUpc) || String(rawUpc || '').trim();
}

function mergeLocationQty(intoMap, location, quantity) {
    const loc = String(location || 'Backstock');
    const q = Number(quantity) || 0;
    if (q <= 0) return;
    intoMap.set(loc, (intoMap.get(loc) || 0) + q);
}

/**
 * Index committed/open backstock so check-digit / catalog variants hit the same pool.
 * @param {object[]} items summarizeBackstock().items
 * @param {function} [lookup]
 */
function buildBackstockMatchIndex(items, lookup) {
    const groups = [];
    const keyToGroup = new Map();

    for (const item of items || []) {
        const upc = String(item.upc || '').trim();
        if (!upc) continue;
        const keys = productMatchKeys(upc, lookup);
        let group = null;
        for (const k of keys) {
            if (keyToGroup.has(k)) {
                group = keyToGroup.get(k);
                break;
            }
        }
        if (!group) {
            group = {
                quantity: 0,
                by_location: new Map(),
                source_upcs: new Set(),
            };
            groups.push(group);
        }
        group.quantity += Number(item.quantity) || 0;
        group.source_upcs.add(upc);
        if (Array.isArray(item.by_location) && item.by_location.length) {
            for (const loc of item.by_location) {
                mergeLocationQty(group.by_location, loc.location, loc.quantity);
            }
        } else if (item.locations) {
            // Fallback: unknown split — put all qty under first location label.
            const first = String(item.locations).split(',')[0] || 'Backstock';
            mergeLocationQty(group.by_location, first, item.quantity);
        }
        for (const k of keys) keyToGroup.set(k, group);
    }

    return {
        find(upc) {
            for (const k of productMatchKeys(upc, lookup)) {
                if (keyToGroup.has(k)) {
                    const g = keyToGroup.get(k);
                    return {
                        quantity: g.quantity,
                        by_location: [...g.by_location.entries()].map(([location, quantity]) => ({
                            location,
                            quantity,
                        })),
                        locations: [...g.by_location.keys()].join(','),
                        source_upcs: [...g.source_upcs],
                    };
                }
            }
            return null;
        },
    };
}

/**
 * Merge order-draft lines that are the same product under different UPC spellings.
 * @param {{ upc: string, quantity: number }[]} rows
 * @param {function} [lookup]
 */
function mergeOrderRowsByProduct(rows, lookup) {
    const groups = [];
    const keyToGroup = new Map();
    for (const row of rows || []) {
        const upc = String(row.upc || '').trim();
        const quantity = Number(row.quantity) || 0;
        if (!upc || quantity <= 0) continue;
        const keys = productMatchKeys(upc, lookup);
        let group = null;
        for (const k of keys) {
            if (keyToGroup.has(k)) {
                group = keyToGroup.get(k);
                break;
            }
        }
        if (!group) {
            group = { upc, quantity: 0 };
            groups.push(group);
            for (const k of keys) keyToGroup.set(k, group);
        } else {
            for (const k of keys) keyToGroup.set(k, group);
        }
        group.quantity += quantity;
    }
    return groups;
}

function getSession(sessionId) {
    const db = getPulseInventoryDb();
    return db.prepare(`
        SELECT id, location, session_type, status, created_at, created_by, exported_at, export_note,
               CASE WHEN report_json IS NOT NULL AND TRIM(report_json) != '' THEN 1 ELSE 0 END AS has_report
        FROM count_sessions WHERE id = ?
    `).get(String(sessionId || '').trim());
}

function assertSessionOpen(session) {
    if (String(session?.status) !== 'open') {
        const err = new Error('This count session is locked. Reopen it before editing lines.');
        err.status = 409;
        err.code = 'INVENTORY_SESSION_LOCKED';
        throw err;
    }
}

function requireSessionRow(sessionId, { allowExported = false } = {}) {
    const row = getSession(sessionId);
    if (!row) {
        const err = new Error('Count session not found.');
        err.status = 404;
        throw err;
    }
    if (!allowExported) {
        assertSessionOpen(row);
    }
    return row;
}

function isClosedStatus(status) {
    return status === 'exported' || status === 'committed';
}

function sessionLineCount(sessionId) {
    const db = getPulseInventoryDb();
    return db.prepare('SELECT COUNT(*) AS c FROM count_lines WHERE session_id = ?')
        .get(sessionId)?.c || 0;
}

/**
 * @param {{ location?: string, session_type?: string, created_by?: string }} input
 */
function createSession(input) {
    const sessionType = normalizeSessionType(input?.session_type);
    let location = String(input?.location ?? '').trim();
    if (!location) {
        if (sessionType === 'backstock') location = 'Backstock';
        else if (sessionType === 'order') location = 'Order draft';
        else location = '';
    }
    if (!location) {
        const err = new Error('location is required.');
        err.status = 400;
        throw err;
    }
    const id = newSessionId();
    const createdBy = String(input?.created_by ?? '').trim() || null;
    const db = getPulseInventoryDb();
    db.prepare(`
        INSERT INTO count_sessions (id, location, session_type, status, created_by)
        VALUES (?, ?, ?, 'open', ?)
    `).run(id, location, sessionType, createdBy);
    return getSession(id);
}

/**
 * @param {{ status?: 'open'|'exported'|'committed'|'all', session_type?: string }} [opts]
 */
function listSessions(opts = {}) {
    const db = getPulseInventoryDb();
    const status = String(opts.status || 'all').toLowerCase();
    const typeFilter = opts.session_type != null && String(opts.session_type).trim() !== ''
        ? normalizeSessionType(opts.session_type)
        : null;

    const typeClause = typeFilter ? ' AND s.session_type = ?' : '';
    const params = [];
    let statusClause = '1=1';
    if (status === 'open') {
        statusClause = 's.status = ?';
        params.push('open');
    } else if (status === 'committed') {
        statusClause = 's.status = ?';
        params.push('committed');
    } else if (status === 'exported') {
        // Past walks: CSV-exported aisle counts + committed backstock.
        statusClause = "s.status IN ('exported', 'committed')";
    }
    if (typeFilter) params.push(typeFilter);

    const sessionSelect = `
            SELECT s.id, s.location, s.session_type, s.status, s.created_at, s.created_by,
                   s.exported_at, s.export_note,
                   CASE WHEN s.report_json IS NOT NULL AND TRIM(s.report_json) != '' THEN 1 ELSE 0 END AS has_report,
                (SELECT COUNT(*) FROM count_lines cl WHERE cl.session_id = s.id) AS line_count,
                (SELECT COALESCE(SUM(quantity), 0) FROM count_lines cl WHERE cl.session_id = s.id) AS unit_count
            FROM count_sessions s
    `;

    let sql;
    if (status === 'open' || status === 'exported' || status === 'committed') {
        sql = `
            ${sessionSelect}
            WHERE ${statusClause}${typeClause}
            ORDER BY COALESCE(s.exported_at, s.created_at) DESC, s.created_at DESC
        `;
    } else {
        sql = `
            ${sessionSelect}
            WHERE 1=1${typeClause}
            ORDER BY CASE s.status WHEN 'open' THEN 0 ELSE 1 END,
                     COALESCE(s.exported_at, s.created_at) DESC,
                     s.created_at DESC
        `;
    }
    return db.prepare(sql).all(...params);
}

function backstockStatusClause(opts = {}) {
    const includeExported = opts.include_exported === true || opts.include_exported === '1';
    return {
        includeExported,
        statusClause: includeExported
            ? "s.status IN ('open', 'exported', 'committed')"
            : "s.status = 'open'",
    };
}

/**
 * Committed on-hand rows (after CLOSE & COMMIT).
 * @returns {{ upc: string, location: string, quantity: number, updated_at?: string, source_session_id?: string }[]}
 */
function listCommittedBackstock() {
    const db = getPulseInventoryDb();
    return db.prepare(`
        SELECT upc, location, quantity, updated_at, source_session_id
        FROM backstock_on_hand
        WHERE quantity > 0
        ORDER BY location ASC, upc ASC
    `).all().map((r) => ({
        upc: String(r.upc || ''),
        location: String(r.location || 'Backstock'),
        quantity: Number(r.quantity) || 0,
        updated_at: r.updated_at || null,
        source_session_id: r.source_session_id || null,
    }));
}

/**
 * Backstock qty per UPC × location from open (or exported) scan sessions — not committed memory.
 * @param {{ include_exported?: boolean }} [opts]
 */
function listSessionBackstockByLocation(opts = {}) {
    const db = getPulseInventoryDb();
    const { statusClause } = backstockStatusClause(opts);
    return db.prepare(`
        SELECT cl.upc AS upc,
               s.location AS location,
               SUM(cl.quantity) AS quantity
        FROM count_lines cl
        JOIN count_sessions s ON s.id = cl.session_id
        WHERE s.session_type = 'backstock' AND ${statusClause}
        GROUP BY cl.upc, s.location
        ORDER BY s.location ASC, cl.upc ASC
    `).all().map((r) => ({
        upc: String(r.upc || ''),
        location: String(r.location || 'Backstock'),
        quantity: Number(r.quantity) || 0,
    }));
}

/**
 * @param {{ include_exported?: boolean, source?: 'committed'|'open' }} [opts]
 */
function listBackstockByLocation(opts = {}) {
    const source = String(opts.source || 'committed').toLowerCase();
    if (source === 'open') return listSessionBackstockByLocation(opts);
    return listCommittedBackstock().map((r) => ({
        upc: r.upc,
        location: r.location,
        quantity: r.quantity,
    }));
}

/**
 * Aggregate backstock UPCs for order filtering / pick list.
 * Default source = committed memory (CLOSE & COMMIT). Pass source:'open' for live walks.
 * @param {{ include_exported?: boolean, source?: 'committed'|'open'|'both' }} [opts]
 */
function summarizeBackstock(opts = {}) {
    const source = String(opts.source || 'committed').toLowerCase();
    const byLocMaps = new Map(); // upc -> Map(location -> qty)
    const qtyMap = new Map();

    const addRow = (upc, location, quantity) => {
        const u = String(upc || '').trim();
        const q = Number(quantity) || 0;
        if (!u || q <= 0) return;
        const loc = String(location || 'Backstock');
        qtyMap.set(u, (qtyMap.get(u) || 0) + q);
        if (!byLocMaps.has(u)) byLocMaps.set(u, new Map());
        const locMap = byLocMaps.get(u);
        locMap.set(loc, (locMap.get(loc) || 0) + q);
    };

    if (source === 'committed' || source === 'both') {
        for (const r of listCommittedBackstock()) addRow(r.upc, r.location, r.quantity);
    }
    if (source === 'open' || source === 'both') {
        for (const r of listSessionBackstockByLocation({
            include_exported: source === 'both' ? false : opts.include_exported,
        })) {
            addRow(r.upc, r.location, r.quantity);
        }
    }

    const items = [...qtyMap.entries()]
        .map(([upc, quantity]) => {
            const locMap = byLocMaps.get(upc) || new Map();
            const by_location = [...locMap.entries()].map(([location, q]) => ({
                location,
                quantity: q,
            })).sort((a, b) => a.location.localeCompare(b.location));
            return {
                upc,
                quantity,
                session_count: by_location.length,
                locations: by_location.map((l) => l.location).join(','),
                by_location,
            };
        })
        .sort((a, b) => b.quantity - a.quantity || a.upc.localeCompare(b.upc));

    return {
        items,
        upc_count: items.length,
        total_units: items.reduce((s, r) => s + r.quantity, 0),
        source,
        include_exported: opts.include_exported === true || opts.include_exported === '1',
    };
}

/**
 * Close a backstock walk and write its counts into durable on-hand memory.
 * Replaces all committed qty for that location (the walk is the truth for the bay).
 * Stores catalog-canonical UPCs when lookup is provided so check-digit variants unify.
 * Does not touch the floor labor order clock.
 * @param {string} sessionId
 * @param {{ lookupItem?: function }} [opts]
 */
function closeBackstockSession(sessionId, opts = {}) {
    const session = requireSessionRow(sessionId);
    if (normalizeSessionType(session.session_type) !== 'backstock') {
        const err = new Error('Only backstock walks can be committed to memory.');
        err.status = 400;
        throw err;
    }
    const lookup = typeof opts.lookupItem === 'function' ? opts.lookupItem : null;
    const db = getPulseInventoryDb();
    const location = String(session.location || 'Backstock');
    const rawRows = db.prepare(`
        SELECT upc, SUM(quantity) AS quantity
        FROM count_lines
        WHERE session_id = ?
        GROUP BY upc
        HAVING SUM(quantity) > 0
        ORDER BY upc ASC
    `).all(session.id);

    // Collapse check-digit / catalog variants into one memory row per product.
    const byCanonical = new Map();
    for (const row of rawRows) {
        const canonical = preferCanonicalUpc(row.upc, lookup);
        const prev = byCanonical.get(canonical) || { upc: canonical, quantity: 0, scanned_as: [] };
        prev.quantity += Number(row.quantity) || 0;
        prev.scanned_as.push(String(row.upc));
        byCanonical.set(canonical, prev);
    }
    const rows = [...byCanonical.values()];

    const now = new Date().toISOString();
    const run = db.transaction(() => {
        db.prepare('DELETE FROM backstock_on_hand WHERE location = ?').run(location);
        const insert = db.prepare(`
            INSERT INTO backstock_on_hand (upc, location, quantity, updated_at, source_session_id)
            VALUES (?, ?, ?, ?, ?)
        `);
        for (const row of rows) {
            insert.run(String(row.upc), location, Number(row.quantity) || 0, now, session.id);
        }
        db.prepare(`
            UPDATE count_sessions
            SET status = 'committed', exported_at = ?, export_note = ?
            WHERE id = ?
        `).run(
            now,
            `Committed ${rows.length} UPC(s) at ${location} to backstock memory`,
            session.id,
        );
    });
    run();

    return {
        session: getSession(session.id),
        location,
        committed: rows.map((r) => ({
            upc: String(r.upc),
            quantity: Number(r.quantity) || 0,
            location,
            scanned_as: r.scanned_as,
        })),
        upc_count: rows.length,
        total_units: rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0),
        memory: summarizeBackstock({ source: 'committed' }),
    };
}

function getSessionDetail(sessionId) {
    const session = requireSessionRow(sessionId, { allowExported: true });
    const db = getPulseInventoryDb();
    const lines = db.prepare(`
        SELECT id, session_id, upc, quantity, uom, unit_cost, unit_retail, department,
               priced_at, item_description, scanned_at, updated_at
        FROM count_lines
        WHERE session_id = ?
        ORDER BY scanned_at DESC, id DESC
    `).all(session.id);
    return { session, lines, line_count: lines.length };
}

/**
 * @param {{ session_id: string, upc: string, quantity?: number|string, uom?: string, lookupItem?: Function }} input
 */
function insertScan(input) {
    const session = requireSessionRow(input?.session_id);
    const upc = String(input?.upc ?? '').trim();
    if (!upc) {
        const err = new Error('upc is required.');
        err.status = 400;
        throw err;
    }
    const quantity = normalizeQty(input?.quantity);
    const sessionType = normalizeSessionType(session.session_type);
    const uom = normalizeCountUom(input?.uom, { sessionType });
    const stamp = new Date().toISOString();
    const snap = captureCountPriceSnapshot(input?.lookupItem, upc, uom, stamp);
    const db = getPulseInventoryDb();
    const result = db.prepare(`
        INSERT INTO count_lines
            (session_id, upc, quantity, uom, unit_cost, unit_retail, department, priced_at, item_description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        session.id,
        upc,
        quantity,
        uom,
        snap.unit_cost,
        snap.unit_retail,
        snap.department,
        snap.priced_at,
        snap.item_description,
    );

    return db.prepare(`
        SELECT id, session_id, upc, quantity, uom, unit_cost, unit_retail, department,
               priced_at, item_description, scanned_at, updated_at
        FROM count_lines WHERE id = ?
    `).get(result.lastInsertRowid);
}

/**
 * Compat: active lines for a session, or all open-session lines.
 * @param {{ session_id?: string }} [opts]
 */
function listActiveScans(opts = {}) {
    const db = getPulseInventoryDb();
    const sessionId = String(opts.session_id || '').trim();
    if (sessionId) {
        requireSessionRow(sessionId, { allowExported: true });
        return db.prepare(`
            SELECT cl.id, cl.session_id, cl.upc, cl.quantity, cl.uom, cl.unit_cost, cl.unit_retail,
                   cl.department, cl.priced_at, cl.item_description, cl.scanned_at, cl.updated_at,
                   s.location, s.status
            FROM count_lines cl
            JOIN count_sessions s ON s.id = cl.session_id
            WHERE cl.session_id = ?
            ORDER BY cl.scanned_at DESC, cl.id DESC
        `).all(sessionId);
    }
    return db.prepare(`
        SELECT cl.id, cl.session_id, cl.upc, cl.quantity, cl.uom, cl.unit_cost, cl.unit_retail,
               cl.department, cl.priced_at, cl.item_description, cl.scanned_at, cl.updated_at,
               s.location, s.status
        FROM count_lines cl
        JOIN count_sessions s ON s.id = cl.session_id
        WHERE s.status = 'open'
        ORDER BY cl.scanned_at DESC, cl.id DESC
    `).all();
}

/**
 * @param {number|string} lineId
 * @param {{ quantity?: number|string, upc?: string }} patch
 */
function updateLine(lineId, patch) {
    const db = getPulseInventoryDb();
    const id = Number(lineId);
    if (!Number.isFinite(id)) {
        const err = new Error('Invalid line id.');
        err.status = 400;
        throw err;
    }
    const row = db.prepare(`
        SELECT cl.*, s.status AS session_status, s.session_type
        FROM count_lines cl
        JOIN count_sessions s ON s.id = cl.session_id
        WHERE cl.id = ?
    `).get(id);
    if (!row) {
        const err = new Error('Count line not found.');
        err.status = 404;
        throw err;
    }
    assertSessionOpen({ status: row.session_status });

    let upc = row.upc;
    let quantity = row.quantity;
    let uom = row.uom || 'case';
    if (patch?.upc != null) {
        upc = String(patch.upc).trim();
        if (!upc) {
            const err = new Error('upc cannot be empty.');
            err.status = 400;
            throw err;
        }
    }
    if (patch?.quantity != null) {
        quantity = normalizeQty(patch.quantity);
    }
    if (patch?.uom != null || patch?.upc != null) {
        uom = normalizeCountUom(
            patch?.uom != null ? patch.uom : uom,
            { sessionType: row.session_type },
        );
    }

    const stamp = new Date().toISOString();
    // Re-price only when identity actually changes (or caller asks). Echoing the same
    // upc/uom in a quantity patch must not wipe stored snapshots.
    const prevUpc = String(row.upc || '');
    const prevUom = String(row.uom || 'case');
    const shouldResnapshot = patch?.refresh_prices === true
        || upc !== prevUpc
        || uom !== prevUom;
    const snap = shouldResnapshot
        ? captureCountPriceSnapshot(patch?.lookupItem, upc, uom, stamp)
        : {
            unit_cost: row.unit_cost,
            unit_retail: row.unit_retail,
            department: row.department || '',
            priced_at: row.priced_at || '',
            item_description: row.item_description || '',
        };

    db.prepare(`
        UPDATE count_lines
        SET upc = ?, quantity = ?, uom = ?, unit_cost = ?, unit_retail = ?,
            department = ?, priced_at = ?, item_description = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(
        upc,
        quantity,
        uom,
        snap.unit_cost,
        snap.unit_retail,
        snap.department,
        snap.priced_at,
        snap.item_description,
        id,
    );

    return db.prepare(`
        SELECT id, session_id, upc, quantity, uom, unit_cost, unit_retail, department,
               priced_at, item_description, scanned_at, updated_at
        FROM count_lines WHERE id = ?
    `).get(id);
}

function deleteLine(lineId) {
    const db = getPulseInventoryDb();
    const id = Number(lineId);
    if (!Number.isFinite(id)) {
        const err = new Error('Invalid line id.');
        err.status = 400;
        throw err;
    }
    const row = db.prepare(`
        SELECT cl.id, s.status AS session_status
        FROM count_lines cl
        JOIN count_sessions s ON s.id = cl.session_id
        WHERE cl.id = ?
    `).get(id);
    if (!row) {
        const err = new Error('Count line not found.');
        err.status = 404;
        throw err;
    }
    assertSessionOpen({ status: row.session_status });
    db.prepare('DELETE FROM count_lines WHERE id = ?').run(id);
    return { success: true, id };
}

/**
 * Export CSV for a session and mark exported (keeps lines for history/edit).
 * @param {string} sessionId
 */
function exportSession(sessionId) {
    const session = requireSessionRow(sessionId, { allowExported: true });
    const db = getPulseInventoryDb();
    const rows = db.prepare(`
        SELECT upc, quantity, uom, unit_cost, unit_retail, department, item_description
        FROM count_lines
        WHERE session_id = ?
        ORDER BY scanned_at ASC, id ASC
    `).all(session.id);

    const lines = ['UPC,QTY,UOM,ITEM,UNIT_COST,UNIT_RETAIL,DEPARTMENT,LOCATION,SESSION_TYPE,SESSION_ID'];
    for (const row of rows) {
        lines.push([
            csvEscape(row.upc),
            csvEscape(row.quantity),
            csvEscape(row.uom || 'case'),
            csvEscape(row.item_description || ''),
            csvEscape(row.unit_cost == null ? '' : row.unit_cost),
            csvEscape(row.unit_retail == null ? '' : row.unit_retail),
            csvEscape(row.department || ''),
            csvEscape(session.location),
            csvEscape(session.session_type || 'location'),
            csvEscape(session.id),
        ].join(','));
    }

    const exportedAt = new Date().toISOString();
    db.prepare(`
        UPDATE count_sessions
        SET status = 'exported', exported_at = ?, export_note = ?
        WHERE id = ?
    `).run(exportedAt, `Exported ${rows.length} line(s)`, session.id);

    const typeTag = session.session_type === 'backstock'
        ? 'Backstock'
        : (session.session_type === 'order' ? 'OrderDraft' : 'Count');
    const safeLoc = String(session.location || typeTag).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 40);
    return {
        csv: `${lines.join('\n')}\n`,
        count: rows.length,
        session: getSession(session.id),
        filename: `${typeTag}_${safeLoc}_${exportedAt.slice(0, 10)}.csv`,
    };
}

/**
 * Close a location count without requiring CSV download (status → exported).
 */
function closeLocationSession(sessionId, opts = {}) {
    const session = requireSessionRow(sessionId, { allowExported: true });
    if (normalizeSessionType(session.session_type) !== 'location') {
        const err = new Error('Only location counts can be closed with close-location.');
        err.status = 400;
        err.code = 'LOCATION_CLOSE_TYPE';
        throw err;
    }
    if (isClosedStatus(session.status)) {
        return { session: getSession(session.id), already_closed: true };
    }
    const lines = sessionLineCount(session.id);
    const note = opts.note || `Closed ${lines} line(s)`;
    const exportedAt = new Date().toISOString();
    getPulseInventoryDb().prepare(`
        UPDATE count_sessions
        SET status = 'exported', exported_at = ?, export_note = ?
        WHERE id = ?
    `).run(exportedAt, note, session.id);
    return {
        session: getSession(session.id),
        line_count: lines,
        already_closed: false,
    };
}

function buildPrintHtml(sessionId, opts = {}) {
    const detail = getSessionDetail(sessionId);
    const session = detail.session;
    const lines = detail.lines || [];
    let totalCost = 0;
    let totalRetail = 0;
    let priced = 0;
    const bodyRows = lines.map((row) => {
        let desc = row.item_description || '';
        if (!desc && typeof opts.lookupItem === 'function') {
            try {
                const hit = opts.lookupItem(row.upc);
                desc = hit?.description || hit?.item || '';
            } catch (_) { /* ignore */ }
        }
        const qty = Number(row.quantity) || 0;
        const unitCost = money(row.unit_cost);
        const unitRetail = money(row.unit_retail);
        const lineCost = unitCost != null ? money(unitCost * qty) : null;
        const lineRetail = unitRetail != null ? money(unitRetail * qty) : null;
        if (lineCost != null) { totalCost += lineCost; priced += 1; }
        if (lineRetail != null) totalRetail += lineRetail;
        return `<tr>
            <td>${escHtml(row.upc)}</td>
            <td>${escHtml(desc)}</td>
            <td class="num">${escHtml(qty)}</td>
            <td>${escHtml(row.uom || '')}</td>
            <td class="num">${escHtml(formatMoneyLabel(unitCost))}</td>
            <td class="num">${escHtml(formatMoneyLabel(unitRetail))}</td>
            <td class="num">${escHtml(formatMoneyLabel(lineCost))}</td>
            <td class="num">${escHtml(formatMoneyLabel(lineRetail))}</td>
        </tr>`;
    }).join('\n');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Location Count ${escHtml(session.location)}</title>
<style>
body{font-family:Segoe UI,Arial,sans-serif;margin:24px;color:#111}
h1{font-size:1.25rem;margin:0 0 4px}
.meta{color:#444;font-size:0.9rem;margin-bottom:16px}
table{border-collapse:collapse;width:100%;font-size:0.85rem}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
th{background:#f3f3f3}
.num{text-align:right;font-variant-numeric:tabular-nums}
.totals{margin-top:12px;font-weight:600}
@media print{button{display:none}}
</style></head><body>
<button onclick="window.print()">Print</button>
<h1>Location count — ${escHtml(session.location)}</h1>
<div class="meta">
  Session ${escHtml(session.id)} · ${escHtml(session.session_type || 'location')} ·
  ${escHtml(session.status)} · ${lines.length} line(s)
</div>
<table>
<thead><tr>
  <th>UPC</th><th>Item</th><th>Qty</th><th>UOM</th>
  <th>Cost</th><th>Retail</th><th>Ext cost</th><th>Ext retail</th>
</tr></thead>
<tbody>
${bodyRows || '<tr><td colspan="8">No lines</td></tr>'}
</tbody>
</table>
<div class="totals">
  Ext cost ${formatMoneyLabel(totalCost)} · Ext retail ${formatMoneyLabel(totalRetail)}
  ${priced ? ` · ${priced} priced line(s)` : ' · no catalog prices on lines'}
</div>
</body></html>`;
}

function reopenSession(sessionId) {
    const session = requireSessionRow(sessionId, { allowExported: true });
    const db = getPulseInventoryDb();
    const run = db.transaction(() => {
        db.prepare('DELETE FROM backstock_on_hand WHERE source_session_id = ?').run(session.id);
        db.prepare(`
            UPDATE count_sessions
            SET status = 'open', exported_at = NULL, export_note = NULL
            WHERE id = ?
        `).run(session.id);
    });
    run();
    return getSession(session.id);
}

/**
 * @param {string} sessionId
 * @param {{ location?: string }} patch
 */
function updateSession(sessionId, patch) {
    const session = requireSessionRow(sessionId, { allowExported: true });
    if (patch?.location != null) {
        const location = String(patch.location).trim();
        if (!location) {
            const err = new Error('location cannot be empty.');
            err.status = 400;
            throw err;
        }
        getPulseInventoryDb().prepare(
            'UPDATE count_sessions SET location = ? WHERE id = ?',
        ).run(location, session.id);
    }
    return getSession(session.id);
}

/** @deprecated legacy export-all open lines then purge — kept for tests only via exportSession */
function exportAndPurge() {
    const open = listSessions({ status: 'open' });
    if (!open.length) {
        return { csv: 'UPC,QTY,LOCATION,SESSION_ID\n', count: 0 };
    }
    // Export first open session only for backward-compat callers.
    return exportSession(open[0].id);
}

/**
 * Finalize an order draft against committed backstock memory.
 * Looks up catalog description + vendor (V.Code) for a clean relay draft.
 * Does NOT touch the floor labor order clock — inventory DB only.
 *
 * @param {string} sessionId
 * @param {{ lookupItem?: function, include_exported_backstock?: boolean, mark_exported?: boolean, backstock_source?: string }} [opts]
 */
function finalizeOrderDraft(sessionId, opts = {}) {
    const session = requireSessionRow(sessionId, { allowExported: true });
    if (normalizeSessionType(session.session_type) !== 'order') {
        const err = new Error('Finalize is only for order draft sessions.');
        err.status = 400;
        throw err;
    }

    const db = getPulseInventoryDb();
    const orderRows = db.prepare(`
        SELECT upc, SUM(quantity) AS quantity
        FROM count_lines
        WHERE session_id = ?
        GROUP BY upc
        ORDER BY upc ASC
    `).all(session.id);

    const backstockSource = opts.include_exported_backstock
        ? 'both'
        : (opts.backstock_source || 'committed');
    const backstock = summarizeBackstock({ source: backstockSource });
    const lookup = typeof opts.lookupItem === 'function' ? opts.lookupItem : () => null;
    const stockIndex = buildBackstockMatchIndex(backstock.items || [], lookup);
    const orderMerged = mergeOrderRowsByProduct(orderRows, lookup);
    const pick_list = [];
    const clean_order = [];

    for (const row of orderMerged) {
        const upc = String(row.upc || '').trim();
        const ordered = Number(row.quantity) || 0;
        if (!upc || ordered <= 0) continue;
        const stock = stockIndex.find(upc) || { quantity: 0, by_location: [], locations: '', source_upcs: [] };
        const onHand = stock.quantity;
        const pull = Math.min(ordered, onHand);
        const stillOrder = Math.max(0, ordered - onHand);
        const hit = lookup(upc) || {};
        const description = hit.description || '';
        const catalog_code = hit.code || null;
        const vendor_code = hit.vendor_code || null;

        if (pull > 0) {
            let remaining = pull;
            const locs = [...(stock.by_location || [])]
                .filter((l) => (Number(l.quantity) || 0) > 0)
                .sort((a, b) => String(a.location).localeCompare(String(b.location)));
            if (!locs.length) {
                pick_list.push({
                    upc,
                    catalog_code,
                    vendor_code,
                    description,
                    location: 'Backstock',
                    ordered_qty: ordered,
                    backstock_qty: onHand,
                    backstock_at_location: onHand,
                    pick_qty: pull,
                    locations: stock.locations || 'Backstock',
                    matched_backstock_upcs: stock.source_upcs || [],
                });
            } else {
                for (const loc of locs) {
                    if (remaining <= 0) break;
                    const atLoc = Number(loc.quantity) || 0;
                    const take = Math.min(remaining, atLoc);
                    if (take <= 0) continue;
                    pick_list.push({
                        upc,
                        catalog_code,
                        vendor_code,
                        description,
                        location: loc.location || 'Backstock',
                        ordered_qty: ordered,
                        backstock_qty: onHand,
                        backstock_at_location: atLoc,
                        pick_qty: take,
                        locations: stock.locations || loc.location,
                        matched_backstock_upcs: stock.source_upcs || [],
                    });
                    remaining -= take;
                }
            }
        }
        if (stillOrder > 0) {
            clean_order.push({
                upc,
                catalog_code,
                vendor_code,
                description,
                ordered_qty: ordered,
                backstock_qty: onHand,
                order_qty: stillOrder,
                locations: stock.locations || '',
                matched_backstock_upcs: stock.source_upcs || [],
            });
        }
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const pickCsv = [
        'LOCATION,UPC,VENDOR_CODE,DESCRIPTION,PICK_QTY,BACKSTOCK_AT_LOCATION,ORDERED_QTY,BACKSTOCK_TOTAL,CATALOG_CODE',
        ...pick_list.map((r) => [
            csvEscape(r.location || ''),
            csvEscape(r.upc),
            csvEscape(r.vendor_code || ''),
            csvEscape(r.description),
            csvEscape(r.pick_qty),
            csvEscape(r.backstock_at_location),
            csvEscape(r.ordered_qty),
            csvEscape(r.backstock_qty),
            csvEscape(r.catalog_code || ''),
        ].join(',')),
    ].join('\n') + '\n';

    // Clean order: vendor code first for relay, UPC kept for matching.
    const cleanCsv = [
        'VENDOR_CODE,UPC,QTY,DESCRIPTION,ORDERED_QTY,BACKSTOCK_APPLIED,CATALOG_CODE',
        ...clean_order.map((r) => [
            csvEscape(r.vendor_code || ''),
            csvEscape(r.upc),
            csvEscape(r.order_qty),
            csvEscape(r.description),
            csvEscape(r.ordered_qty),
            csvEscape(r.backstock_qty),
            csvEscape(r.catalog_code || ''),
        ].join(',')),
    ].join('\n') + '\n';

    const totals = {
        order_lines: orderMerged.length,
        pick_lines: pick_list.length,
        clean_lines: clean_order.length,
        ordered_units: orderMerged.reduce((s, r) => s + (Number(r.quantity) || 0), 0),
        pick_units: pick_list.reduce((s, r) => s + r.pick_qty, 0),
        clean_units: clean_order.reduce((s, r) => s + r.order_qty, 0),
        backstock_upcs: backstock.upc_count,
        backstock_units: backstock.total_units,
        vendor_matched: clean_order.filter((r) => r.vendor_code).length,
    };
    const csv = {
        pick_list: pickCsv,
        clean_order: cleanCsv,
        pick_filename: `PickList_${stamp}.csv`,
        clean_filename: `CleanOrder_${stamp}.csv`,
    };

    const reportPayload = {
        pick_list,
        clean_order,
        backstock_source: backstockSource,
        totals,
        csv,
        saved_at: new Date().toISOString(),
    };

    const now = new Date().toISOString();
    if (opts.mark_exported !== false) {
        db.prepare(`
            UPDATE count_sessions
            SET status = 'exported', exported_at = ?, export_note = ?, report_json = ?
            WHERE id = ?
        `).run(
            now,
            `Order finalized · pick ${pick_list.length} · clean ${clean_order.length} · backstock=${backstockSource}`,
            JSON.stringify(reportPayload),
            session.id,
        );
    } else if (opts.persist_report !== false) {
        // Refresh cached report without changing open/exported status.
        db.prepare(`
            UPDATE count_sessions SET report_json = ? WHERE id = ?
        `).run(JSON.stringify(reportPayload), session.id);
    }

    return {
        session: getSession(session.id),
        ...reportPayload,
        cached: false,
    };
}

/**
 * Load saved clean-order / pick-list report for a finalized (or open) order draft.
 * Falls back to regenerating against current backstock memory when no snapshot exists.
 *
 * @param {string} sessionId
 * @param {{ lookupItem?: function, refresh?: boolean, include_exported_backstock?: boolean, backstock_source?: string }} [opts]
 */
function getOrderReport(sessionId, opts = {}) {
    const session = requireSessionRow(sessionId, { allowExported: true });
    if (normalizeSessionType(session.session_type) !== 'order') {
        const err = new Error('Order report is only for order draft sessions.');
        err.status = 400;
        throw err;
    }

    const db = getPulseInventoryDb();
    const row = db.prepare('SELECT report_json FROM count_sessions WHERE id = ?').get(session.id);
    const refresh = opts.refresh === true || opts.refresh === '1';

    if (!refresh && row?.report_json) {
        try {
            const parsed = JSON.parse(row.report_json);
            if (parsed && (Array.isArray(parsed.pick_list) || Array.isArray(parsed.clean_order))) {
                return {
                    session: getSession(session.id),
                    pick_list: parsed.pick_list || [],
                    clean_order: parsed.clean_order || [],
                    backstock_source: parsed.backstock_source || 'committed',
                    totals: parsed.totals || {},
                    csv: parsed.csv || {},
                    saved_at: parsed.saved_at || session.exported_at || null,
                    cached: true,
                };
            }
        } catch (_) { /* regenerate below */ }
    }

    return finalizeOrderDraft(session.id, {
        lookupItem: opts.lookupItem,
        include_exported_backstock: opts.include_exported_backstock,
        backstock_source: opts.backstock_source,
        mark_exported: false,
        persist_report: true,
    });
}

module.exports = {
    INVENTORY_COUNT_SETTING,
    SESSION_TYPES,
    isInventoryCountEnabled,
    normalizeSessionType,
    csvEscape,
    createSession,
    listSessions,
    listCommittedBackstock,
    listSessionBackstockByLocation,
    listBackstockByLocation,
    summarizeBackstock,
    closeBackstockSession,
    closeLocationSession,
    finalizeOrderDraft,
    getOrderReport,
    getSession,
    getSessionDetail,
    insertScan,
    listActiveScans,
    updateLine,
    deleteLine,
    exportSession,
    buildPrintHtml,
    reopenSession,
    updateSession,
    assertSessionOpen,
    exportAndPurge,
    productMatchKeys,
    preferCanonicalUpc,
    buildBackstockMatchIndex,
    mergeOrderRowsByProduct,
    sessionLineCount,
    normalizeQty,
    isClosedStatus,
};
