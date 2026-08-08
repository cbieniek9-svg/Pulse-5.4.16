'use strict';

const DEFAULT_STAFF_NAME_ALIASES = [
    {
        source_name: 'Isabella',
        target_name: 'Izzy',
        alias_type: 'alias',
        notes: 'Confirmed schedule name alias.',
    },
    {
        source_name: 'Abigail',
        target_name: 'Abby',
        alias_type: 'alias',
        notes: 'Confirmed schedule name alias.',
    },
    {
        source_name: 'Jessica',
        target_name: 'Jess',
        alias_type: 'alias',
        notes: 'Confirmed schedule name alias.',
    },
    {
        source_name: 'Lenora',
        target_name: 'Nora',
        alias_type: 'alias',
        notes: 'Confirmed schedule name alias.',
    },
    {
        source_name: 'Jennifer O',
        target_name: '',
        alias_type: 'inactive',
        notes: 'No longer at the store; do not map to Jenn.',
    },
    {
        source_name: 'Shanelle',
        target_name: '',
        alias_type: 'inactive',
        notes: 'No longer at the store.',
    },
    {
        source_name: 'Shannon',
        target_name: '',
        alias_type: 'file_maintenance',
        notes: 'File Maintenance role; may use /rec print workflow but should not receive floor rhythm tasks.',
    },
    {
        source_name: 'Connor',
        target_name: '',
        alias_type: 'pending_staff',
        notes: 'Known schedule name; add app staff later when needed.',
    },
    {
        source_name: 'Dawn',
        target_name: '',
        alias_type: 'pending_staff',
        notes: 'Known schedule name; add app staff later when needed.',
    },
];

