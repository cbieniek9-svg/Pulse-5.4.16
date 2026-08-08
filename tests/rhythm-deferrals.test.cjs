'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseRhythmDeferralMap,
    getDeferredRhythmIds,
} = require('../src/lib/reports-action-store.cjs');

test('parseRhythmDeferralMap accepts empty and valid maps', () => {
    assert.deepEqual(parseRhythmDeferralMap(''), {});
    assert.deepEqual(parseRhythmDeferralMap(null), {});
    assert.deepEqual(parseRhythmDeferralMap('{"2026-05-31":["1"]}'), { '2026-05-31': ['1'] });
});

test('parseRhythmDeferralMap throws on corrupt JSON', () => {
    assert.throws(() => parseRhythmDeferralMap('{nope'), /corrupt JSON/i);
});

test('parseRhythmDeferralMap throws on invalid shape', () => {
    assert.throws(() => parseRhythmDeferralMap('[]'), /invalid shape/i);
    assert.throws(() => parseRhythmDeferralMap('"x"'), /invalid shape/i);
});

test('getDeferredRhythmIds throws when setting is corrupt', () => {
    const db = {
        get() {
            return { setting_value: '{broken' };
        },
    };
    assert.throws(() => getDeferredRhythmIds(db, '2026-05-31'), /corrupt JSON/i);
});
