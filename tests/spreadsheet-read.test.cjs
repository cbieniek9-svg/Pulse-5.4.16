'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');
const {
    detectSpreadsheetFormat,
    readSpreadsheetBuffer,
    readSpreadsheetFile,
    sheetToObjects,
    excelSerialToDate,
} = require('../src/lib/spreadsheet-read.cjs');

const FIXTURE_XLS = path.join(__dirname, 'fixtures', 'minimal.xls');

async function buildMinimalXlsxBuffer() {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Inventory');
    ws.addRow(['sku', 'qty']);
    ws.addRow(['ABC-1', 4]);
    ws.addRow(['XYZ-9', 12]);
    return Buffer.from(await wb.xlsx.writeBuffer());
}

test('detectSpreadsheetFormat recognizes xlsx and xls by extension and magic', async () => {
    const xlsxBuf = await buildMinimalXlsxBuffer();
    assert.equal(detectSpreadsheetFormat('stock.xlsx', xlsxBuf), 'xlsx');
    assert.equal(detectSpreadsheetFormat('STOCK.XLSX', xlsxBuf), 'xlsx');

    const xlsBuf = fs.readFileSync(FIXTURE_XLS);
    assert.equal(detectSpreadsheetFormat('legacy.xls', xlsBuf), 'xls');
    assert.equal(detectSpreadsheetFormat('report.XLS', xlsBuf), 'xls');
});

test('readSpreadsheetBuffer parses minimal xlsx via ExcelJS', async () => {
    const buf = await buildMinimalXlsxBuffer();
    const result = await readSpreadsheetBuffer(buf, 'stock.xlsx');
    assert.equal(result.format, 'xlsx');
    assert.ok(Array.isArray(result.sheets));
    assert.equal(result.sheets.length, 1);
    assert.equal(result.sheets[0].name, 'Inventory');
    assert.deepEqual(result.sheets[0].rows[0], ['sku', 'qty']);
    assert.deepEqual(result.sheets[0].rows[1], ['ABC-1', 4]);
    assert.deepEqual(result.sheets[0].rows[2], ['XYZ-9', 12]);
});

test('xlsx empty middle rows are preserved for A1 addressing', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sparse');
    ws.getCell('A1').value = 'header';
    ws.getCell('B1').value = 'val';
    // Row 2 intentionally empty
    ws.getCell('A3').value = 'data-row-3';
    ws.getCell('B3').value = 42;
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const result = await readSpreadsheetBuffer(buf, 'sparse.xlsx');
    const rows = result.sheets[0].rows;
    assert.deepEqual(rows[0], ['header', 'val']);
    assert.ok(Array.isArray(rows[1]), 'rows[1] must exist as Excel row 2 placeholder');
    assert.equal(rows[1].length, 0, 'Excel row 2 must be empty placeholder []');
    assert.deepEqual(rows[2], ['data-row-3', 42]);
});

test('readSpreadsheetBuffer parses real BIFF8 .xls via xls-reader', async () => {
    assert.ok(fs.existsSync(FIXTURE_XLS), 'tests/fixtures/minimal.xls must exist for BIFF spike');
    const buf = fs.readFileSync(FIXTURE_XLS);
    // OLE2 magic
    assert.equal(buf.slice(0, 4).toString('hex'), 'd0cf11e0');

    const result = await readSpreadsheetBuffer(buf, 'minimal.xls');
    assert.equal(result.format, 'xls');
    assert.equal(result.sheets.length, 1);
    assert.equal(result.sheets[0].name, 'Products');
    assert.deepEqual(result.sheets[0].rows[0], ['Name', 'Qty']);
    assert.equal(result.sheets[0].rows[1][0], 'Apple');
    assert.equal(result.sheets[0].rows[1][1], 10);
    assert.equal(result.sheets[0].rows[2][0], 'Banana');
    assert.equal(result.sheets[0].rows[2][1], 5);
});

test('readSpreadsheetFile reads from disk', async () => {
    const result = await readSpreadsheetFile(FIXTURE_XLS);
    assert.equal(result.format, 'xls');
    assert.equal(result.sheets[0].name, 'Products');
});

test('unsupported format throws SPREADSHEET_UNSUPPORTED', async () => {
    await assert.rejects(
        () => readSpreadsheetBuffer(Buffer.from('not a spreadsheet'), 'notes.txt'),
        (err) => {
            assert.equal(err.code, 'SPREADSHEET_UNSUPPORTED');
            assert.equal(err.status, 400);
            return true;
        },
    );
});

test('corrupt spreadsheet throws SPREADSHEET_PARSE_FAILED', async () => {
    // Looks like xlsx (zip/PK) but is not a valid workbook
    const bogus = Buffer.from('PK\x03\x04corrupt-xlsx-payload');
    await assert.rejects(
        () => readSpreadsheetBuffer(bogus, 'broken.xlsx'),
        (err) => {
            assert.equal(err.code, 'SPREADSHEET_PARSE_FAILED');
            assert.equal(err.status, 400);
            return true;
        },
    );
});

test('sheetToObjects maps header row to objects', () => {
    const sheet = {
        name: 'S',
        rows: [
            ['sku', 'qty'],
            ['A', 1],
            ['B', 2],
        ],
    };
    assert.deepEqual(sheetToObjects(sheet), [
        { sku: 'A', qty: 1 },
        { sku: 'B', qty: 2 },
    ]);
});

test('sheetToObjects with header:1 returns raw array rows', () => {
    const sheet = {
        name: 'S',
        rows: [
            ['sku', 'qty'],
            ['A', 1],
        ],
    };
    assert.deepEqual(sheetToObjects(sheet, { header: 1 }), [
        ['sku', 'qty'],
        ['A', 1],
    ]);
});

test('excelSerialToDate converts Excel 1900 serials to UTC dates', () => {
    const serial = 44927; // 2023-01-01 (Excel 1900 date system)
    const d = excelSerialToDate(serial);
    assert.ok(d instanceof Date);
    assert.equal(d.getUTCFullYear(), 2023);
    assert.equal(d.getUTCMonth() + 1, 1);
    assert.equal(d.getUTCDate(), 1);

    // Fractional day → time component (noon)
    const noon = excelSerialToDate(44927.5);
    assert.equal(noon.getUTCHours(), 12);
});

test('round-trip: write xlsx to temp file then readSpreadsheetFile', async () => {
    const buf = await buildMinimalXlsxBuffer();
    const tmp = path.join(os.tmpdir(), `pulse-spreadsheet-read-${Date.now()}.xlsx`);
    fs.writeFileSync(tmp, buf);
    try {
        const result = await readSpreadsheetFile(tmp);
        assert.equal(result.format, 'xlsx');
        assert.equal(result.sheets[0].rows[1][0], 'ABC-1');
    } finally {
        fs.unlinkSync(tmp);
    }
});
