'use strict';

const DEFAULT_SAFETY_BLURBS = [
    'Safe cutting: cut away from your body, keep fingers clear, and close the blade when you are done.',
    'Use a ladder or step stool for high product — never climb shelves, carts, or pallets.',
    'Spills: block the area first, place wet-floor signs, then clean and dry the floor.',
    'Keep fire exits, electrical panels, and emergency equipment clear at all times.',
    'Broken glass: stop, protect the area, use tools and gloves, and dispose of glass safely.',
    'Lift safely: bend your knees, keep the load close, and ask for help with heavy or awkward items.',
    'Keep box cutters closed or capped when not actively cutting.',
    'Watch for trip hazards: flattened boxes, straps, wrap, and loose product on the floor.',
    'Use gloves when handling damaged, leaking, sharp, or questionable product.',
    'Do not block aisles, exits, or customer paths with carts, pallets, or U-boats.',
    'Move carts and pallet jacks slowly around corners and through customer areas.',
    'Report damaged equipment before using it — do not work around unsafe equipment.',
    'Use proper signage and cones when working around wet floors or active cleanups.',
    'Keep cooler and freezer floors clear of ice, plastic, cardboard, and product debris.',
    'Two-person lift for heavy, oversized, or unstable loads.',
    'When using ladders, face the ladder, keep three points of contact, and do not overreach.',
    'Secure loads before moving them — unstable stacks can fall, shift, or block vision.',
    'Chemical safety: read the label, use the right PPE, and never mix cleaning chemicals.',
    'Receiving safety: keep dock doors, ramps, and pallet paths clear before moving freight.',
    'If you see a hazard, make it safe first, then report it.'
];

function nowIso() {
    return new Date().toISOString();
}

