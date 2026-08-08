'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    truthy,
    falsy,
    isTvDeviceTokenRequired,
    isTokenlessStoreModeEnabled,
    buildTokenlessDeviceSession,
} = require('../src/lib/poc-access.cjs');

function makeDb(value) {
    return {
        get(sql, name) {
            if (sql.includes('settings') && name === 'Require_TV_Device_Token' && value !== undefined) {
                return { setting_value: value };
            }
            return null;
        },
    };
}

test('device tokens are required and tokenless store mode is disabled by default', () => {
    assert.equal(isTvDeviceTokenRequired(makeDb(undefined), {}), true);
    assert.equal(isTokenlessStoreModeEnabled(makeDb(undefined), {}), false);
});

test('Require_TV_Device_Token=1 disables tokenless store mode', () => {
    const db = makeDb('1');
    assert.equal(isTvDeviceTokenRequired(db, {}), true);
    assert.equal(isTokenlessStoreModeEnabled(db, {}), false);
});

test('environment override can require tokens without a DB setting', () => {
    const db = makeDb('0');
    assert.equal(isTvDeviceTokenRequired(db, { TGP_REQUIRE_DEVICE_TOKEN: '1' }), true);
    assert.equal(isTokenlessStoreModeEnabled(db, { TGP_REQUIRE_DEVICE_TOKEN: '1' }), false);
});

test('production environment cannot enable tokenless store mode', () => {
    const db = makeDb('1');
    assert.equal(isTokenlessStoreModeEnabled(db, { TGP_TOKENLESS_STORE_MODE: '1' }), false);
    assert.equal(isTvDeviceTokenRequired(db, {
        TGP_REQUIRE_DEVICE_TOKEN: '0',
        TGP_TOKENLESS_STORE_MODE: '1',
    }), true);
});

test('tokenless store mode requires both test mode and an explicit override', () => {
    const db = makeDb('1');
    assert.equal(isTokenlessStoreModeEnabled(db, { TGP_TEST_MODE: '1' }), false);
    assert.equal(isTokenlessStoreModeEnabled(db, { TGP_TOKENLESS_STORE_MODE: '1' }), false);
    assert.equal(isTokenlessStoreModeEnabled(db, {
        TGP_TEST_MODE: '1',
        TGP_TOKENLESS_STORE_MODE: '1',
    }), true);
});

test('truthy and falsy helpers accept store-friendly values', () => {
    assert.equal(truthy('yes'), true);
    assert.equal(truthy('required'), true);
    assert.equal(falsy('optional'), true);
    assert.equal(falsy('off'), true);
});

test('buildTokenlessDeviceSession is authorized only behind both test flags', () => {
    const denied = buildTokenlessDeviceSession(
        { ip: '192.168.1.25' },
        { TGP_TOKENLESS_STORE_MODE: '1' },
    );
    assert.equal(denied.authorized, false);

    const session = buildTokenlessDeviceSession(
        { ip: '192.168.1.25' },
        { TGP_TEST_MODE: '1', TGP_TOKENLESS_STORE_MODE: '1' },
    );
    assert.equal(session.authorized, true);
    assert.equal(session.via, 'tokenless_lan');
    assert.equal(session.device.label, 'Store LAN display');
    assert.equal(session.device.has_device_token, false);
});
