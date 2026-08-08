'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    resolveSheetMeta,
    calcLineTotal,
    saveLine,
    upsertDayMeta,
    buildReportPayload,
    buildReportWorkbookBuffer,
    formatReportFilename,
    normalizeStoreDate,
} = require('../src/lib/edmonton-receiving-report.cjs');

function makeDb() {
    const settings = new Map([['Receiving_Report_Period_Start', '2026-06-21']]);
    const day = new Map();
    const lines = new Map();
    return {
        get(sql, ...params) {
            if (sql.includes('FROM settings')) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            if (sql.includes('FROM receiving_report_day')) {
                return day.get(params[0]) || null;
            }
            if (sql.includes('FROM receiving_report_lines WHERE line_id')) {
                return lines.get(params[0]) || null;
            }
            if (sql.includes('MAX(sort_order)')) {
                const rows = [...lines.values()].filter((r) => r.store_date === params[0]);
                return { max_sort: rows.reduce((m, r) => Math.max(m, r.sort_order), 0) };
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('FROM receiving_report_lines')) {
                return [...lines.values()]
                    .filter((r) => r.store_date === params[0])
                    .sort((a, b) => a.sort_order - b.sort_order);
            }
            return [];
        },
        run(sql, ...params) {
            if (sql.startsWith('INSERT INTO receiving_report_day')) {
                day.set(params[0], {
                    store_date: params[0],
                    receiver_name: params[1],
                    freight_total: params[2],
                    updated_at: params[3],
                    updated_by: params[4],
                });
            } else if (sql.startsWith('UPDATE receiving_report_day')) {
                const existing = day.get(params[4]) || { store_date: params[4] };
                day.set(params[4], {
                    ...existing,
                    receiver_name: params[0],
                    freight_total: params[1],
                    updated_at: params[2],
                    updated_by: params[3],
                });
            } else if (sql.startsWith('INSERT INTO receiving_report_lines')) {
                lines.set(params[0], {
                    line_id: params[0],
                    store_date: params[1],
                    sort_order: params[2],
                    line_kind: params[3],
                    invoice_number: params[4],
                    supplier_name: params[5],
                    grocery: params[6],
                    tobacco: params[7],
                    meat: params[8],
                    bakery: params[9],
                    bakery_in_store: params[10],
                    deli: params[11],
                    produce: params[12],
                    produce_shrink: params[13],
                    dairy: params[14],
                    pharmacy: params[15],
                    gst: params[16],
                    notes: params[17],
                    created_at: params[18],
                    updated_at: params[19],
                    created_by: params[20],
                    updated_by: params[21],
                });
            } else if (sql.startsWith('UPDATE receiving_report_lines')) {
                const id = params[16];
                const existing = lines.get(id);
                lines.set(id, {
                    ...existing,
                    line_kind: params[0],
                    invoice_number: params[1],
                    supplier_name: params[2],
                    grocery: params[3],
                    tobacco: params[4],
                    meat: params[5],
                    bakery: params[6],
                    bakery_in_store: params[7],
                    deli: params[8],
                    produce: params[9],
                    produce_shrink: params[10],
                    dairy: params[11],
                    pharmacy: params[12],
                    gst: params[13],
                    notes: params[14],
                    updated_at: params[15],
                    updated_by: params[16],
                });
            } else if (sql.startsWith('DELETE FROM receiving_report_lines')) {
                lines.delete(params[0]);
            } else if (sql.includes('INSERT INTO settings')) {
                settings.set(params[0], params[1]);
            }
        },
    };
}

test('resolveSheetMeta maps store date to Edmonton workbook tab', () => {
    const meta = resolveSheetMeta('2026-07-18', '2026-06-21');
    assert.equal(meta.sheetName, 'Saturday WK4 (28)');
    assert.equal(meta.sheetIndex, 28);
});

test('calcLineTotal sums department columns and GST', () => {
    const total = calcLineTotal({
        grocery: 100,
        meat: 25.5,
        gst: 4.75,
    });
    assert.equal(total, 130.25);
});

test('formatReportFilename matches store naming convention', () => {
    assert.equal(
        formatReportFilename('2026-07-18'),
        'Edmonton Wholesale Market Receiving Report 2026Jul18.xlsx',
    );
});

test('buildReportPayload aggregates saved lines and day header', () => {
    const db = makeDb();
    upsertDayMeta(db, '2026-07-18', { receiver_name: 'SHANNON', freight_total: 323.45 }, 'Shannon');
    saveLine(db, '2026-07-18', {
        invoice_number: '5638048',
        supplier_name: 'THE GROCERY PEOPLE',
        grocery: -3289.35,
        meat: -247.95,
        dairy: -57.1,
        notes: '50% CREDIT - KAMLOOPS INVOICES',
    }, 'Shannon');

    const payload = buildReportPayload(db, '2026-07-18');
    assert.equal(payload.receiver_name, 'SHANNON');
    assert.equal(payload.freight_total, 323.45);
    assert.equal(payload.lines.length, 1);
    assert.equal(payload.lines[0].total_invoice, -3594.4);
    assert.equal(payload.totals.grocery, -3289.35);
});

test('buildReportWorkbookBuffer writes header and invoice row into template sheet', async () => {
    const template = path.join(__dirname, '..', 'store-templates', 'default', 'Template-Edmonton-Wholesale-Market-Receiving-Report.xlsx');
    if (!fs.existsSync(template)) {
        test.skip('Edmonton receiving template not present');
        return;
    }
    const db = makeDb();
    upsertDayMeta(db, '2026-07-18', {
        receiver_name: 'SHANNON',
        freight_total: 323.45,
        period_start: '2026-06-21',
    }, 'Shannon');
    saveLine(db, '2026-07-18', {
        invoice_number: '5638048',
        supplier_name: 'THE GROCERY PEOPLE',
        grocery: -3289.35,
        meat: -247.95,
        dairy: -57.1,
        notes: '50% CREDIT - KAMLOOPS INVOICES',
    }, 'Shannon');

    const { buffer, filename } = await buildReportWorkbookBuffer(db, '2026-07-18');
    assert.match(filename, /2026Jul18\.xlsx$/);
    assert.ok(Buffer.from(buffer).length > 1000);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const sheet = wb.getWorksheet('Saturday WK4 (28)');
    assert.ok(sheet);
    assert.equal(String(sheet.getCell('B3').value || ''), 'SHANNON');
    assert.equal(Number(sheet.getCell('N3').value || 0), 323.45);
    assert.equal(String(sheet.getCell('A6').value || ''), '5638048');
    assert.equal(String(sheet.getCell('B6').value || ''), 'THE GROCERY PEOPLE');
    assert.equal(Number(sheet.getCell('C6').value || 0), -3289.35);
    assert.equal(Number(sheet.getCell('N6').value || 0), -3594.4);
});

test('normalizeStoreDate rejects invalid input', () => {
    assert.throws(() => normalizeStoreDate('07/18/2026'), /YYYY-MM-DD/);
});
