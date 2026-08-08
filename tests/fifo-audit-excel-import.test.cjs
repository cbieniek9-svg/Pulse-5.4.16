'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readSpreadsheetBuffer, sheetToObjects } = require('../src/lib/spreadsheet-read.cjs');
const {
    rowsToFifoAuditCandidates,
    detectExcelImportFormat,
    normalizeAisleLocation,
} = require('../src/lib/fifo-audit-excel-import.cjs');

test('normalizeAisleLocation parses aisle numbers and bakery', () => {
    assert.equal(normalizeAisleLocation('Aisle 3').zone, 'A3');
    assert.equal(normalizeAisleLocation('Tills/Aisle 5').zone, 'A5');
    assert.equal(normalizeAisleLocation('Bakery').zone, 'Bakery');
});

test('detectExcelImportFormat recognizes FIFO audit log headers', () => {
    const rows = [
        ['TGP Center Store - FIFO Audit Log'],
        ['Date Logged', 'Aisle / Location', 'Vendor Code', 'Item Description ', 'Quantity', 'Expiration Date', 'Action Taken / Notes'],
        ['2026-05-19', 'Aisle 1', '12345', 'Test Item', '2', '2026-06-01', ''],
    ];
    assert.equal(detectExcelImportFormat(rows), 'fifo');
});

test('rowsToFifoAuditCandidates parses sample FIFO audit rows', () => {
    const rows = [
        ['Date Logged', 'Aisle / Location', 'Vendor Code', 'Item Description ', 'Quantity', 'Expiration Date', 'Action Taken / Notes'],
        ['2026-05-19', 'Aisle 2', '999', 'Sample Yogurt', '1', '2026-06-15', 'Checked'],
    ];
    const { candidates, errors } = rowsToFifoAuditCandidates(rows, 2026);
    assert.equal(errors.length, 0);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].zone, 'A2');
    assert.equal(candidates[0].item_code, '999');
    assert.match(candidates[0].kill_date, /^2026-/);
});

test('TGP FIFO audit log workbook fixture is detected as fifo format', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'TGP_FIFO_Audit_Log_Sheet.xlsx');
    if (!fs.existsSync(fixture)) return;
    const wb = await readSpreadsheetBuffer(fs.readFileSync(fixture), path.basename(fixture));
    const sheet = wb.sheets.find((s) => s.name === 'FIFO Audit Log') || wb.sheets[0];
    const rows = sheetToObjects(sheet, { header: 1 })
        .map((row) => (Array.isArray(row) ? row : []).map((c) => (c == null ? '' : c)));
    assert.equal(detectExcelImportFormat(rows), 'fifo');
});
