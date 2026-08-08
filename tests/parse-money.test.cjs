'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    parseMoneyOrNull,
    parseMoneyOrThrow,
    parseOptionalMoneyOrThrow,
    roundMoney,
} = require('../src/lib/parse-money.cjs');
const { normalizeLineInput } = require('../src/lib/edmonton-receiving-report.cjs');

test('parseMoneyOrNull accepts Excel / keyboard money shapes', () => {
    assert.equal(parseMoneyOrNull('1,234.56'), 1234.56);
    assert.equal(parseMoneyOrNull('$1,234.56'), 1234.56);
    assert.equal(parseMoneyOrNull('(75.20)'), -75.2);
    assert.equal(parseMoneyOrNull('\u221275.20'), -75.2);
    assert.equal(parseMoneyOrNull(''), null);
    assert.equal(parseMoneyOrNull('12.4o'), null);
});

test('parseMoneyOrThrow refuses garbage instead of banking zero', () => {
    assert.equal(parseMoneyOrThrow('', 'Grocery'), 0);
    assert.equal(parseMoneyOrThrow('10.50', 'Grocery'), 10.5);
    assert.throws(() => parseMoneyOrThrow('12.4o', 'Grocery'), /Not a number: Grocery/);
    assert.throws(() => parseOptionalMoneyOrThrow('abc', 'Freight'), /Not a number: Freight/);
    assert.equal(parseOptionalMoneyOrThrow('', 'Freight'), null);
});

test('normalizeLineInput rejects mistyped department amounts', () => {
    assert.throws(
        () => normalizeLineInput({ grocery: '9o.00', supplier_name: 'ACME' }),
        (err) => err.status === 400 && /Grocery/.test(err.message),
    );
    const ok = normalizeLineInput({ grocery: '10.00', dairy: '(1.50)' });
    assert.equal(ok.grocery, 10);
    assert.equal(ok.dairy, -1.5);
});

test('roundMoney only rounds already-validated numbers', () => {
    assert.equal(roundMoney(10.005), 10.01);
    assert.equal(roundMoney(Number.NaN), 0);
});
