'use strict';

/**
 * Trusted-device access policy for single-store LAN deployments.
 *
 * Defaults:
 *   - Device tokens are required.
 *   - Tokenless access exists only for isolated tests that opt in explicitly.
 */

function truthy(value) {
    return ['1', 'true', 'yes', 'on', 'required', 'require'].includes(String(value ?? '').trim().toLowerCase());
}

function falsy(value) {
    return ['0', 'false', 'no', 'off', 'optional', 'disabled'].includes(String(value ?? '').trim().toLowerCase());
}

function readSetting(db, name) {
    try {
        return db?.get?.('SELECT setting_value FROM settings WHERE setting_name=?', name)?.setting_value;
    } catch (_) {
        return undefined;
    }
}

function isTvDeviceTokenRequired(db, env = process.env) {
    return !isTokenlessStoreModeEnabled(db, env);
}

function isTokenlessStoreModeEnabled(db, env = process.env) {
    void db;
    return truthy(env?.TGP_TEST_MODE) && truthy(env?.TGP_TOKENLESS_STORE_MODE);
}

function buildTokenlessDeviceSession(req, env = process.env) {
    if (!isTokenlessStoreModeEnabled(null, env)) {
        return {
            authorized: false,
            via: null,
            device: null,
            reason: 'tokenless_test_mode_disabled',
        };
    }
    const ip = req?.ip || req?.socket?.remoteAddress || 'store-lan';
    return {
        authorized: true,
        via: 'tokenless_lan',
        device: {
            id: null,
            label: 'Store LAN display',
            ip_address: ip,
            status: 'Tokenless',
            has_device_token: false,
        },
    };
}

module.exports = {
    truthy,
    falsy,
    isTvDeviceTokenRequired,
    isTokenlessStoreModeEnabled,
    buildTokenlessDeviceSession,
};
