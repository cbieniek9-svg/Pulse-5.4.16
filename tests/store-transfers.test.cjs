'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const {
    listTransferCustomers,
    buildTransferWorkbookBuffer,
    buildManifestWorkbookBuffer,
    createStoreTransfer,
    searchStoreTransfers,
    isStoreTransfersEnabled,
    templatePath,
    manifestTemplatePath,
    normalizeLineItems,
} = require('../src/lib/store-transfers.cjs');

test('templates exist (Rec + Manifest)', async () => {
    assert.equal(fs.existsSync(templatePath()), true);
    assert.equal(fs.existsSync(manifestTemplatePath()), true);
    const customers = await listTransferCustomers();
    assert.ok(customers.length >= 4);
});

test('normalizeLineItems requires name qty cost', () => {
    assert.throws(() => normalizeLineItems([]), /at least one/i);
    assert.throws(() => normalizeLineItems([{ item: 'Ribs', quantity: 2 }]), /Cost/i);
    const rows = normalizeLineItems([
        { item: 'Ribs', quantity: 2, cost: 10 },
        { item: 'Wings', quantity: 1, cost: 20 },
    ]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cost, 10);
    assert.equal(rows[0].price, 10.725); // 7.25% upcharge
});

test('listTransferCustomers is limited to cost-upcharge stores', async () => {
    const { customerUsesCostUpcharge, listTransferCustomers: list } = require('../src/lib/store-transfers.cjs');
    const customers = await list();
    assert.ok(customers.length >= 4);
    assert.ok(customers.every((c) => customerUsesCostUpcharge(c.name)));
    assert.ok(customers.some((c) => /high\s*prairie/i.test(c.name)));
    assert.ok(customers.some((c) => /(?:lloyd|llyod)minster/i.test(c.name)));
    assert.ok(customers.some((c) => /kamloops/i.test(c.name)));
});

