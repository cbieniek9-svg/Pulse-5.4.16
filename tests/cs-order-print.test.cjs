'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildCsOrderPrintHtml, itemLines } = require('../src/lib/cs-order-print.cjs');

test('itemLines splits on plus and newlines', () => {
    assert.deepEqual(itemLines('2X MILK + 1X BREAD'), ['2X MILK', '1X BREAD']);
    assert.deepEqual(itemLines('A\nB'), ['A', 'B']);
});

test('buildCsOrderPrintHtml includes customer fields and print hook', () => {
    const html = buildCsOrderPrintHtml({
        order_id: 'ORD-1',
        customer: 'SMITH',
        contact: '403-555-1212',
        needed_by: '2026-08-01',
        route: 'Dairy',
        location: '2',
        item: '2X MILK + 1X EGGS',
        status: 'New',
        taken_by: 'ADA',
        logged_by: 'ADA',
    }, { storeName: 'TGP Test', printedAt: '2026-07-18' });
    assert.match(html, /SMITH/);
    assert.match(html, /403-555-1212/);
    assert.match(html, /Dairy/);
    assert.match(html, /2X MILK/);
    assert.match(html, /window\.print/);
    assert.match(html, /ORD-1/);
});
