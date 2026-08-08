'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseReceivingDocumentText, rollupDepartments } = require('../src/lib/receiving-invoice-parse.cjs');
const { buildShrinkSummary } = require('../src/lib/receiving-invoice-import.cjs');

test('parseReceivingDocumentText extracts invoice header and SKU shrink lines', () => {
    const text = `
THE GROCERY PEOPLE
Invoice Number 9502859
SKU 1234567890 DANONE OIKOS YOGURT Qty 2 -58.25
SHORTED - SPARKS EGGS -20.34
POOR QUALITY HH TOMATOES -120.95
`;
    const parsed = parseReceivingDocumentText(text, { doc_type: 'shrink' });
    assert.equal(parsed.invoice_candidate.invoice_number, '9502859');
    assert.match(parsed.invoice_candidate.supplier_name, /GROCERY PEOPLE/);
    assert.ok(parsed.shrink_candidates.length >= 2);
    assert.equal(parsed.summary.sku_count >= 1, true);
    assert.ok(parsed.summary.total_shrink <= 0);
});

test('rollupDepartments maps shrink lines into report department columns', () => {
    const totals = rollupDepartments([
        { extended_cost: -58.25, department: 'dairy' },
        { extended_cost: -120.95, department: 'produce' },
        { extended_cost: -20.34, department: 'dairy' },
    ]);
    assert.equal(totals.dairy, -78.59);
    assert.equal(totals.produce, 0);
    assert.equal(totals.produce_shrink, -120.95);
    assert.equal(
        totals.produce + totals.produce_shrink,
        -120.95,
        'produce shrink must not double-count into produce + produce_shrink',
    );
});

test('rollupDepartments keeps explicit produce_shrink in produce_shrink only', () => {
    const totals = rollupDepartments([
        { extended_cost: -10, department: 'produce_shrink' },
        { extended_cost: 50, department: 'produce' },
    ]);
    assert.equal(totals.produce_shrink, -10);
    assert.equal(totals.produce, 50);
});

test('buildShrinkSummary aggregates SKU-level shrink totals', () => {
    const summary = buildShrinkSummary([
        { sku: '111', description: 'OIKOS', department: 'dairy', quantity: 2, extended_cost: -58.25 },
        { sku: '111', description: 'OIKOS', department: 'dairy', quantity: 1, extended_cost: -10 },
        { sku: '222', description: 'TOMATO', department: 'produce', quantity: 1, extended_cost: -5.5 },
    ]);
    assert.equal(summary.line_count, 3);
    assert.equal(summary.sku_count, 2);
    assert.equal(summary.total, -73.75);
    assert.equal(summary.by_department.dairy, -68.25);
    assert.equal(summary.by_sku[0].extended_cost, -68.25);
});
