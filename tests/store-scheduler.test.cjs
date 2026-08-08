const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveTimezone } = require('../src/lib/store-scheduler.cjs');

test('resolveTimezone uses store setting when valid', () => {
    assert.equal(resolveTimezone(() => 'America/Toronto'), 'America/Toronto');
});

test('resolveTimezone falls back for invalid IANA', () => {
    assert.equal(resolveTimezone(() => 'Not/A/Zone'), 'America/Toronto');
});