function normalizeStaffKey(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function nowIso() {
    return new Date().toISOString();
}

function ensureStaffNameAliasTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS staff_name_aliases (
            source_name TEXT PRIMARY KEY,
            source_key TEXT NOT NULL UNIQUE,
            target_name TEXT DEFAULT '',
            alias_type TEXT NOT NULL DEFAULT 'alias',
            active INTEGER NOT NULL DEFAULT 1,
            notes TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_staff_name_aliases_type_active
            ON staff_name_aliases(alias_type, active);
    `);
}

function seedStaffNameAliases(db, rows = DEFAULT_STAFF_NAME_ALIASES) {
    const ts = nowIso();
    rows.forEach((row) => {
        const sourceName = String(row.source_name || '').trim();
        if (!sourceName) return;
        const targetName = String(row.target_name || '').trim();
        const aliasType = String(row.alias_type || 'alias').trim() || 'alias';
        const notes = String(row.notes || '').trim();
        const sourceKey = normalizeStaffKey(sourceName);
        db.run(
            `INSERT INTO staff_name_aliases (
                source_name, source_key, target_name, alias_type, active, notes, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
            ON CONFLICT(source_name) DO UPDATE SET
                source_key = excluded.source_key,
                target_name = excluded.target_name,
                alias_type = excluded.alias_type,
                active = 1,
                notes = excluded.notes,
                updated_at = excluded.updated_at`,
            sourceName, sourceKey, targetName, aliasType, notes, ts, ts,
        );
    });
}

function loadStaffNameAliases(db) {
    try {
        ensureStaffNameAliasTable(db);
        return db.all('SELECT * FROM staff_name_aliases WHERE active = 1 ORDER BY source_name') || [];
    } catch (_) {
        return [];
    }
}

function aliasesByKey(rows = []) {
    const map = new Map();
    rows.forEach((row) => {
        const key = row.source_key || normalizeStaffKey(row.source_name);
        if (!key) return;
        map.set(key, {
            source_name: String(row.source_name || '').trim(),
            source_key: key,
            target_name: String(row.target_name || '').trim(),
            alias_type: String(row.alias_type || 'alias').trim() || 'alias',
            active: row.active !== 0,
            notes: String(row.notes || '').trim(),
        });
    });
    return map;
}

function attachStaffNameAliases(directory, aliases) {
    const out = Array.isArray(directory) ? directory : [];
    Object.defineProperty(out, '_staffNameAliases', {
        value: aliasesByKey(aliases || []),
        enumerable: false,
        configurable: true,
    });
    return out;
}

function getAliasMap(source) {
    if (!source) return new Map();
    if (source instanceof Map) return source;
    if (Array.isArray(source) && source._staffNameAliases instanceof Map) return source._staffNameAliases;
    if (Array.isArray(source)) return aliasesByKey(source);
    if (source._staffNameAliases instanceof Map) return source._staffNameAliases;
    return new Map();
}

function resolveStaffAlias(source, rawName) {
    const key = normalizeStaffKey(rawName);
    if (!key) return null;
    const map = getAliasMap(source);
    return map.get(key) || null;
}

function isStaffAliasIgnoredForSchedule(alias) {
    if (!alias || alias.active === false) return false;
    return ['inactive', 'file_maintenance', 'pending_staff', 'schedule_only'].includes(String(alias.alias_type || '').trim());
}

/**
 * Alias types whose schedule rows are dropped at import instead of stored and filtered later.
 * File maintenance (Shannon) and departed staff never work the floor, so their rows would only
 * inflate roster complement and labor scheduled hours. Pending staff DO work shifts — keep them.
 */
const IMPORT_EXCLUDED_ALIAS_TYPES = ['file_maintenance', 'inactive'];

function isStaffAliasExcludedFromImport(alias) {
    if (!alias || alias.active === false) return false;
    return IMPORT_EXCLUDED_ALIAS_TYPES.includes(String(alias.alias_type || '').trim());
}

function normalizeScheduleStaffName(db, rawName) {
    const raw = String(rawName || '').trim();
    if (!raw) return '';
    const alias = resolveStaffAlias(loadStaffNameAliases(db), raw);
    if (alias?.alias_type === 'alias' && alias.target_name) return alias.target_name;
    return raw;
}

const VALID_ALIAS_TYPES = ['alias', 'inactive', 'file_maintenance', 'pending_staff', 'schedule_only'];

const ALIAS_TYPE_LABELS = {
    alias: 'Alias → app staff',
    inactive: 'Inactive / left store',
    file_maintenance: 'File maintenance (no rhythm)',
    pending_staff: 'Pending staff (no rhythm)',
    schedule_only: 'Schedule only (no rhythm)',
};

function aliasTypeLabel(type) {
    return ALIAS_TYPE_LABELS[String(type || '').trim()] || String(type || 'alias');
}

function validateStaffNameAliasInput({ source_name, target_name, alias_type }) {
    const sourceName = String(source_name || '').trim();
    const targetName = String(target_name || '').trim();
    const type = String(alias_type || 'alias').trim() || 'alias';
    if (!sourceName) {
        throw Object.assign(new Error('Schedule name is required.'), { status: 400 });
    }
    if (!VALID_ALIAS_TYPES.includes(type)) {
        throw Object.assign(new Error(`Invalid alias type: ${type}`), { status: 400 });
    }
    if (type === 'alias' && !targetName) {
        throw Object.assign(new Error('App staff name is required for alias type.'), { status: 400 });
    }
    return { sourceName, targetName, type };
}

function upsertStaffNameAlias(db, input, actorName = 'Manager') {
    ensureStaffNameAliasTable(db);
    const { sourceName, targetName, type } = validateStaffNameAliasInput(input);
    const notes = String(input.notes || '').trim().slice(0, 240);
    const ts = nowIso();
    const existing = db.get('SELECT created_at FROM staff_name_aliases WHERE source_name = ?', sourceName);
    const createdAt = existing?.created_at || ts;
    db.run(
        `INSERT INTO staff_name_aliases (
            source_name, source_key, target_name, alias_type, active, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(source_name) DO UPDATE SET
            source_key = excluded.source_key,
            target_name = excluded.target_name,
            alias_type = excluded.alias_type,
            active = 1,
            notes = excluded.notes,
            updated_at = excluded.updated_at`,
        sourceName,
        normalizeStaffKey(sourceName),
        targetName,
        type,
        notes,
        createdAt,
        ts,
    );
    return {
        source_name: sourceName,
        target_name: targetName,
        alias_type: type,
        notes,
        updated_at: ts,
        updated_by: actorName,
    };
}

function deactivateStaffNameAlias(db, sourceName, actorName = 'Manager') {
    ensureStaffNameAliasTable(db);
    const name = String(sourceName || '').trim();
    if (!name) {
        throw Object.assign(new Error('Schedule name is required.'), { status: 400 });
    }
    const ts = nowIso();
    const result = db.run(
        `UPDATE staff_name_aliases SET active = 0, updated_at = ? WHERE source_name = ? AND active = 1`,
        ts,
        name,
    );
    if (!result?.changes) {
        throw Object.assign(new Error('Alias not found.'), { status: 404 });
    }
    return { source_name: name, deactivated_at: ts, updated_by: actorName };
}

module.exports = {
    DEFAULT_STAFF_NAME_ALIASES,
    VALID_ALIAS_TYPES,
    ALIAS_TYPE_LABELS,
    aliasTypeLabel,
    normalizeStaffKey,
    ensureStaffNameAliasTable,
    seedStaffNameAliases,
    loadStaffNameAliases,
    attachStaffNameAliases,
    resolveStaffAlias,
    isStaffAliasIgnoredForSchedule,
    IMPORT_EXCLUDED_ALIAS_TYPES,
    isStaffAliasExcludedFromImport,
    normalizeScheduleStaffName,
    validateStaffNameAliasInput,
    upsertStaffNameAlias,
    deactivateStaffNameAlias,
};
