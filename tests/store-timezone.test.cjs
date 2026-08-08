'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeStoreTimezone, fixRegionCityCasing } = require('../src/lib/store-timezone.cjs');
const { createStoreTimeAccessors } = require('../src/lib/store-time.cjs');

test('fixRegionCityCasing repairs America/eDMONTON typo', () => {
    assert.equal(fixRegionCityCasing('America/eDMONTON'), 'America/Edmonton');
});

test('normalizeStoreTimezone accepts America/Edmonton', () => {
    const r = normalizeStoreTimezone('America/eDMONTON');
    assert.equal(r.timezone, 'America/Edmonton');
    assert.equal(r.corrected, true);
});

test('normalizeStoreTimezone falls back on garbage input', () => {
    const r = normalizeStoreTimezone('Not/A/Zone');
    assert.equal(r.timezone, 'America/Toronto');
    assert.equal(r.invalid, true);
});

test('getTimezone uses normalized value from settings', () => {
    const accessors = createStoreTimeAccessors(() => ({ Store_Timezone: 'America/eDMONTON' }));
    assert.equal(accessors.getTimezone(), 'America/Edmonton');
});