function boolish(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (value === true || value === 1) return true;
    const s = String(value).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function safeJsonParse(value, fallback) {
    try {
        if (!value) return fallback;
        return JSON.parse(value);
    } catch (_) {
        return fallback;
    }
}

function sanitizeMessage(message) {
    return String(message || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 220);
}

function ensureSafetySchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS safety_blurbs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message TEXT NOT NULL UNIQUE,
            active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            last_used_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS daily_safety_focus (
            store_date TEXT PRIMARY KEY,
            blurb_id INTEGER,
            message TEXT NOT NULL,
            selected_at TEXT NOT NULL,
            selected_by TEXT,
            source TEXT NOT NULL DEFAULT 'auto'
        );
        CREATE INDEX IF NOT EXISTS idx_safety_blurbs_active_used
            ON safety_blurbs(active, last_used_date, sort_order, id);
        CREATE INDEX IF NOT EXISTS idx_daily_safety_focus_date
            ON daily_safety_focus(store_date DESC);
    `);
}

function seedDefaultSafetyBlurbs(db, { overwriteInactive = false } = {}) {
    ensureSafetySchema(db);
    DEFAULT_SAFETY_BLURBS.forEach((message, idx) => {
        const msg = sanitizeMessage(message);
        if (!msg) return;
        db.run(`
            INSERT OR IGNORE INTO safety_blurbs
                (message, active, sort_order, created_at, updated_at)
            VALUES (?, 1, ?, ?, ?)
        `, msg, idx + 1, nowIso(), nowIso());
        if (overwriteInactive) {
            db.run('UPDATE safety_blurbs SET active=1 WHERE message=?', msg);
        }
    });
}

function listSafetyBlurbs(db) {
    ensureSafetySchema(db);
    return db.all(`
        SELECT id, message, active, sort_order, last_used_date, created_at, updated_at
        FROM safety_blurbs
        ORDER BY active DESC, sort_order ASC, id ASC
    `);
}

function loadDailySafetyFocus(db, storeDate) {
    ensureSafetySchema(db);
    if (!storeDate) return null;
    const row = db.get(`
        SELECT store_date, blurb_id, message, selected_at, selected_by, source
        FROM daily_safety_focus
        WHERE store_date=?
    `, storeDate);
    return row || null;
}

function pickNextSafetyBlurb(db) {
    ensureSafetySchema(db);
    return db.get(`
        SELECT id, message, active, sort_order, last_used_date
        FROM safety_blurbs
        WHERE active=1
        ORDER BY
            CASE WHEN last_used_date IS NULL OR last_used_date='' THEN 0 ELSE 1 END,
            date(last_used_date) ASC,
            sort_order ASC,
            id ASC
        LIMIT 1
    `);
}

function ensureDailySafetyFocus(db, storeDate, { selectedBy = 'AUTO', force = false, blurbId = null } = {}) {
    ensureSafetySchema(db);
    seedDefaultSafetyBlurbs(db);
    if (!storeDate) throw new Error('storeDate is required.');

    const existing = loadDailySafetyFocus(db, storeDate);
    if (existing && !force) return existing;

    let chosen = null;
    if (blurbId != null) {
        chosen = db.get('SELECT id, message FROM safety_blurbs WHERE id=?', blurbId);
        if (!chosen) throw new Error('Safety blurb not found.');
    } else {
        chosen = pickNextSafetyBlurb(db);
    }

    if (!chosen) {
        const fallback = 'If you see a hazard, make it safe first, then report it.';
        db.run(`
            INSERT OR IGNORE INTO safety_blurbs (message, active, sort_order, created_at, updated_at)
            VALUES (?, 1, 999, ?, ?)
        `, fallback, nowIso(), nowIso());
        chosen = db.get('SELECT id, message FROM safety_blurbs WHERE message=?', fallback);
    }

    const ts = nowIso();
    const source = blurbId != null || selectedBy !== 'AUTO' ? 'manual' : 'auto';
    db.run(`
        INSERT INTO daily_safety_focus
            (store_date, blurb_id, message, selected_at, selected_by, source)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(store_date) DO UPDATE SET
            blurb_id=excluded.blurb_id,
            message=excluded.message,
            selected_at=excluded.selected_at,
            selected_by=excluded.selected_by,
            source=excluded.source
    `, storeDate, chosen.id, chosen.message, ts, selectedBy, source);
    db.run('UPDATE safety_blurbs SET last_used_date=?, updated_at=? WHERE id=?', storeDate, ts, chosen.id);

    return loadDailySafetyFocus(db, storeDate);
}

function addSafetyBlurb(db, message, { sortOrder = 0, active = true } = {}) {
    ensureSafetySchema(db);
    const msg = sanitizeMessage(message);
    if (!msg) throw new Error('Safety blurb message is required.');
    const ts = nowIso();
    const info = db.run(`
        INSERT OR IGNORE INTO safety_blurbs
            (message, active, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
    `, msg, boolish(active, true) ? 1 : 0, Number(sortOrder || 0), ts, ts);
    if (!info.changes) {
        db.run('UPDATE safety_blurbs SET active=?, updated_at=? WHERE message=?', boolish(active, true) ? 1 : 0, ts, msg);
    }
    return db.get('SELECT * FROM safety_blurbs WHERE message=?', msg);
}

function importSafetyBlurbs(db, text, { active = true } = {}) {
    const lines = String(text || '')
        .split(/\r?\n/)
        .map(sanitizeMessage)
        .filter(Boolean);
    const seen = new Set();
    const added = [];
    lines.forEach((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        added.push(addSafetyBlurb(db, line, { active }));
    });
    return added.filter(Boolean);
}

function updateSafetyBlurb(db, id, patch = {}) {
    ensureSafetySchema(db);
    const row = db.get('SELECT * FROM safety_blurbs WHERE id=?', id);
    if (!row) throw new Error('Safety blurb not found.');
    const message = patch.message !== undefined ? sanitizeMessage(patch.message) : row.message;
    if (!message) throw new Error('Safety blurb message is required.');
    const active = patch.active !== undefined ? (boolish(patch.active) ? 1 : 0) : Number(row.active || 0);
    const sortOrder = patch.sort_order !== undefined ? Number(patch.sort_order || 0) : Number(row.sort_order || 0);
    db.run(`
        UPDATE safety_blurbs
        SET message=?, active=?, sort_order=?, updated_at=?
        WHERE id=?
    `, message, active, sortOrder, nowIso(), id);
    return db.get('SELECT * FROM safety_blurbs WHERE id=?', id);
}

function clearDailySafetyFocus(db, storeDate, { selectedBy = 'Manager' } = {}) {
    ensureSafetySchema(db);
    const existing = loadDailySafetyFocus(db, storeDate);
    if (!existing) return { cleared: false };
    db.run('DELETE FROM daily_safety_focus WHERE store_date=?', storeDate);
    return { cleared: true, previous: existing, selectedBy };
}

function buildSafetySyncPayload(db, storeDate, { includeLibrary = false } = {}) {
    ensureSafetySchema(db);
    const focus = ensureDailySafetyFocus(db, storeDate);
    const payload = {
        focus,
        has_focus: Boolean(focus?.message),
    };
    if (includeLibrary) {
        payload.blurbs = listSafetyBlurbs(db);
        payload.active_count = payload.blurbs.filter((b) => Number(b.active) === 1).length;
    }
    return payload;
}

module.exports = {
    DEFAULT_SAFETY_BLURBS,
    ensureSafetySchema,
    seedDefaultSafetyBlurbs,
    listSafetyBlurbs,
    loadDailySafetyFocus,
    ensureDailySafetyFocus,
    addSafetyBlurb,
    importSafetyBlurbs,
    updateSafetyBlurb,
    clearDailySafetyFocus,
    buildSafetySyncPayload,
    sanitizeMessage,
};
