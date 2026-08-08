'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const appRoot = path.resolve(__dirname, '..');

test('manager maintenance panel markup is present in React settings', () => {
    const jsx = fs.readFileSync(path.join(appRoot, 'client/src/settings/tabs/MaintenanceTab.jsx'), 'utf8');
    assert.match(jsx, /id="maintenance-readiness-list"/);
    assert.match(jsx, /secureThisStore/);
    assert.match(jsx, /SECURE THIS STORE/);
    assert.match(jsx, /fetchMaintenanceHealth/);
});

test('settings portals store session tokens in sessionStorage only', () => {
    const auth = fs.readFileSync(path.join(appRoot, 'client/src/components/shared/PortalAuth.jsx'), 'utf8');
    assert.match(auth, /sessionStorage\.getItem\('tgp_token'/);
    assert.doesNotMatch(auth, /localStorage\.setItem\('tgp_token'/);
    assert.doesNotMatch(auth, /localStorage\.setItem\('tgp_user'/);
});

test('manager maintenance actions are wired in React settings API', () => {
    const api = fs.readFileSync(path.join(appRoot, 'client/src/settings/lib/settingsApi.js'), 'utf8');
    assert.match(api, /\/api\/maintenance\/health/);
    assert.match(api, /\/api\/maintenance\/verify-backup/);
    assert.match(api, /\/api\/maintenance\/secure-store/);
    assert.match(api, /secureThisStore/);
    assert.match(api, /\/api\/manager\/audit-log/);
});

test('device manager UI requires purpose for authorization and supports undiscovered stations', () => {
    const jsx = fs.readFileSync(path.join(appRoot, 'client/src/settings/tabs/DevicesTab.jsx'), 'utf8');
    assert.match(jsx, /ADD DEVICE/);
    assert.match(jsx, /createDevice/);
    assert.match(jsx, /<select[^>]*required/);
    for (const purpose of ['tv', 'cs_desk', 'receiving', 'markdown']) {
        assert.match(jsx, new RegExp(`value:\\s*["']${purpose}["']`));
    }
    assert.match(jsx, /purpose/i);
    assert.match(jsx, /paired/i);
    assert.match(jsx, /unpaired/i);
});

test('device token presentation maps only working browser consumers to exact fragment URLs', () => {
    const jsx = fs.readFileSync(path.join(appRoot, 'client/src/settings/tabs/DevicesTab.jsx'), 'utf8');
    assert.match(jsx, /tv:\s*['"]\/tv['"]/);
    assert.match(jsx, /cs_desk:\s*['"]\/cs['"]/);
    assert.match(jsx, /receiving:\s*['"]\/rec['"]/);
    assert.match(jsx, /markdown:\s*['"]\/markdown['"]/);
    assert.match(jsx, /#deviceToken=\$\{encodeURIComponent\(token\)\}/);
    assert.doesNotMatch(jsx, /\?deviceToken=/);
    assert.match(jsx, /action credential only/i);
    assert.match(jsx, /public_https_base_url/);
    assert.match(jsx, /HTTPS address unavailable; complete HTTPS setup/);
    assert.doesNotMatch(jsx, /window\.location\.origin/);
    assert.doesNotMatch(jsx, /appPrompt/);
});

test('device manager API sends purpose only to create, authorize, and repurpose', () => {
    const api = fs.readFileSync(path.join(appRoot, 'client/src/settings/lib/settingsApi.js'), 'utf8');
    assert.match(api, /\/api\/devices\/create/);
    assert.match(api, /authorizeDevice\(id,\s*label,\s*purpose,\s*token\)/);
    assert.match(api, /issueDeviceToken\(id,\s*token\)/);
    assert.match(api, /rotateDeviceToken\(id,\s*token\)/);
    assert.match(api, /\/api\/devices\/rotate-token/);
    assert.match(api, /\/api\/devices\/repurpose/);
    assert.doesNotMatch(api, /(?:issue|rotate)DeviceToken\(id,\s*purpose/);
});

test('device and secure-store UI use token-only copy without IP authorization language', () => {
    const sources = [
        'client/src/settings/tabs/DevicesTab.jsx',
        'client/src/settings/tabs/MaintenanceTab.jsx',
    ].map((file) => fs.readFileSync(path.join(appRoot, file), 'utf8'));
    const combined = sources.join('\n');
    assert.doesNotMatch(combined, /IP fallback|IP-based (?:access|authorization)|authorize(?:d)? by IP/i);
    assert.match(sources[1], /token-only/i);
    assert.match(sources[1], /missing (?:a )?(?:token or purpose|purpose or token)/i);
});

test('device UI contains stale-prop synchronization and locked credential controls', () => {
    const jsx = fs.readFileSync(path.join(appRoot, 'client/src/settings/tabs/DevicesTab.jsx'), 'utf8');
    assert.match(jsx, /useEffect/);
    assert.match(jsx, /setPurpose\(dev\.device_purpose \|\| ''\)/);
    assert.match(jsx, /\[dev\.id,\s*dev\.device_purpose\]/);
    assert.match(jsx, /OneTimeCredentialDialog/);
    assert.match(jsx, /navigator\.clipboard\.writeText/);
    assert.match(jsx, /I have stored this credential/);
    assert.match(jsx, /disabled=\{busy/);
});

test('secure-store device inspection reports missing tokens and purposes separately', () => {
    const { inspectDeviceSecurityState } = require('../src/routes/manager/maintenance.cjs');
    const db = {
        get(sql) {
            assert.match(sql, /device_token_hash/);
            assert.match(sql, /device_purpose/);
            return {
                authorized_devices: 4,
                missing_token: 1,
                missing_purpose: 2,
                missing_token_or_purpose: 2,
            };
        },
    };
    assert.deepEqual(inspectDeviceSecurityState(db), {
        authorized_devices: 4,
        missing_token: 1,
        missing_purpose: 2,
        missing_token_or_purpose: 2,
        ready: false,
    });
});
