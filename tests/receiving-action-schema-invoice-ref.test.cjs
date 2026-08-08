'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateAction } = require('../src/validation/action-request.cjs');

test('receiving time-out action accepts optional invoice_ref', () => {
    assert.doesNotThrow(() => validateAction({
        table: 'expected_orders',
        action: 'receiving_mark_departed',
        id_col: 'exp_id',
        id_val: 123,
        data: { invoice_ref: 'INV-12345' },
    }));
});
