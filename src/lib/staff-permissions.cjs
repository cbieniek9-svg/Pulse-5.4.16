'use strict';

const bcrypt = require('bcryptjs');

const CLERK_PERMISSIONS = Object.freeze([
    { key: 'tasks', label: 'Complete board tasks' },
    { key: 'receiving', label: 'Receiving dock' },
    { key: 'markdown', label: 'Markdown / expiry portal' },
    { key: 'comms', label: 'Message center post' },
    { key: 'safe', label: 'Safety inspections (/safe)' },
    { key: 'inventory', label: 'Inventory count (/count)' },
]);

const MANAGER_ROLES = new Set(['Manager', 'Store Manager']);
const SHIFT_LEAD_ROLES = new Set(['Manager', 'Premium Clerk']);

function normalizeRole(role) {
    return String(role || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parsePermissions(raw) {
    return String(raw || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

function isManagerRole(role) {
    const normalized = normalizeRole(role);
    return normalized === 'manager' || normalized === 'store manager';
}

function isShiftLeadRole(role) {
    return SHIFT_LEAD_ROLES.has(String(role || '').trim());
}

function getStaffRow(db, session) {
    if (!session?.name) return null;
    return db.findStaffByName ? db.findStaffByName(session.name) : null;
}

function hasStaffPermission(db, session, perm) {
    if (!session) return false;
    if (isManagerRole(session.role)) return true;
    if (perm === 'tasks' && isShiftLeadRole(session.role)) return true;
    const row = getStaffRow(db, session);
    return parsePermissions(row?.permissions).includes(perm);
}

function canAccessSafeInspections(db, session) {
    return hasStaffPermission(db, session, 'safe');
}

function canAccessInventoryCount(db, session) {
    return hasStaffPermission(db, session, 'inventory');
}

function defaultPermissionsForRole(role, appAccess) {
    if (!appAccess) return '';
    const r = String(role || 'Clerk').trim();
    if (r === 'Clerk') return 'tasks';
    if (r === 'Premium Clerk') return 'tasks,receiving';
    return '';
}

function staffHasColumn(db, column) {
    try {
        return (db.all('PRAGMA table_info(staff)') || []).some((c) => c.name === column);
    } catch (_) {
        return false;
    }
}

/** Staff rows for /api/sync — safe on DBs before migration 012. */
function listStaffForSync(db) {
    const baseCols = ['id', 'name', 'active', 'app_access', 'role', 'permissions'];
    const cols = staffHasColumn(db, 'shift_lead_eligible')
        ? [...baseCols, 'shift_lead_eligible']
        : baseCols;
    const rows = db.all(`SELECT ${cols.join(', ')} FROM staff ORDER BY name`) || [];
    if (staffHasColumn(db, 'shift_lead_eligible')) return rows;
    return rows.map((s) => ({ ...s, shift_lead_eligible: 1 }));
}

/** Active staff for shift-lead eligibility — omits shift_lead_eligible when column missing. */
function listActiveStaffForLead(db) {
    if (staffHasColumn(db, 'shift_lead_eligible')) {
        return db.all('SELECT name, role, active, shift_lead_eligible FROM staff WHERE active = 1 ORDER BY name') || [];
    }
    return (db.all('SELECT name, role, active FROM staff WHERE active = 1 ORDER BY name') || [])
        .map((s) => ({ ...s, shift_lead_eligible: 1 }));
}

function insertStaffRow(db, data) {
    const role = String(data.role || 'Clerk').trim();
    let pin = String(data.pin || '1234');
    let pinHashed = data.pin_hashed != null ? data.pin_hashed : 0;
    if (pin && !pinHashed && !/^\$2[aby]\$\d\d\$/.test(pin)) {
        pin = bcrypt.hashSync(pin, 10);
        pinHashed = 1;
    }
    const row = {
        name: String(data.name || '').trim(),
        active: data.active != null ? data.active : 1,
        pin,
        app_access: data.app_access != null ? data.app_access : 0,
        role,
        permissions: data.permissions != null ? String(data.permissions) : defaultPermissionsForRole(role, data.app_access),
        pin_hashed: pinHashed,
    };
    if (!row.name) {
        const err = new Error('Staff name is required.');
        err.status = 400;
        throw err;
    }
    if (staffHasColumn(db, 'shift_lead_eligible')) {
        row.shift_lead_eligible = role === 'Store Manager' ? 0 : 1;
    }
    const cols = Object.keys(row);
    const phs = cols.map(() => '?').join(', ');
    db.run(`INSERT INTO staff (${cols.join(', ')}) VALUES (${phs})`, ...cols.map((k) => row[k]));
    return row;
}

module.exports = {
    CLERK_PERMISSIONS,
    MANAGER_ROLES,
    parsePermissions,
    isManagerRole,
    isShiftLeadRole,
    hasStaffPermission,
    canAccessSafeInspections,
    canAccessInventoryCount,
    defaultPermissionsForRole,
    staffHasColumn,
    listStaffForSync,
    listActiveStaffForLead,
    insertStaffRow,
};
