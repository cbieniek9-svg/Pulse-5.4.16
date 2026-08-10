'use strict';

const bcrypt = require('bcryptjs');
const { isManagerRole } = require('./staff-permissions.cjs');

const MAX_PIN_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const MAX_PIN_ATTEMPT_ENTRIES = 500;
/** @type {Map<string, { failures: number, lockedUntil: number }>} */
const pinAttempts = new Map();

function actorThrottleKey(session) {
    const actor = String(session?.name || '').trim().toLowerCase();
    const sid = String(session?.token || session?.id || session?.session_token || '').trim();
    return `${sid || 'anon'}:${actor || 'unknown'}`;
}

function getThrottleState(key) {
    return pinAttempts.get(key) || { failures: 0, lockedUntil: 0 };
}

/** Drop soft-lock entries whose backoff has expired. Hard locks (max attempts) are retained. */
function pruneExpiredPinAttempts(now = Date.now()) {
    for (const [k, state] of pinAttempts) {
        if (state.failures >= MAX_PIN_ATTEMPTS) continue;
        if (state.lockedUntil <= now) pinAttempts.delete(k);
    }
}

/** Ensure room for a new key before recording failure state. */
function enforcePinAttemptBound() {
    if (pinAttempts.size < MAX_PIN_ATTEMPT_ENTRIES) return;
    pruneExpiredPinAttempts();
    if (pinAttempts.size < MAX_PIN_ATTEMPT_ENTRIES) return;
    for (const [k, state] of pinAttempts) {
        if (pinAttempts.size < MAX_PIN_ATTEMPT_ENTRIES) return;
        if (state.failures < MAX_PIN_ATTEMPTS) pinAttempts.delete(k);
    }
    while (pinAttempts.size >= MAX_PIN_ATTEMPT_ENTRIES) {
        const oldest = pinAttempts.keys().next().value;
        if (oldest == null) break;
        pinAttempts.delete(oldest);
    }
}

function recordPinFailure(key) {
    pruneExpiredPinAttempts();
    const isNew = !pinAttempts.has(key);
    if (isNew) enforcePinAttemptBound();
    const state = getThrottleState(key);
    state.failures += 1;
    if (state.failures >= MAX_PIN_ATTEMPTS) {
        state.lockedUntil = Date.now() + MAX_BACKOFF_MS;
    } else {
        const exp = Math.min(state.failures - 1, 5);
        state.lockedUntil = Date.now() + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * (2 ** exp));
    }
    pinAttempts.set(key, state);
    return state;
}

function clearPinFailures(key) {
    pinAttempts.delete(key);
}

/**
 * Fresh manager PIN check for inventory control actions (reopen locked sessions).
 * Mirrors remediation destructive-reauth inventory path without pulling the full matrix.
 * Per-session/actor attempt tracking with exponential backoff after failures.
 */
async function verifyActorPin(db, session, confirmPin) {
    if (!session?.name || typeof confirmPin !== 'string' || !confirmPin) return false;

    const key = actorThrottleKey(session);
    const throttle = getThrottleState(key);
    if (throttle.lockedUntil > Date.now()) {
        return false;
    }

    const staff = typeof db.findStaffByName === 'function'
        ? db.findStaffByName(session.name)
        : db.get(
            'SELECT name, role, pin, pin_hashed, active, app_access FROM staff WHERE name = ?',
            session.name,
        );
    if (!staff || !isManagerRole(staff.role) || !staff.pin) {
        recordPinFailure(key);
        return false;
    }
    if (Number(staff.active) !== 1 || Number(staff.app_access) !== 1) {
        recordPinFailure(key);
        return false;
    }
    const pinOk = staff.pin_hashed
        ? await bcrypt.compare(confirmPin, staff.pin)
        : staff.pin === confirmPin;
    if (!pinOk) {
        recordPinFailure(key);
        return false;
    }
    clearPinFailures(key);
    return true;
}

async function assertInventoryControlReauth({
    db,
    session,
    data = {},
    action = 'reopen inventory session',
} = {}) {
    if (typeof data.reason !== 'string') {
        const error = new Error(`A reason (at least 3 characters) is required to ${action}.`);
        error.status = 400;
        error.code = 'DESTRUCTIVE_REASON_REQUIRED';
        throw error;
    }
    const reason = data.reason.trim();
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
