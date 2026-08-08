'use strict';

/**
 * Financial Log input integrity — the parsing rules that decide whether a typed or
 * pasted receiving amount lands in the period totals or silently posts as $0.
 *
 * The client modules are ESM, so they are loaded through a dynamic import.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const clientDir = path.join(__dirname, '..', 'client', 'src', 'log');
const importLog = (file) => import(pathToFileURL(path.join(clientDir, file)).href);

test('parseAmount reads money the way Excel and receivers actually write it', async () => {
    const { parseAmount } = await importLog('logUtils.js');

    assert.equal(parseAmount('1234.56'), 1234.56);
    assert.equal(parseAmount('1,234.56'), 1234.56, 'thousands separator');
    assert.equal(parseAmount('$1,234.56'), 1234.56, 'currency symbol from an Excel paste');
    assert.equal(parseAmount(' 42.00 '), 42, 'padded cell');
    assert.equal(parseAmount('1\u00a0234.56'), 1234.56, 'non-breaking space from a web copy');
    assert.equal(parseAmount('(75.20)'), -75.2, 'accounting negative');
    assert.equal(parseAmount('-75.20'), -75.2);
    assert.equal(parseAmount('\u221275.20'), -75.2, 'unicode minus');
    assert.equal(parseAmount('.5'), 0.5);
    assert.equal(parseAmount(''), 0);
    assert.equal(parseAmount(null), 0);
    assert.equal(parseAmount(12.5), 12.5);
});

test('unparseable amounts report as invalid instead of collapsing to zero', async () => {
    const { parseAmountOrNull, isInvalidAmount, invalidAmountFields } = await importLog('logUtils.js');

    // The failure this guards: a fat-fingered "12.4o" used to bank as $0.00.
    assert.equal(parseAmountOrNull('12.4o'), null);
    assert.equal(parseAmountOrNull('abc'), null);
    assert.equal(parseAmountOrNull('12.3.4'), null);
    assert.equal(parseAmountOrNull('--5'), null);

    assert.equal(isInvalidAmount('12.4o'), true);
    assert.equal(isInvalidAmount('1,204.30'), false);
    assert.equal(isInvalidAmount(''), false, 'blank is not an error');

    const fields = invalidAmountFields({ grocery: '100.00', dairy: '9o.00', meat: '' });
    assert.deepEqual(fields, ['Dairy']);
});

test('a row whose only entry is a mistyped amount still counts as data', async () => {
    const { rowHasData } = await importLog('logUtils.js');

    // Otherwise the row reads as empty and gets cleared instead of corrected.
    assert.equal(rowHasData({ grocery: '9o.00' }), true);
    assert.equal(rowHasData({ grocery: '', supplier_name: '' }), false);
    assert.equal(rowHasData({ grocery: '0' }), false);
});

test('clipboard grid keeps row alignment and handles single-column pastes', async () => {
    const { parseClipboardGrid, isGridPaste } = await importLog('logGridNavigation.js');

    // Excel appends a trailing newline; only that gets dropped.
    assert.deepEqual(
        parseClipboardGrid('INV1\tACME\t10.00\r\nINV2\tBETA\t20.00\r\n'),
        [['INV1', 'ACME', '10.00'], ['INV2', 'BETA', '20.00']],
    );

    // A blank middle line is a real empty row — dropping it would shift every
    // amount below it onto the wrong invoice.
    assert.deepEqual(
        parseClipboardGrid('INV1\t10.00\n\nINV3\t30.00'),
        [['INV1', '10.00'], [''], ['INV3', '30.00']],
    );

    assert.equal(isGridPaste('INV1\tACME'), true, 'tabbed row');
    assert.equal(isGridPaste('10.00\n20.00\n30.00'), true, 'one column of amounts');
    assert.equal(isGridPaste('ACME FOODS'), false, 'plain single value pastes normally');
});
