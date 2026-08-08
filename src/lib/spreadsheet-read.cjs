'use strict';

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { readXls, excelSerialToDate: xlsExcelSerialToDate } = require('xls-reader');

function spreadsheetError(code, message) {
    const err = new Error(message);
    err.code = code;
    err.status = 400;
    return err;
}

function extOf(filename) {
    return path.extname(String(filename || '')).toLowerCase();
}

function looksLikeZip(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= 4
        && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function looksLikeOle2(buffer) {
    return Buffer.isBuffer(buffer) && buffer.length >= 8
        && buffer[0] === 0xd0 && buffer[1] === 0xcf
        && buffer[2] === 0x11 && buffer[3] === 0xe0;
}

/**
 * Detect spreadsheet format from filename and/or magic bytes.
 * @returns {'xlsx'|'xls'|null}
 */
function detectSpreadsheetFormat(filename, buffer) {
    const ext = extOf(filename);
    if (ext === '.xlsx' || ext === '.xlsm') return 'xlsx';
    if (ext === '.xls') return 'xls';
    if (buffer) {
        if (looksLikeZip(buffer)) return 'xlsx';
        if (looksLikeOle2(buffer)) return 'xls';
    }
    return null;
}

function cellToValue(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value;
    if (typeof value !== 'object') return value;
    // ExcelJS formula result
    if (Object.prototype.hasOwnProperty.call(value, 'result')) {
        return cellToValue(value.result);
    }
    // ExcelJS rich text
    if (Array.isArray(value.richText)) {
        return value.richText.map((p) => p.text || '').join('');
    }
    if (typeof value.text === 'string') return value.text;
    if (typeof value.hyperlink === 'string' && value.text != null) return String(value.text);
    if (value.error) return null;
    return value;
}

function excelJsSheetToRows(worksheet) {
    const rows = [];
    if (!worksheet || typeof worksheet.eachRow !== 'function') return rows;
    const dim = worksheet.dimensions;
    const maxCol = dim && dim.right ? dim.right : 0;
    // Preserve Excel A1 addressing: rows[N-1] must be Excel row N.
    // ExcelJS skips empty middle rows even with includeEmpty, so pad gaps.
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        while (rows.length < rowNumber - 1) rows.push([]);
        const values = row.values || [];
        const width = Math.max(maxCol, values.length - 1, 0);
        const out = [];
        for (let c = 1; c <= width; c += 1) {
            out.push(cellToValue(values[c]));
        }
        while (out.length && out[out.length - 1] === null) out.pop();
        rows[rowNumber - 1] = out;
    });
    return rows;
}

async function readXlsxBuffer(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheets = wb.worksheets.map((ws) => ({
        name: ws.name,
        rows: excelJsSheetToRows(ws),
    }));
    return { format: 'xlsx', sheets };
}

function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array && !(buffer instanceof Buffer)) return buffer;
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function normalizeXlsCell(value) {
    if (value === undefined) return null;
    // CellError from xls-reader — surface as null for grid consumers
    if (value && typeof value === 'object' && !(value instanceof Date) && typeof value.code === 'string') {
        return null;
    }
    return value;
}

function readXlsBuffer(buffer) {
    const workbook = readXls(toUint8Array(buffer));
    const sheets = (workbook.sheets || []).map((sheet) => ({
        name: sheet.name,
        rows: (sheet.rows || []).map((row) => (row || []).map(normalizeXlsCell)),
    }));
    return { format: 'xls', sheets };
}

/**
 * @param {Buffer|Uint8Array} buffer
 * @param {string} filename
 * @param {object} [opts]
 * @returns {Promise<{ format: 'xlsx'|'xls', sheets: Array<{ name: string, rows: any[][] }> }>}
 */
async function readSpreadsheetBuffer(buffer, filename, opts = {}) {
    void opts;
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const format = detectSpreadsheetFormat(filename, buf);
    if (!format) {
        throw spreadsheetError(
            'SPREADSHEET_UNSUPPORTED',
            `Unsupported spreadsheet format for "${filename || 'upload'}". Expected .xlsx or .xls.`,
        );
    }
    try {
        if (format === 'xlsx') return await readXlsxBuffer(buf);
        return readXlsBuffer(buf);
    } catch (err) {
        if (err && (err.code === 'SPREADSHEET_UNSUPPORTED' || err.code === 'SPREADSHEET_PARSE_FAILED')) {
            throw err;
        }
        const wrapped = spreadsheetError(
            'SPREADSHEET_PARSE_FAILED',
            err?.message || `Failed to parse spreadsheet "${filename || 'upload'}".`,
        );
        wrapped.cause = err;
        throw wrapped;
    }
}

/**
 * @param {string} filePath
 * @param {object} [opts]
 */
async function readSpreadsheetFile(filePath, opts = {}) {
    const buf = fs.readFileSync(filePath);
    return readSpreadsheetBuffer(buf, path.basename(filePath), opts);
}

/**
 * Convert a normalized sheet to objects (header row) or raw array rows (header:1).
 * @param {{ name?: string, rows: any[][] }} sheet
 * @param {{ header?: number|string, headerRow?: number }} [opts]
 */
function sheetToObjects(sheet, opts = {}) {
    const rows = Array.isArray(sheet?.rows) ? sheet.rows : [];
    if (opts.header === 1) {
        return rows.slice();
    }
    const headerRowIndex = Number.isInteger(opts.headerRow) ? opts.headerRow : 0;
    const header = rows[headerRowIndex] || [];
    const keys = header.map((h, i) => {
        const key = h === null || h === undefined || h === '' ? '' : String(h);
        return key || `col_${i}`;
    });
    const out = [];
    for (let r = headerRowIndex + 1; r < rows.length; r += 1) {
        const row = rows[r] || [];
        const obj = {};
        for (let c = 0; c < keys.length; c += 1) {
            const key = keys[c];
            if (!key) continue;
            obj[key] = row[c] !== undefined ? row[c] : null;
        }
        out.push(obj);
    }
    return out;
}

/**
 * Excel 1900 date system → UTC Date (compatible with XLSX.SSF.parse_date_code).
 * @param {number} serial
 * @returns {Date}
 */
function excelSerialToDate(serial) {
    return xlsExcelSerialToDate(Number(serial), false);
}

module.exports = {
    detectSpreadsheetFormat,
    readSpreadsheetBuffer,
    readSpreadsheetFile,
    sheetToObjects,
    excelSerialToDate,
};
