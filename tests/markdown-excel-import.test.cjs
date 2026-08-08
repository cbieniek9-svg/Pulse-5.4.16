const test = require('node:test');
const assert = require('node:assert/strict');
const { rowsToKillDateCandidates, normalizeZone } = require('../src/lib/markdown-excel-import.cjs');

test('rowsToKillDateCandidates parses standard markdown excel headers', () => {
    const rows = [
        ['Item', 'Vendor Code', 'Expiration Date', 'Aisle'],
        ['Tim Hortons Decaf 640g', '6320911763', '2026-06-15', '5'],
        ['Milk 2L', '1234567890', 'Jun 20, 2026', '1'],
    ];
    const { candidates, errors } = rowsToKillDateCandidates(rows, 2026);
    assert.equal(errors.length, 0);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].item, 'Tim Hortons Decaf 640g');
    assert.equal(candidates[0].item_code, '6320911763');
    assert.equal(candidates[0].kill_date, '2026-06-15');
    assert.equal(candidates[0].zone, 'A5');
    assert.equal(candidates[1].zone, 'A1');
});

test('normalizeZone accepts aisle labels and canonical zone names', () => {
    assert.equal(normalizeZone('A3', ''), 'A3');
    assert.equal(normalizeZone('', '7'), 'A7');
    assert.equal(normalizeZone('Dairy', ''), 'Dairy');
});

test('rowsToKillDateCandidates reports invalid expiration rows', () => {
    const rows = [
        ['Description', 'Code', 'Kill Date'],
        ['Bad row', '111', ''],
    ];
    const { candidates, errors } = rowsToKillDateCandidates(rows, 2026);
    assert.equal(candidates.length, 0);
    assert.match(errors.join(' '), /invalid expiration/i);
});
