'use strict';

const {
    buildRhythmAssignContext,
    canonicalStaffName,
    isScheduledShiftLeadCandidate,
} = require('./rhythm-schedule-assign.cjs');
const { listActiveStaffForLead } = require('./staff-permissions.cjs');
const { isStaffAliasIgnoredForSchedule, resolveStaffAlias } = require('./staff-name-aliases.cjs');

function normKeyLocal(s) {
    return String(s || '').trim().toLowerCase();
}

/** @param {{ role?: string, active?: number, shift_lead_eligible?: number|null }} staff */
function isShiftLeadEligibleStaff(staff) {
    if (!staff || staff.active === 0) return false;
    const role = String(staff.role || '').trim();
    if (role === 'Store Manager') return false;
    if (staff.shift_lead_eligible === 0) return false;
    return role === 'Premium Clerk' || role === 'Manager';
}

/**
 * @param {object} db
 * @param {string} name
 * @param {string} [storeDate]
 */
function canBeActiveShiftLead(db, name, storeDate) {
    const trimmed = String(name || '').trim();
    if (!trimmed) return false;

    if (!storeDate) {
        let staff;
        try {
            staff = db.get('SELECT name, role, active, shift_lead_eligible FROM staff WHERE name = ?', trimmed);
        } catch (_) {
            staff = null;
        }
        return !!(staff && isShiftLeadEligibleStaff(staff));
    }

    const ctx = buildRhythmAssignContext(db, storeDate);
    const canonical = canonicalStaffName(ctx.directory, trimmed) || trimmed;
    return listShiftLeadOptions(db, storeDate).some((n) => normKeyLocal(n) === normKeyLocal(canonical));
}

/**
 * Shift-lead dropdown options.
 * When a schedule exists: scheduled premium/manager candidates, plus all other
 * shift-lead-eligible staff (so a logged-in manager/premium can select themselves
 * even if the import omitted them or tagged the wrong role).
 * When no schedule: all eligible premiums/managers.
 * @param {object} db
 * @param {string} storeDate
 * @param {{ ensureNames?: string[] }} [opts]
 */
function listShiftLeadOptions(db, storeDate, opts = {}) {
    const ctx = buildRhythmAssignContext(db, storeDate);
    const shifts = db.all(
        'SELECT staff_name, department, role FROM staff_shifts WHERE shift_date = ?',
        storeDate,
    ) || [];

    const names = new Set();
    const options = [];

    function pushName(raw) {
        const name = String(raw || '').trim();
        if (!name || name === 'Unassigned' || names.has(name)) return;
        names.add(name);
        options.push(name);
    }

    if (shifts.length) {
        shifts.forEach((shift) => {
            const alias = resolveStaffAlias(ctx.directory, shift.staff_name);
            if (isStaffAliasIgnoredForSchedule(alias)) return;
            const name = canonicalStaffName(ctx.directory, shift.staff_name);
            if (!name) return;
            if (!isScheduledShiftLeadCandidate(ctx, name)) return;
            pushName(name);
        });
    }

    // Always include eligible premiums/managers (covers self-select + no-schedule days).
    listActiveStaffForLead(db).forEach((s) => {
        if (!isShiftLeadEligibleStaff(s)) return;
        pushName(s.name);
    });

    const ensure = Array.isArray(opts.ensureNames) ? opts.ensureNames : [];
    ensure.forEach((raw) => {
        const trimmed = String(raw || '').trim();
        if (!trimmed) return;
        let staff;
        try {
            staff = db.get('SELECT name, role, active, shift_lead_eligible FROM staff WHERE name = ?', trimmed);
        } catch (_) {
            staff = null;
        }
        if (staff && isShiftLeadEligibleStaff(staff)) pushName(staff.name || trimmed);
    });

    return options.sort((a, b) => a.localeCompare(b));
}

/**
 * Read Active_Manager without mutating. Sync should use this so viewing the hub
 * cannot silently clear the shift lead.
 * @returns {{ value: string, eligible: boolean, stale: boolean }}
 */
function getActiveManagerStatus(db, storeDate) {
    let current = '';
    try {
        const row = db.get("SELECT setting_value FROM settings WHERE setting_name='Active_Manager'");
        current = String(row?.setting_value || '').trim();
    } catch (_) {
        return { value: '', eligible: true, stale: false };
    }
    if (!current) return { value: '', eligible: true, stale: false };
    const eligible = canBeActiveShiftLead(db, current, storeDate);
    return { value: current, eligible, stale: !eligible };
}

/**
 * Optionally clear Active_Manager when the stored name is not a valid shift-lead candidate today.
 * Default is read-only (no clear) — pass { clear: true } for explicit cleanup paths.
 * @returns {string} current value after reconcile (may be cleared only when opts.clear)
 */
function reconcileActiveManager(db, storeDate, opts = {}) {
    const status = getActiveManagerStatus(db, storeDate);
    if (!status.value || status.eligible) return status.value;
    if (opts.clear !== true) return status.value;
    try {
        db.run("UPDATE settings SET setting_value='' WHERE setting_name='Active_Manager'");
    } catch (_) { /* ignore */ }
    return '';
}

module.exports = {
    isShiftLeadEligibleStaff,
    canBeActiveShiftLead,
    listShiftLeadOptions,
    getActiveManagerStatus,
    reconcileActiveManager,
    STORE_MANAGER_ROLE: 'Store Manager',
};
