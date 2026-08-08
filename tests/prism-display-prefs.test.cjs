'use strict';

/**
 * Prism display prefs (floor sidebar → Profile / display settings).
 *
 * Bug this pins: prism-ui.css was linked by the old SPA shell but dropped when the floor moved to
 * the React client. It is the only stylesheet defining .pulse-opt-row and the
 * .pulse-opt-btn.pulse-opt-active highlight, so Display mode / Text size / Language buttons gave no
 * feedback when tapped — the settings looked broken. It also carries the 5.1.5 ice/silver routine
 * task card contrast.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

const STYLESHEETS = [
    'mobile.css',
    'pulse-holo-tokens.css',
    'pulse-holo.css',
    'pulse-bridge.css',
    'prism-ui.css',
    'mgr-settings.css',
    'reports-shell.css',
];

test('React shell links every stylesheet the floor UI depends on', () => {
    const html = read('client/index.html');
    STYLESHEETS.forEach((css) => {
        assert.match(html, new RegExp(`/public/css/${css.replace('.', '\\.')}`), `index.html must link ${css}`);
    });
    assert.match(html, /\/public\/js\/pulse-i18n\.js/, 'i18n dictionary drives the option labels');
});

test('every linked stylesheet exists on disk', () => {
    STYLESHEETS.forEach((css) => {
        assert.ok(
            fs.existsSync(path.join(appRoot, 'public/css', css)),
            `public/css/${css} is linked but missing`,
        );
    });
});

test('prism-ui.css still provides the option row + active highlight', () => {
    const css = read('public/css/prism-ui.css');
    assert.match(css, /\.pulse-opt-row\s*\{/, 'option groups need row layout');
    assert.match(css, /\.pulse-opt-btn\.pulse-opt-active\s*\{/, 'selected option needs a visible state');
    assert.match(css, /\.prism-display-hint\s*\{/);
});

test('display prefs apply on boot, not only when the panel opens', () => {
    const main = read('client/src/main.jsx');
    assert.match(main, /bootPulsePrefs\(\)/, 'saved mode must apply before first paint');

    const prefs = read('client/src/lib/pulsePrefs.js');
    assert.match(prefs, /localStorage/, 'display prefs stay on the device');
    assert.match(prefs, /pulse-intensity-\$\{next\}/, 'intensity drives a body class');
    assert.match(prefs, /dataset\.textScale = next/, 'text scale drives a root data attribute');
});

test('the option labels the panel asks for exist in every language', () => {
    const i18n = read('public/js/pulse-i18n.js');
    const panel = read('client/src/components/floor/sidebar/ProfileSettingsPanel.jsx');

    const keys = [
        'prism_display_hint', 'display_mode_label', 'text_scale_label', 'language_label',
        'bridge_mode', 'high_contrast_mode', 'dock_glare_mode',
        'text_normal', 'text_large', 'text_xl',
    ];
    keys.forEach((key) => {
        assert.match(i18n, new RegExp(`${key}:`), `pulse-i18n.js is missing ${key}`);
    });

    // Guard against the panel drifting to a key the dictionary does not carry.
    const used = [...panel.matchAll(/t\('([a-z_]+)'\)/g)].map((m) => m[1]);
    used.forEach((key) => {
        assert.ok(keys.includes(key), `panel uses unpinned i18n key ${key}`);
    });
});

test('intensity modes actually redefine tokens the loaded CSS consumes', () => {
    const tokens = read('public/css/pulse-holo-tokens.css');
    assert.match(tokens, /body\.pulse-intensity-highcontrast\s*\{/);
    assert.match(tokens, /body\.pulse-intensity-dockglare\s*\{/);
    assert.match(tokens, /html\[data-text-scale="large"\]/);
    assert.match(tokens, /html\[data-text-scale="xl"\]/);

    // Something in the loaded chain has to read the tokens or the modes are inert.
    const consumers = ['pulse-holo.css', 'pulse-bridge.css']
        .map((f) => (read(`public/css/${f}`).match(/var\(--pulse-/g) || []).length);
    assert.ok(consumers.every((n) => n > 0), 'pulse CSS must consume --pulse-* tokens');
});

test('Prism modes are wired to the live refactored floor surfaces', () => {
    const css = read('public/css/prism-ui.css');
    const requiredSurfaces = [
        '#app-screen',
        '#auth-screen',
        '.st-sidebar',
        '.st-main',
        '.data-card:not(.data-urgent):not(.data-high)',
        '.kpi-box',
        '.st-input',
        '.st-btn',
        '.notice-card',
        '.confirm-panel',
    ];
    requiredSurfaces.forEach((selector) => {
        assert.ok(css.includes(selector), `React floor bridge is missing ${selector}`);
    });
    [
        '--prism-shell',
        '--prism-sidebar',
        '--prism-surface',
        '--prism-input',
        '--prism-text',
        '--prism-muted',
        '--prism-border',
        '--prism-accent',
    ].forEach((token) => {
        assert.ok(css.includes(`var(${token})`), `React floor does not consume ${token}`);
    });
});

test('High contrast and Dock glare have distinct refactored palettes', () => {
    const tokens = read('public/css/pulse-holo-tokens.css');
    const high = tokens.match(/body\.pulse-intensity-highcontrast\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    const dock = tokens.match(/body\.pulse-intensity-dockglare\s*\{([\s\S]*?)\n\}/)?.[1] || '';

    assert.match(high, /--prism-shell:\s*#000000/, 'High contrast needs a true-black shell');
    assert.match(high, /--prism-text:\s*#ffffff/, 'High contrast needs white primary text');
    assert.match(high, /--prism-shadow:\s*none/, 'High contrast should remove decorative shadows');

    assert.match(dock, /--prism-shell:\s*rgba\(237,\s*242,\s*237/, 'Dock glare needs a light shell');
    assert.match(dock, /--prism-text:\s*#111b24/, 'Dock glare needs dark text');
    assert.match(dock, /--prism-accent:\s*#7a4b00/, 'Dock glare needs a non-glowing warm accent');

    const bridge = tokens.match(/:root,\s*\nbody\.pulse-holo\s*\{([\s\S]*?)\n\}/)?.[1] || '';
    assert.notEqual(
        bridge.match(/--prism-shell:\s*([^;]+)/)?.[1],
        dock.match(/--prism-shell:\s*([^;]+)/)?.[1],
        'Bridge and Dock glare cannot resolve to the same shell',
    );
});

test('remaining React floor chrome uses Prism classes instead of fixed colors', () => {
    const floor = read('client/src/components/floor/FloorApp.jsx');
    assert.match(floor, /className="floor-sidebar-header"/);
    assert.match(floor, /className="conn-status-text"/);
    assert.match(floor, /className="floor-user-line"/);
    assert.match(floor, /className="floor-user-name"/);
    assert.match(floor, /className="sect-header recent-activity-header"/);
    assert.ok(!/id="conn-text" style=\{\{ color:/.test(floor));
    assert.ok(!/id="display-user" style=\{\{ color:/.test(floor));
    assert.ok(!/borderBottomColor: '#334455'/.test(floor));
});
