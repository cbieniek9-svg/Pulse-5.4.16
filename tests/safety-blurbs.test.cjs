'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    DEFAULT_SAFETY_BLURBS,
    sanitizeMessage,
} = require('../src/lib/safety-blurbs.cjs');

test('default safety blurbs include safe cutting and grocery-floor reminders', () => {
    assert.ok(DEFAULT_SAFETY_BLURBS.length >= 10);
    assert.ok(DEFAULT_SAFETY_BLURBS.some((m) => /safe cutting/i.test(m)));
    assert.ok(DEFAULT_SAFETY_BLURBS.some((m) => /wet-floor|spills/i.test(m)));
    assert.ok(DEFAULT_SAFETY_BLURBS.some((m) => /exits|electrical panels/i.test(m)));
});

test('safety blurbs are board-sized and sanitized', () => {
    const s = sanitizeMessage('  Safe cutting:\n\ncut away   from body.  ');
    assert.equal(s, 'Safe cutting: cut away from body.');
    DEFAULT_SAFETY_BLURBS.forEach((m) => {
        assert.ok(sanitizeMessage(m).length <= 220, m);
    });
});
