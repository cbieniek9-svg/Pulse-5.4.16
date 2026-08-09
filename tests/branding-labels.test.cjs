'use strict';

const assert = require('assert');
const test = require('node:test');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(APP_ROOT, rel), 'utf8');
}

test('TGP Center Store branding is used for app/window/TV titles', () => {
    const checks = {
        'main.cjs': [
            'title: `TGP Center Store ${APP_VERSION}`',
        ],
        // Boot banner moved here when app-boot was split out of main.cjs.
        'src/lib/app-boot.cjs': [
            'logMsg(`TGP Center Store ${APP_VERSION}`)',
        ],
        'src/constants/store-meta.cjs': [
            "{ name: STORE_DISPLAY_NAME_KEY, value: 'TGP Center Store' }",
        ],
        'public/tv/tv-dashboard.html': [
            '<title>TGP Center Store — TV</title>',
            'TGP CENTER STORE',
        ],
        'public/tv/tv-dashboard.js': [
            "'TGP CENTER STORE'",
        ],
        'client/src/settings/tabs/StoreTvTab.jsx': [
            'placeholder="TGP Center Store"',
        ],
        // Unit tests must work on a clean checkout before generated dist/ exists.
        // Store preflight separately verifies and serves the production build.
        'client/index.html': [
            '<title>TGP Command Center</title>',
        ],
    };

    for (const [rel, expectedSnippets] of Object.entries(checks)) {
        const source = read(rel);
        for (const snippet of expectedSnippets) {
            assert.ok(source.includes(snippet), `${rel} should include ${snippet}`);
        }
    }
});

test('legacy default display name is migrated without touching custom names', () => {
    const dbSource = read('src/db.cjs');
    assert.ok(dbSource.includes("'TGP Center Store',\n    STORE_DISPLAY_NAME_KEY,\n    'TGP Command Center'"));
    assert.ok(dbSource.includes('WHERE setting_name = ? AND setting_value = ?'));
});