test('buildTransferWorkbookBuffer writes Cost to E and keeps Price as formula', async () => {
    const customers = await listTransferCustomers();
    const pick = customers.find((c) => /high\s*prairie/i.test(c.name)) || customers[0];
    const buf = await buildTransferWorkbookBuffer({
        invoiceNo: 'ST-000042',
        storeDate: '2026-07-21',
        customerName: pick.name,
        customerNumber: pick.number,
        storageType: 'Cooler',
        pieces: 3,
        pallets: 1,
        weightKg: 40,
        lineItems: [
            { order_no: '77011', item: 'Test Ribs', quantity: 2, cost: 10, price: 10.725 },
            { item: 'Test Wings', quantity: 1, cost: 20, price: 21.45 },
        ],
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Invoice', 'Manifest']);
    const invoice = wb.getWorksheet('Invoice');
    assert.equal(String(invoice.getCell('I1').value || ''), 'ST-000042');
    assert.equal(String(invoice.getCell('B16').value || ''), 'Test Ribs');
    assert.equal(String(invoice.getCell('A16').value || ''), '77011');
    assert.equal(Number(invoice.getCell('G16').value), 2);
    assert.equal(Number(invoice.getCell('E16').value), 10);
    const h16 = invoice.getCell('H16').value;
    assert.equal(typeof h16, 'object');
    assert.match(String(h16.formula || ''), /E16/);
    assert.match(String(h16.formula || ''), /F16/);
    assert.equal(Number(invoice.getCell('J16').result ?? invoice.getCell('J16').value), 21.45);
    assert.equal(String(invoice.getCell('B17').value || ''), 'Test Wings');
    assert.equal(Number(invoice.getCell('E17').value), 20);
    assert.equal(invoice.getRow(17).hidden, false);
    assert.equal(Number(invoice.getCell('J39').value), 42.9);
    const man = wb.getWorksheet('Manifest');
    assert.equal(String(man.getCell('B23').value || ''), 'ST-000042');
    assert.equal(String(man.getCell('C23').value || ''), pick.name);
    assert.equal(man.getCell('B6').value, null);
});

test('buildManifestWorkbookBuffer fills header row and keeps lookup columns', async () => {
    const buf = await buildManifestWorkbookBuffer({
        invoiceNo: 'ST-000042',
        storeDate: '2026-07-21',
        customerName: 'Andrew Co-op',
        customerNumber: '2643',
        storageType: 'Cooler',
        pieces: 3,
        pallets: 1,
        weightKg: 40,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = wb.worksheets[0];
    assert.equal(String(sheet.getCell('B23').value || ''), 'ST-000042');
    assert.equal(String(sheet.getCell('C23').value || ''), 'Andrew Co-op');
    assert.equal(String(sheet.getCell('A23').value || ''), '2643');
    assert.equal(String(sheet.getCell('D23').value || ''), 'Cooler');
    assert.equal(Number(sheet.getCell('E23').value), 3);
    assert.equal(String(sheet.getCell('M1').value || '').trim().length > 0, true);
    assert.equal(sheet.getCell('B6').value, null);
});

test('isStoreTransfersEnabled defaults off', () => {
    assert.equal(isStoreTransfersEnabled({ Store_Transfers_Enabled: '0' }), false);
    assert.equal(isStoreTransfersEnabled({ Store_Transfers_Enabled: '1' }), true);
});

function mockDb() {
    const settings = new Map([
        ['Store_Transfers_Enabled', '1'],
        ['Store_Transfer_Invoice_Seq', '0'],
    ]);
    const rows = [];
    const db = {
        get(sql, ...params) {
            if (sql.includes('setting_name=?')) {
                const key = params[0];
                const v = settings.get(key);
                return v == null ? undefined : { setting_value: v };
            }
            if (sql.includes('FROM store_transfers WHERE invoice_no')) {
                return rows.find((r) => r.invoice_no === params[0]) ? { x: 1 } : undefined;
            }
            return undefined;
        },
        all() {
            return [...rows].reverse();
        },
        run(sql, ...params) {
            if (sql.includes('ON CONFLICT') || sql.includes('INSERT INTO settings') || sql.includes('INSERT OR IGNORE INTO settings')) {
                settings.set(params[0], String(params[1]));
                return;
            }
            if (sql.includes('INSERT INTO store_transfers')) {
                if (rows.some((r) => r.invoice_no === params[1])) {
                    throw new Error('UNIQUE constraint failed');
                }
                rows.push({
                    transfer_id: params[0],
                    invoice_no: params[1],
                    store_date: params[2],
                    customer_name: params[3],
                    customer_number: params[4],
                    file_name: params[5],
                    created_at: params[6],
                    created_by: params[7],
                    line_items_json: params[8],
                    manifest_file_name: params[9],
                    storage_type: params[10],
                    pallets: params[11],
                    weight_kg: params[12],
                });
            }
        },
        transaction(fn) {
            return () => fn();
        },
        _rows: rows,
    };
    return db;
}

test('createStoreTransfer writes one combined workbook', async () => {
    const prev = process.env.TGP_DATA_DIR;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-st-'));
    process.env.TGP_DATA_DIR = tmp;
    try {
        const db = mockDb();
        const customers = await listTransferCustomers();
        const pick = customers.find((c) => c.number) || customers[0];
        const a = await createStoreTransfer(db, {
            customerName: pick.name,
            storeDate: '2026-07-21',
            actorName: 'Test User',
            storageType: 'Frozen',
            pallets: 2,
            weightKg: 55,
            lineItems: [{ item: 'Frozen Item', quantity: 4, cost: 9.25 }],
        });
        assert.equal(a.invoice_no, 'ST-000001');
        assert.equal(a.manifest_file_name, '');
        assert.equal(fs.existsSync(path.join(tmp, 'store-transfers', a.file_name)), true);
        assert.equal(fs.existsSync(path.join(tmp, 'store-transfers', 'ST-000001-manifest.xlsx')), false);

        const inv = new ExcelJS.Workbook();
        await inv.xlsx.readFile(path.join(tmp, 'store-transfers', a.file_name));
        assert.deepEqual(inv.worksheets.map((w) => w.name), ['Invoice', 'Manifest']);
        const invoice = inv.getWorksheet('Invoice');
        assert.equal(String(invoice.getCell('B16').value || ''), 'Frozen Item');
        assert.equal(Number(invoice.getCell('G16').value), 4);
        assert.equal(Number(invoice.getCell('E16').value), 9.25);
        const h16 = invoice.getCell('H16').value;
        assert.equal(typeof h16, 'object');
        assert.match(String(h16.formula || ''), /E16/);

        const b = await createStoreTransfer(db, {
            customerName: pick.name,
            storeDate: '2026-07-21',
            actorName: 'Test User',
            lineItems: [{ item: 'Dry Item', quantity: 1, cost: 3 }],
        });
        assert.equal(b.invoice_no, 'ST-000002');
        assert.notEqual(a.invoice_no, b.invoice_no);
        const found = searchStoreTransfers(db, { q: 'Frozen' });
        assert.ok(found.length >= 1);
    } finally {
        if (prev == null) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = prev;
    }
});
