'use strict';

const bcrypt = require('bcryptjs');
const { isManagerRole } = require('./staff-permissions.cjs');

/**
 * Fresh manager PIN check for inventory control actions (reopen locked sessions).
 * Mirrors remediation destructive-reauth inventory path without pulling the full matrix.
 */
async function verifyActorPin(db, session, confirmPin) {
    if (!session?.name || typeof confirmPin !== 'string' || !confirmPin) return false;
    const staff = typeof db.findStaffByName === 'function'
        ? db.findStaffByName(session.name)
        : db.get(
            'SELECT name, role, pin, pin_hashed, active, app_access FROM staff WHERE name = ?',
            session.name,
        );
    if (!staff || !isManagerRole(staff.role) || !staff.pin) return false;
    if (Number(staff.active) !== 1 || Number(staff.app_access) !== 1) return false;
    if (staff.pin_hashed) return bcrypt.compare(confirmPin, staff.pin);
    return staff.pin === confirmPin;
}

async function assertInventoryControlReauth({
    db,
    session,
    data = {},
    action = 'reopen inventory session',
} = {}) {
    const reason = String(data.reason || '').trim();
    if (reason.length < 3) {
        const error = new Error(`A reason (at least 3 characters) is required to ${action}.`);
        error.status = 400;
        error.code = 'DESTRUCTIVE_REASON_REQUIRED';
        throw error;
    }
    const pinOk = await verifyActorPin(db, session, data.confirm_pin);
    if (!pinOk) {
        const error = new Error(`Fresh manager PIN confirmation is required to ${action}.`);
        error.status = 403;
        error.code = 'DESTRUCTIVE_REAUTH_REQUIRED';
        throw error;
    }
}

module.exports = {
    verifyActorPin,
    assertInventoryControlReauth,
};
