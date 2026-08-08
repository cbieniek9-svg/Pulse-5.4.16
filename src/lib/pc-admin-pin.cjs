'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { getDataRoot } = require('../paths.cjs');

const PIN_FILE_NAME = 'pc-admin-pin.txt';
const LEGACY_DEFAULT_PIN = '1234';
const MAX_PIN_FILE_BYTES = 32;
const ACTIVE_MANAGER_EXISTS_SQL = `
    SELECT 1 AS ok FROM staff
     WHERE active = 1 AND role IN ('Manager', 'Store Manager')
     LIMIT 1
`;

function getPcAdminPinPath(dataRoot = getDataRoot()) {
    return path.join(dataRoot, PIN_FILE_NAME);
}

function generatePin(digits = 8) {
    const max = 10 ** digits;
    const n = crypto.randomInt(0, max);
    return String(n).padStart(digits, '0');
}

function getActiveManagerState(db) {
    if (!db || typeof db.get !== 'function') {
        return { ok: false, exists: true, error: new Error('Manager database unavailable') };
    }
    try {
        return { ok: true, exists: !!db.get(ACTIVE_MANAGER_EXISTS_SQL) };
    } catch (error) {
        return { ok: false, exists: true, error };
    }
}

function hasActiveManager(db) {
    const state = getActiveManagerState(db);
    return !state.ok || state.exists;
}

function readPinFile(pinPath, io = fs) {
    let stat;
    try {
        stat = io.lstatSync(pinPath);
    } catch (error) {
        if (error?.code === 'ENOENT') return { status: 'absent' };
        return { status: 'invalid', source: 'file_error' };
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PIN_FILE_BYTES) {
        return { status: 'invalid', source: 'file_invalid' };
    }
    try {
        const pin = String(io.readFileSync(pinPath, 'utf8') || '').trim();
        if (!/^\d{8}$/.test(pin)) return { status: 'invalid', source: 'file_invalid' };
        return { status: 'valid', pin };
    } catch (_) {
        return { status: 'invalid', source: 'file_error' };
    }
}

/**
 * Resolve the bootstrap PC_ADMIN PIN.
 *
 * Priority:
 * 1. Any active manager role → bootstrap disabled
 * 2. PC_ADMIN_PIN env
 * 3. Existing pc-admin-pin.txt beside data root
 * 4. No manager and no configured PIN → mint a secure file
 *
 * @param {{ db?: object, dataRoot?: string, env?: NodeJS.ProcessEnv }} opts
 */
function resolvePcAdminPin(opts = {}) {
    const env = opts.env || process.env;
    const dataRoot = opts.dataRoot || getDataRoot();
    const pinPath = getPcAdminPinPath(dataRoot);
    const io = opts.fs || fs;
    const managerState = getActiveManagerState(opts.db);

    if (!managerState.ok) {
        return {
            pin: null,
            source: 'manager_check_failed',
            insecureDefault: false,
            pinPath,
            disabled: true,
        };
    }
    if (managerState.exists) {
        return {
            pin: null,
            source: 'disabled',
            insecureDefault: false,
            pinPath,
            disabled: true,
        };
    }

    if (env.PC_ADMIN_PIN != null && String(env.PC_ADMIN_PIN).length > 0) {
        const pin = String(env.PC_ADMIN_PIN);
        const secure = /^\d{8}$/.test(pin) && pin !== LEGACY_DEFAULT_PIN;
        return {
            pin,
            source: 'env',
            insecureDefault: !secure,
            pinPath,
        };
    }

    const existing = readPinFile(pinPath, io);
    if (existing.status === 'valid') {
        return { pin: existing.pin, source: 'file', insecureDefault: false, pinPath };
    }
    if (existing.status !== 'absent') {
        return { pin: null, source: existing.source, insecureDefault: false, pinPath, disabled: true };
    }

    const pin = generatePin(8);
    try {
        io.mkdirSync(dataRoot, { recursive: true });
        io.writeFileSync(pinPath, `${pin}\n`, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        });
        console.warn(`[SECURITY] PC_ADMIN PIN written to ${pinPath}. Store this file securely. Set PC_ADMIN_PIN to override.`);
        return {
            pin,
            source: 'generated',
            insecureDefault: false,
            pinPath,
            generated: true,
        };
    } catch (e) {
        if (e && e.code === 'EEXIST') {
            const winner = readPinFile(pinPath, io);
            if (winner.status === 'valid') {
                return { pin: winner.pin, source: 'file', insecureDefault: false, pinPath };
            }
            return {
                pin: null,
                source: winner.source || 'file_invalid',
                insecureDefault: false,
                pinPath,
                disabled: true,
            };
        }
        console.warn('[SECURITY] Could not write pc-admin-pin.txt:', e.message || e);
    }
    return { pin: null, source: 'unavailable', insecureDefault: false, pinPath };
}

function isFreshInstall(db) {
    const state = getActiveManagerState(db);
    return state.ok && !state.exists;
}

function describePcAdminPinSecurity(opts = {}) {
    return inspectPcAdminPin(opts);
}

/**
 * Inspect PIN posture without writing a new file (unless file/env already set).
 */
function inspectPcAdminPin(opts = {}) {
    const env = opts.env || process.env;
    const dataRoot = opts.dataRoot || getDataRoot();
    const pinPath = getPcAdminPinPath(dataRoot);

    if (env.PC_ADMIN_PIN != null && String(env.PC_ADMIN_PIN).length > 0) {
        const pin = String(env.PC_ADMIN_PIN);
        const secure = /^\d{8}$/.test(pin) && pin !== LEGACY_DEFAULT_PIN;
        return {
            source: 'env',
            configured: true,
            secure,
            insecureDefault: !secure,
            pinPath,
        };
    }
    const existing = readPinFile(pinPath, opts.fs || fs);
    if (existing.status === 'valid') {
        return {
            source: 'file',
            configured: true,
            secure: true,
            insecureDefault: false,
            pinPath,
        };
    }
    if (existing.status !== 'absent') {
        return {
            source: existing.source,
            configured: true,
            secure: false,
            insecureDefault: true,
            pinPath,
        };
    }

    const managerState = getActiveManagerState(opts.db);
    if (!managerState.ok) {
        return {
            source: 'manager_check_failed',
            configured: false,
            secure: false,
            insecureDefault: true,
            pinPath,
        };
    }
    if (!managerState.exists) {
        return {
            source: 'pending_generate',
            configured: false,
            secure: true,
            insecureDefault: false,
            pinPath,
            freshInstall: true,
        };
    }
    return {
        source: 'disabled',
        configured: false,
        secure: true,
        insecureDefault: false,
        pinPath,
        disabled: true,
    };
}

module.exports = {
    PIN_FILE_NAME,
    LEGACY_DEFAULT_PIN,
    MAX_PIN_FILE_BYTES,
    ACTIVE_MANAGER_EXISTS_SQL,
    getPcAdminPinPath,
    generatePin,
    getActiveManagerState,
    hasActiveManager,
    resolvePcAdminPin,
    inspectPcAdminPin,
    isFreshInstall,
    describePcAdminPinSecurity,
};
