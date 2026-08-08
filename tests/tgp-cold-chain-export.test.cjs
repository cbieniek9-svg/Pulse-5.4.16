'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildColdChainPayload,
    renderColdChainPrintHtml,
    renderColdChainCsv,
    parseDateRange,
} = require('../src/lib/tgp-cold-chain-export.cjs');

function mockDb(rows) {
    return {
        all() { return rows; },
    };
}

test('parseDateRange accepts single day and range', () => {
    assert.deepEqual(parseDateRange('2026-06-01', ''), { start: '2026-06-01', end: '2026-06-01' });
    assert.deepEqual(parseDateRange('2026-06-01', '2026-06-07'), { start: '2026-06-01', end: '2026-06-07' });
});

test('parseDateRange rejects inverted range', () => {
    assert.throws(() => parseDateRange('2026-06-07', '2026-06-01'), /on or after/);
});

test('buildColdChainPayload enriches department labels', () => {
    const payload = buildColdChainPayload(mockDb([{
        store_date: '2026-06-01',
        license_plate: 'ABC123',
        department: 'produce',
        temp_c: 3,
        in_range: 1,
        invoice_ref: 'INV-1',
        captured_by: 'Alex',
        captured_at: '2026-06-01T14:00:00.000Z',
    }]), '2026-06-01', '2026-06-01');
    assert.equal(payload.summary.pallet_count, 1);
    assert.equal(payload.rows[0].department_label, 'Produce');
});

test('renderColdChainPrintHtml includes store title and out-of-range row', () => {
    const payload = buildColdChainPayload(mockDb([{
        store_date: '2026-06-01',
        license_plate: 'XYZ',
        department: 'dairy',
        temp_c: 4.3,
        temp_spot_1: 8,
        temp_spot_2: 2,
        temp_spot_3: 3,
        in_range: 0,
        invoice_ref: '',
        captured_by: 'Sam',
        captured_at: '2026-06-01T15:00:00.000Z',
    }]), '2026-06-01', '2026-06-01');
    const html = renderColdChainPrintHtml(payload, 'Test Store');
    assert.match(html, /Test Store — TGP Cold Chain Log/);
    assert.match(html, /class="out"/);
    assert.match(html, /OUT OF TEMP/);
    assert.match(html, /8 \/ 2 \/ 3 → avg 4\.3/);
    assert.match(html, /<strong>4\.3<\/strong>/);
});

test('renderColdChainCsv includes spot checks and OUT status', () => {
    const payload = buildColdChainPayload(mockDb([{
        store_date: '2026-06-01',
        license_plate: 'XYZ',
        department: 'dairy',
        temp_c: 4.3,
        temp_spot_1: 8,
        temp_spot_2: 2,
        temp_spot_3: 3,
        in_range: 0,
    }]), '2026-06-01', '2026-06-01');
    const csv = renderColdChainCsv(payload);
    assert.match(csv, /^store_date,license_plate/);
    assert.match(csv, /temp_spot_1,temp_spot_2,temp_spot_3,spot_checks/);
    assert.match(csv, /8 \/ 2 \/ 3 → avg 4\.3/);
    assert.match(csv, /,"OUT",/);
});
