'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const tvPath = path.join(__dirname, '..', 'public', 'tv', 'tv-dashboard.js');
const cssPath = path.join(__dirname, '..', 'public', 'tv', 'tv-dashboard.css');

test('TV dashboard includes a safety watch panel and manual safety message support', () => {
    const js = fs.readFileSync(tvPath, 'utf8');
    const css = fs.readFileSync(cssPath, 'utf8');

    assert.match(js, /SAFETY_PATTERN/);
    assert.match(js, /function\s+renderSafetyPanel/);
    assert.match(js, /SAFETY WATCH/);
    assert.match(js, /TV_Safety_Message/);
    assert.match(js, /renderSafetyPanel\(data\)/);
    assert.match(css, /tv-safety-panel/);
});
