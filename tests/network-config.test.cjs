'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    buildNetworkConfig,
    isAllowedCorsOrigin,
    normalizeBindHost,
    parsePort,
} = require('../src/lib/network-config.cjs');
const { listPrivateIpv4 } = require('../src/lib/safe-network-interfaces.cjs');

test('HTTPS-only LAN: HTTP loopback, HTTPS LAN bind, public HTTPS URL', () => {
    const cfg = buildNetworkConfig({ Allow_LAN_Clients: '1' }, {});
    assert.equal(cfg.http_bind_host, '127.0.0.1');
    assert.equal(cfg.https_bind_host, '0.0.0.0');
    assert.equal(cfg.bind_host, '0.0.0.0');
    assert.equal(cfg.port, 3001);
    assert.equal(cfg.https_enabled, true);
    assert.equal(cfg.https_port, 3443);
    assert.equal(cfg.https_active, false);
    assert.equal(cfg.lan_ready, false);
    assert.match(cfg.public_https_base_url, /^https:/);
    assert.match(cfg.public_base_url, /^http:\/\/127\.0\.0\.1:/);
    assert.ok(cfg.warnings.some((w) => /store network/i.test(w)));
});

test('network config can disable LAN clients and bind localhost only', () => {
    const cfg = buildNetworkConfig({ Allow_LAN_Clients: '0', LAN_Bind_Host: '0.0.0.0', LAN_Port: '3100' }, {});
    assert.equal(cfg.allow_lan_clients, false);
    assert.equal(cfg.http_bind_host, '127.0.0.1');
    assert.equal(cfg.https_bind_host, '127.0.0.1');
    assert.equal(cfg.bind_host, '127.0.0.1');
    assert.equal(cfg.port, 3100);
    assert.equal(isAllowedCorsOrigin('http://127.0.0.1:3100', cfg), true);
    assert.equal(isAllowedCorsOrigin('http://192.168.1.20:3100', cfg), false);
    assert.equal(isAllowedCorsOrigin('https://192.168.1.20:3443', cfg), false);
});

test('CORS allows loopback HTTP and private HTTPS only', () => {
    const cfg = buildNetworkConfig({ Allow_LAN_Clients: '1', LAN_Port: '3001' }, {});
    assert.equal(isAllowedCorsOrigin('http://localhost:3001', cfg), true);
    assert.equal(isAllowedCorsOrigin('http://127.0.0.1:3001', cfg), true);
    assert.equal(isAllowedCorsOrigin('http://[::1]:3001', cfg), true);
    assert.equal(isAllowedCorsOrigin('https://[::1]:3443', cfg), true);
    assert.equal(isAllowedCorsOrigin('http://192.168.0.50:3001', cfg), false);
    assert.equal(isAllowedCorsOrigin('https://192.168.0.50:3443', cfg), true);
    assert.equal(isAllowedCorsOrigin('http://10.10.0.50:3001', cfg), false);
    assert.equal(isAllowedCorsOrigin('https://10.10.0.50:3443', cfg), true);
    assert.equal(isAllowedCorsOrigin('https://172.16.0.50:3443', cfg), true);
    assert.equal(isAllowedCorsOrigin('http://172.16.0.50:3001', cfg), false);
    assert.equal(isAllowedCorsOrigin('https://172.32.0.50:3443', cfg), false);
    assert.equal(isAllowedCorsOrigin('https://192.168.0.50:3001', cfg), false);
    assert.equal(isAllowedCorsOrigin('http://192.168.0.50:9999', cfg), false);
    // Absent origin: non-CORS clients (curl, Electron) may proceed.
    assert.equal(isAllowedCorsOrigin(undefined, cfg), true);
    assert.equal(isAllowedCorsOrigin('', cfg), true);
    // Opaque "null" origin must not be treated as allowed.
    assert.equal(isAllowedCorsOrigin('null', cfg), false);
});

test('public HTTPS falls back to loopback when no LAN addresses', () => {
    const cfg = buildNetworkConfig({ Allow_LAN_Clients: '1' }, {}, {
        networkInterfaces: () => ({}),
    });
    assert.deepEqual(cfg.lan_addresses, []);
    assert.equal(cfg.public_https_base_url, 'https://127.0.0.1:3443');
    assert.equal(cfg.lan_ready, false);
});

test('adapter enumeration throw is non-fatal and records a warning', () => {
    const cfg = buildNetworkConfig({ Allow_LAN_Clients: '1' }, {}, {
        networkInterfaces: () => {
            throw new Error('adapter boom');
        },
    });
    assert.deepEqual(cfg.lan_addresses, []);
    assert.ok(cfg.warnings.some((w) => /Network adapter enumeration failed/i.test(w)));
    assert.ok(cfg.warnings.some((w) => /adapter boom/.test(w)));
});

test('safe enumerator prefers 192.168 then 10 then 172.16-31 and filters non-private', () => {
    const { addresses, warning } = listPrivateIpv4({
        networkInterfaces: () => ({
            eth0: [
                { address: '8.8.8.8', family: 'IPv4', internal: false },
                { address: '172.20.0.5', family: 'IPv4', internal: false },
                { address: '10.0.0.9', family: 'IPv4', internal: false },
                { address: '192.168.1.40', family: 'IPv4', internal: false },
                { address: '127.0.0.1', family: 'IPv4', internal: true },
            ],
            'vEthernet (WSL)': [
                { address: '172.28.16.1', family: 'IPv4', internal: false },
            ],
        }),
    });
    assert.equal(warning, '');
    assert.deepEqual(addresses, ['192.168.1.40', '10.0.0.9', '172.20.0.5', '172.28.16.1']);
});

test('network config normalizes unsafe host and port values', () => {
    assert.equal(normalizeBindHost('$(bad)', true), '0.0.0.0');
    assert.equal(normalizeBindHost('192.168.1.10', true), '192.168.1.10');
    assert.equal(normalizeBindHost('0.0.0.0', false), '127.0.0.1');
    assert.equal(parsePort('not-a-port'), 3001);
    assert.equal(parsePort('70000'), 3001);
    assert.equal(parsePort('3010'), 3010);
});

test('local HTTPS SAN includes ::1 and filters unsafe extraHosts', () => {
    const { buildAltNames } = require('../src/lib/local-https.cjs');
    const alt = buildAltNames(
        ['192.168.1.9', '8.8.8.8', 'evil.com', 'tgp.local', 'bad host', '$(cmd)'],
        { networkInterfaces: () => ({}) },
    );
    assert.ok(alt.some((n) => n.type === 7 && n.ip === '127.0.0.1'));
    assert.ok(alt.some((n) => n.type === 7 && n.ip === '::1'));
    assert.ok(alt.some((n) => n.type === 7 && n.ip === '192.168.1.9'));
    assert.ok(!alt.some((n) => n.ip === '8.8.8.8'));
    assert.ok(alt.some((n) => n.type === 2 && n.value === 'tgp.local'));
    assert.ok(!alt.some((n) => n.value === 'evil.com'));
    assert.ok(!alt.some((n) => n.value === 'bad host'));
    assert.ok(!alt.some((n) => n.value === '$(cmd)'));
});
