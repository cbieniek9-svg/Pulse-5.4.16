'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const floorActionsPath = path.join(__dirname, '..', 'client', 'src', 'lib', 'floorActions.js');

test('print/CSV exports use authenticated fetch headers, not query-string tokens', () => {
    const src = fs.readFileSync(floorActionsPath, 'utf8');
    assert.match(src, /export async function fetchAuthenticatedExport/);
    assert.match(src, /['"]x-session-token['"]\s*:\s*token\s*\|\|\s*['"]/);
    assert.doesNotMatch(src, /\/api\/export\/[^`'"]*token=/);
});
