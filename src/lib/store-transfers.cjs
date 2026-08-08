'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ExcelJS = require('exceljs');
const { getDataRoot } = require('../paths.cjs');
const { upsertSetting } = require('./settings-store.cjs');
const { readSpreadsheetFile } = require('./spreadsheet-read.cjs');

const SETTING_ENABLED = 'Store_Transfers_Enabled';
const SETTING_SEQ = 'Store_Transfer_Invoice_Seq';

/** Invoice sheet line rows — first editable row is 16 (headers on row 10; meat subtotal @ 15). */
const REC_ITEM_ROWS = [16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];

const STORAGE_OPTIONS = ['Cooler', 'Dry', 'Frozen'];

/** Default template upcharge (hidden col F). Price H = Cost*(1+F) via =E*F+E. */
const DEFAULT_UPCHARGE = 0.0725;

/**
 * Store-transfer invoice cost→upcharge→price applies only to these destinations
 * (matches Customers sheet names, including template spelling "Llyodminster").
 */
const COST_UPCHARGE_CUSTOMER_RES = [
    /\bhigh\s*prairie\b/i,
    /\b(?:lloyd|llyod)minster\b/i,
    /\bhigh\s*level\b/i,
    /\bkamloops\b/i,
    /\bjasper\b/i,
];

function customerUsesCostUpcharge(customerName) {
    const s = String(customerName || '').trim();
    if (!s) return false;
    return COST_UPCHARGE_CUSTOMER_RES.some((re) => re.test(s));
}

/**
 * Mirrors the template's `=E*F+E`, which is the authority for the printed invoice
 * (verifyInvoiceBuffer refuses to write Price as a typed value). Kept at sub-cent
 * precision on purpose: rounding the unit price to cents here made the cached result
 * disagree with what Excel recomputes the moment the file is opened. The 4-decimal
 * round only strips binary float noise (10 * 1.0725 → 10.725000000000001).
 */
function unitPriceFromCost(cost, upcharge = DEFAULT_UPCHARGE) {
    const c = Number(cost);
    const u = Number(upcharge);
    if (!Number.isFinite(c) || !Number.isFinite(u)) return null;
    return Math.round((c + c * u) * 10000) / 10000;
}

function templatePath() {
    return path.join(__dirname, '..', '..', 'store-templates', 'default', 'Template-Rec-Document.xlsx');
}

/** Formatted .xlsx (Excel-saved from Template-Manifest.xls) — preserves layout/styles. */
function manifestTemplatePath() {
    return path.join(__dirname, '..', '..', 'store-templates', 'default', 'Template-Manifest.xlsx');
}

function transfersDir() {
    const dir = path.join(getDataRoot(), 'store-transfers');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function isStoreTransfersEnabled(settingsOrDb) {
    let val = '';
    if (settingsOrDb && typeof settingsOrDb.get === 'function' && !settingsOrDb.Store_Transfers_Enabled) {
        val = settingsOrDb.get(
            "SELECT setting_value FROM settings WHERE setting_name=?",
            SETTING_ENABLED,
        )?.setting_value;
    } else if (settingsOrDb && typeof settingsOrDb === 'object') {
        val = settingsOrDb[SETTING_ENABLED];
    }
    return String(val || '0') === '1';
}

function requireEnabled(db) {
    if (!isStoreTransfersEnabled(db)) {
        const err = new Error('Store transfers are disabled. Enable the toggle in Manager Settings to test.');
        err.status = 403;
        throw err;
    }
}

/**
 * Customers sheet from the Rec template — source for the dropdown only.
 * Never included in generated transfer documents (Manifest replaces it).
 * By default only returns High Prairie / Lloydminster / Jasper / High Level / Kamloops
 * (stores that use hidden Cost + upcharge → Price).
 */
async function listTransferCustomers(opts = {}) {
    const file = templatePath();
    if (!fs.existsSync(file)) {
        const err = new Error('Store transfer template is missing (Template-Rec-Document.xlsx).');
        err.status = 500;
        throw err;
    }
    const wb = await readSpreadsheetFile(file);
    const sheet = wb.sheets.find((s) => /^customers$/i.test(s.name))
        || wb.sheets.find((s) => /customer/i.test(s.name));
    if (!sheet) return [];
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const out = [];
    const seen = new Set();
    const onlyCostUpcharge = opts.all !== true;
    for (const row of rows) {
        const name = String(row?.[0] || '').trim();
        if (!name) continue;
        if (onlyCostUpcharge && !customerUsesCostUpcharge(name)) continue;
        const number = String(row?.[1] ?? '').trim();
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, number, pricing: 'cost_upcharge' });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return out;
}

function nextInvoiceNo(db) {
    return db.transaction(() => {
        const row = db.get("SELECT setting_value FROM settings WHERE setting_name=?", SETTING_SEQ);
        let seq = Number(row?.setting_value || 0);
        if (!Number.isFinite(seq) || seq < 0) seq = 0;
        for (let attempt = 0; attempt < 20; attempt += 1) {
            seq += 1;
            const invoiceNo = `ST-${String(seq).padStart(6, '0')}`;
            const clash = db.get('SELECT 1 AS x FROM store_transfers WHERE invoice_no=?', invoiceNo);
            if (!clash) {
                upsertSetting(db, SETTING_SEQ, String(seq));
                return invoiceNo;
            }
        }
        const err = new Error('Could not allocate a unique invoice number.');
        err.status = 500;
        throw err;
    })();
}

function storeDateToJsDate(storeDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(storeDate || ''))) return null;
    const [y, m, d] = String(storeDate).split('-').map(Number);
    return new Date(y, m - 1, d);
}

/**
 * Normalize line items from the REC form.
 * Cost-upcharge stores: product name, quantity, cost (hidden E → Price via template).
 */
function normalizeLineItems(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const row of list) {
        const item = String(row?.item || row?.product || row?.name || '').trim();
        const qty = Number(row?.quantity ?? row?.qty);
        // Accept cost (preferred) or legacy price field as cost for these stores.
        const costRaw = row?.cost ?? row?.price;
        const cost = Number(costRaw);
        if (!item && !Number.isFinite(qty) && !Number.isFinite(cost)) continue;
        if (!item) {
            const err = new Error('Each line needs a product name.');
            err.status = 400;
            throw err;
        }
        if (!Number.isFinite(qty) || qty <= 0) {
            const err = new Error(`Quantity required for "${item}".`);
            err.status = 400;
            throw err;
        }
        if (!Number.isFinite(cost) || cost < 0) {
            const err = new Error(`Cost required for "${item}" (template calculates Price from Cost + upcharge).`);
            err.status = 400;
            throw err;
        }
        const unitPrice = unitPriceFromCost(cost, DEFAULT_UPCHARGE);
        out.push({
            order_no: String(row?.order_no || row?.order || '').trim(),
            item,
            quantity: qty,
            cost,
            /** Computed sell price after upcharge — for preview / J result only. */
            price: unitPrice,
            code: String(row?.code || '').trim(),
            dep_case: row?.dep_case === '' || row?.dep_case == null ? null : Number(row.dep_case),
        });
    }
    if (!out.length) {
        const err = new Error('Add at least one product line (name, quantity, cost).');
        err.status = 400;
        throw err;
    }
    if (out.length > REC_ITEM_ROWS.length) {
        const err = new Error(`Too many lines (max ${REC_ITEM_ROWS.length}).`);
        err.status = 400;
        throw err;
    }
    return out;
}

function normalizeStorageType(raw) {
    const s = String(raw || 'Cooler').trim();
    const hit = STORAGE_OPTIONS.find((o) => o.toLowerCase() === s.toLowerCase());
    return hit || 'Cooler';
}

function storageCode(storageType) {
    const s = normalizeStorageType(storageType);
    if (s === 'Dry') return 'D';
    if (s === 'Frozen') return 'F';
    return 'C';
}

function clearTemplateDemoRows(rec) {
    for (const rowNum of [11, 12, 13, 14]) {
        for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
            setInvoiceScalarCell(rec.getCell(`${col}${rowNum}`), null);
        }
    }
}

function setInvoiceScalarCell(cell, value) {
    cell.value = null;
    if (typeof value === 'number' && Number.isFinite(value)) {
        cell.value = value;
        return;
    }
    if (value != null && String(value).trim() !== '') {
        cell.value = String(value);
    }
}

function resetInvoiceBodyRowFormulas(rec, rowNum, { upchargeAnchorRow } = {}) {
    // Hidden F (upcharge) + visible H (Price = Cost + upcharge). Never stamp Price as a plain value.
    const fCell = rec.getCell(`F${rowNum}`);
    if (upchargeAnchorRow && rowNum !== upchargeAnchorRow) {
        fCell.value = { formula: `$F$${upchargeAnchorRow}`, result: DEFAULT_UPCHARGE };
    } else {
        fCell.value = DEFAULT_UPCHARGE;
    }
    const h = rec.getCell(`H${rowNum}`);
    h.value = { formula: `E${rowNum}*F${rowNum}+E${rowNum}`, result: 0 };
    rec.getCell(`I${rowNum}`).value = { formula: `D${rowNum}*G${rowNum}`, result: 0 };
    rec.getCell(`J${rowNum}`).value = { formula: `(G${rowNum}*H${rowNum})+I${rowNum}`, result: 0 };
}

function prepareInvoiceBody(rec) {
    const anchor = REC_ITEM_ROWS[0];
    for (const rowNum of REC_ITEM_ROWS) {
        for (const col of ['A', 'B', 'G']) {
            setInvoiceScalarCell(rec.getCell(`${col}${rowNum}`), null);
        }
        setInvoiceScalarCell(rec.getCell(`E${rowNum}`), null);
        resetInvoiceBodyRowFormulas(rec, rowNum, { upchargeAnchorRow: anchor });
    }
}

function prepareInvoiceLineRow(rec, rowNum) {
    // Template hides some body rows (e.g. 17–19); unhide any row we populate.
    rec.getRow(rowNum).hidden = false;
}

function writeRecLineItems(rec, lineItems) {
    clearTemplateDemoRows(rec);
    prepareInvoiceBody(rec);
    const anchor = REC_ITEM_ROWS[0];
    let extendedTotal = 0;
    lineItems.forEach((line, idx) => {
        const rowNum = REC_ITEM_ROWS[idx];
        prepareInvoiceLineRow(rec, rowNum);
        if (line.order_no) setInvoiceScalarCell(rec.getCell(`A${rowNum}`), line.order_no);
        setInvoiceScalarCell(rec.getCell(`B${rowNum}`), line.item);
        setInvoiceScalarCell(rec.getCell(`G${rowNum}`), line.quantity);
        // Hidden Cost (E) — Price (H) stays formula =E*F+E.
        setInvoiceScalarCell(rec.getCell(`E${rowNum}`), line.cost);
        resetInvoiceBodyRowFormulas(rec, rowNum, { upchargeAnchorRow: anchor });
        const unitPrice = unitPriceFromCost(line.cost, DEFAULT_UPCHARGE);
        const lineExt = Math.round(Number(line.quantity) * Number(unitPrice) * 100) / 100;
        extendedTotal += lineExt;
        rec.getCell(`H${rowNum}`).value = {
            formula: `E${rowNum}*F${rowNum}+E${rowNum}`,
            result: unitPrice,
        };
        rec.getCell(`J${rowNum}`).value = {
            formula: `(G${rowNum}*H${rowNum})+I${rowNum}`,
            result: lineExt,
        };
    });
    rec.getCell('J39').value = Math.round(extendedTotal * 100) / 100;
}

async function verifyInvoiceBuffer(buf, lineItems) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const invoice = wb.getWorksheet('Invoice');
    if (!invoice) {
        const err = new Error('Generated workbook is missing the Invoice sheet.');
        err.status = 500;
        throw err;
    }
    lineItems.forEach((line, idx) => {
        const rowNum = REC_ITEM_ROWS[idx];
        const got = String(invoice.getCell(`B${rowNum}`).value || '').trim();
        if (got !== line.item) {
            const err = new Error(`Invoice line ${idx + 1} did not save to row ${rowNum}.`);
            err.status = 500;
            throw err;
        }
        const cost = Number(invoice.getCell(`E${rowNum}`).value);
        if (cost !== Number(line.cost)) {
            const err = new Error(`Invoice cost missing on row ${rowNum}.`);
            err.status = 500;
            throw err;
        }
        const hVal = invoice.getCell(`H${rowNum}`).value;
        const hFormula = typeof hVal === 'object' && hVal && hVal.formula
            ? String(hVal.formula)
            : '';
        if (!hFormula || !hFormula.includes(`E${rowNum}`) || !hFormula.includes(`F${rowNum}`)) {
            const err = new Error(`Invoice Price on row ${rowNum} must stay a Cost×upcharge formula, not a typed price.`);
            err.status = 500;
            throw err;
        }
        if (typeof hVal === 'number') {
            const err = new Error(`Invoice Price on row ${rowNum} was written as a number — Cost/upcharge formulas required.`);
            err.status = 500;
            throw err;
        }
        const unitPrice = unitPriceFromCost(line.cost, DEFAULT_UPCHARGE);
        const wantExt = Math.round(Number(line.quantity) * Number(unitPrice) * 100) / 100;
        const ext = invoice.getCell(`J${rowNum}`).result ?? invoice.getCell(`J${rowNum}`).value;
        if (Number(ext) !== wantExt) {
            const err = new Error(`Invoice extended price missing on row ${rowNum}.`);
            err.status = 500;
            throw err;
        }
    });
}

function copyCellStyle(from, to) {
    if (from.numFmt) to.numFmt = from.numFmt;
    if (from.font && Object.keys(from.font).length) to.font = { ...from.font };
    if (from.alignment && Object.keys(from.alignment).length) to.alignment = { ...from.alignment };
    if (from.border && Object.keys(from.border).length) {
        to.border = JSON.parse(JSON.stringify(from.border));
    }
    if (from.fill && from.fill.type) {
        to.fill = JSON.parse(JSON.stringify(from.fill));
    }
    if (from.protection && Object.keys(from.protection).length) {
        to.protection = { ...from.protection };
    }
}

/** Clone a worksheet into another workbook (styles/merges/widths preserved). */
function appendSheetClone(targetWb, sourceSheet, newName) {
    const dst = targetWb.addWorksheet(newName);
    sourceSheet.columns.forEach((col, idx) => {
        if (!col) return;
        const c = dst.getColumn(idx + 1);
        if (col.width != null) c.width = col.width;
        if (col.hidden != null) c.hidden = col.hidden;
    });
    sourceSheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        const newRow = dst.getRow(rowNumber);
        if (row.height != null) newRow.height = row.height;
        if (row.hidden != null) newRow.hidden = row.hidden;
        row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const nc = newRow.getCell(colNumber);
            nc.value = cell.value;
            copyCellStyle(cell, nc);
        });
    });
    for (const m of sourceSheet.model?.merges || []) {
        try { dst.mergeCells(m); } catch (_) { /* ignore */ }
    }
    if (sourceSheet.properties) Object.assign(dst.properties, sourceSheet.properties);
    if (sourceSheet.pageSetup) dst.pageSetup = { ...sourceSheet.pageSetup };
    if (sourceSheet.views?.length) {
        dst.views = JSON.parse(JSON.stringify(sourceSheet.views));
    }
    return dst;
}

function fillManifestSheet(sheet, {
    invoiceNo,
    customerName,
    customerNumber,
    storageType,
    pieces,
    pallets,
    weightKg,
}) {
    // B6 (delivery date) is left blank — trucking schedules it later.

    // First data row under the header (row 23). Leave M:N customer lookup alone.
    const row = 23;
    sheet.getCell(`A${row}`).value = customerNumber || '';
    sheet.getCell(`B${row}`).value = invoiceNo;
    sheet.getCell(`C${row}`).value = customerName;
    sheet.getCell(`D${row}`).value = normalizeStorageType(storageType);
    if (pieces != null && Number.isFinite(Number(pieces))) {
        sheet.getCell(`E${row}`).value = Number(pieces);
    }
    sheet.getCell(`F${row}`).value = '7:00 AM';
    if (pallets != null && Number.isFinite(Number(pallets))) {
        sheet.getCell(`G${row}`).value = Number(pallets);
    }
    if (weightKg != null && Number.isFinite(Number(weightKg))) {
        sheet.getCell(`H${row}`).value = Number(weightKg);
    }
}

async function loadFilledManifestWorkbook(opts) {
    const file = manifestTemplatePath();
    if (!fs.existsSync(file)) {
        const err = new Error('Manifest template is missing (Template-Manifest.xlsx).');
        err.status = 500;
        throw err;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const sheet = wb.worksheets[0];
    if (!sheet) {
        const err = new Error('Manifest template has no sheet.');
        err.status = 500;
        throw err;
    }
    fillManifestSheet(sheet, opts);
    return { wb, sheet };
}

/**
 * Build transfer workbook (Invoice + Manifest tabs) from templates.
 * Customers sheet is removed; Rec is renamed Invoice.
 */
async function buildTransferWorkbookBuffer({
    invoiceNo,
    storeDate,
    customerName,
    customerNumber,
    lineItems,
    storageType,
    pieces,
    pallets,
    weightKg,
}) {
    const file = templatePath();
    if (!fs.existsSync(file)) {
        const err = new Error('Store transfer template is missing (Template-Rec-Document.xlsx).');
        err.status = 500;
        throw err;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const rec = wb.getWorksheet('Rec');
    if (!rec) {
        const err = new Error('Template is missing the Rec sheet.');
        err.status = 500;
        throw err;
    }
    rec.name = 'Invoice';

    rec.getCell('I1').value = invoiceNo;
    const dt = storeDateToJsDate(storeDate);
    if (dt) {
        const h2 = rec.getCell('H2');
        h2.value = dt;
        if (!h2.numFmt || h2.numFmt === 'General') {
            h2.numFmt = '[$-F800]dddd, mmmm dd, yyyy';
        }
    } else {
        rec.getCell('H2').value = String(storeDate || '');
    }
    rec.getCell('G5').value = customerName;
    rec.getCell('I4').value = customerNumber || '';
    writeRecLineItems(rec, lineItems || []);

    const customers = wb.getWorksheet('Customers');
    if (customers) wb.removeWorksheet(customers.id);

    const { sheet: manSheet } = await loadFilledManifestWorkbook({
        invoiceNo,
        customerName,
        customerNumber,
        storageType,
        pieces,
        pallets,
        weightKg,
    });
    appendSheetClone(wb, manSheet, 'Manifest');

    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}

/**
 * Build standalone shipping manifest from Template-Manifest.xlsx.
 * Leaves the M:N customer lookup columns untouched.
 */
async function buildManifestWorkbookBuffer(opts) {
    const { wb } = await loadFilledManifestWorkbook(opts);
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
}

async function createStoreTransfer(db, {
    customerName,
    customerNumber,
    storeDate,
    actorName,
    lineItems: rawLines,
    storageType,
    pallets,
    weightKg,
}) {
    requireEnabled(db);
    const name = String(customerName || '').trim();
    if (!name) {
        const err = new Error('Choose a customer from the list.');
        err.status = 400;
        throw err;
    }
    const customers = await listTransferCustomers();
    const match = customers.find((c) => c.name === name)
        || customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (!match) {
        const err = new Error('Customer must be selected from the Templates customers list.');
        err.status = 400;
        throw err;
    }
    if (!customerUsesCostUpcharge(match.name)) {
        const err = new Error(
            'Store transfers with Cost + upcharge pricing are only for High Prairie, Lloydminster, Jasper, High Level, and Kamloops.',
        );
        err.status = 400;
        throw err;
    }
    const number = String(customerNumber != null && String(customerNumber).trim()
        ? customerNumber
        : match.number || '').trim();
    const stamp = String(storeDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp)) {
        const err = new Error('Invalid store date.');
        err.status = 400;
        throw err;
    }

    const lineItems = normalizeLineItems(rawLines);
    const storage = normalizeStorageType(storageType);
    const pieces = lineItems.reduce((sum, l) => sum + Number(l.quantity || 0), 0);
    const palletCount = pallets === '' || pallets == null ? null : Number(pallets);
    const weight = weightKg === '' || weightKg == null ? null : Number(weightKg);
    if (palletCount != null && (!Number.isFinite(palletCount) || palletCount < 0)) {
        const err = new Error('Pallets must be a number.');
        err.status = 400;
        throw err;
    }
    if (weight != null && (!Number.isFinite(weight) || weight < 0)) {
        const err = new Error('Weight (kg) must be a number.');
        err.status = 400;
        throw err;
    }

    const invoiceNo = nextInvoiceNo(db);
    const transferId = `STX-${crypto.randomUUID()}`;
    const fileName = `${invoiceNo}.xlsx`;
    const absPath = path.join(transfersDir(), fileName);

    const commonDoc = {
        invoiceNo,
        storeDate: stamp,
        customerName: match.name,
        customerNumber: number,
        storageType: storage,
        pieces,
        pallets: palletCount,
        weightKg: weight,
    };
    const invoiceBuf = await buildTransferWorkbookBuffer({
        ...commonDoc,
        lineItems,
    });
    await verifyInvoiceBuffer(invoiceBuf, lineItems);
    fs.writeFileSync(absPath, invoiceBuf);

    const createdAt = new Date().toISOString();
    const lineJson = JSON.stringify(lineItems);
    try {
        db.run(
            `INSERT INTO store_transfers
             (transfer_id, invoice_no, store_date, customer_name, customer_number, file_name,
              created_at, created_by, line_items_json, manifest_file_name, storage_type, pallets, weight_kg)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            transferId,
            invoiceNo,
            stamp,
            match.name,
            number,
            fileName,
            createdAt,
            String(actorName || '').trim(),
            lineJson,
            '',
            storage,
            palletCount,
            weight,
        );
    } catch (e) {
        try { fs.unlinkSync(absPath); } catch (_) { /* ignore */ }
        if (String(e.message || '').includes('UNIQUE')) {
            const err = new Error('Invoice number collision — try again.');
            err.status = 409;
            throw err;
        }
        // Older DB without new columns — fall back to original insert shape.
        if (String(e.message || '').includes('no such column')) {
            db.run(
                `INSERT INTO store_transfers
                 (transfer_id, invoice_no, store_date, customer_name, customer_number, file_name, created_at, created_by)
                 VALUES (?,?,?,?,?,?,?,?)`,
                transferId,
                invoiceNo,
                stamp,
                match.name,
                number,
                fileName,
                createdAt,
                String(actorName || '').trim(),
            );
        } else {
            throw e;
        }
    }

    return {
        transfer_id: transferId,
        invoice_no: invoiceNo,
        store_date: stamp,
        customer_name: match.name,
        customer_number: number,
        file_name: fileName,
        manifest_file_name: '',
        storage_type: storage,
        pallets: palletCount,
        weight_kg: weight,
        line_items: lineItems,
        pieces,
        created_at: createdAt,
        created_by: String(actorName || '').trim(),
    };
}

function searchStoreTransfers(db, { q = '', date = '', limit = 100 } = {}) {
    requireEnabled(db);
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const needle = String(q || '').trim();
    const day = String(date || '').trim();
    const params = [];
    let sql = `SELECT transfer_id, invoice_no, store_date, customer_name, customer_number,
                      file_name, manifest_file_name, storage_type, pallets, weight_kg,
                      line_items_json, created_at, created_by
               FROM store_transfers WHERE 1=1`;
    if (day) {
        sql += ' AND store_date = ?';
        params.push(day);
    }
    if (needle) {
        sql += ` AND (
            invoice_no LIKE ? OR customer_name LIKE ? OR customer_number LIKE ?
            OR created_by LIKE ? OR file_name LIKE ? OR IFNULL(manifest_file_name,'') LIKE ?
            OR IFNULL(line_items_json,'') LIKE ?
        )`;
        const like = `%${needle}%`;
        params.push(like, like, like, like, like, like, like);
    }
    sql += ' ORDER BY datetime(created_at) DESC LIMIT ?';
    params.push(lim);
    try {
        return db.all(sql, ...params);
    } catch (e) {
        if (!String(e.message || '').includes('no such column')) throw e;
        // Pre-038 schema
        sql = `SELECT transfer_id, invoice_no, store_date, customer_name, customer_number,
                      file_name, created_at, created_by
               FROM store_transfers WHERE 1=1`;
        const p2 = [];
        if (day) { sql += ' AND store_date = ?'; p2.push(day); }
        if (needle) {
            sql += ` AND (invoice_no LIKE ? OR customer_name LIKE ? OR customer_number LIKE ? OR created_by LIKE ? OR file_name LIKE ?)`;
            const like = `%${needle}%`;
            p2.push(like, like, like, like, like);
        }
        sql += ' ORDER BY datetime(created_at) DESC LIMIT ?';
        p2.push(lim);
        return db.all(sql, ...p2);
    }
}

function getStoreTransfer(db, transferId) {
    requireEnabled(db);
    const id = String(transferId || '').trim();
    if (!id) return null;
    try {
        return db.get(
            `SELECT transfer_id, invoice_no, store_date, customer_name, customer_number,
                    file_name, manifest_file_name, storage_type, pallets, weight_kg,
                    line_items_json, created_at, created_by
             FROM store_transfers WHERE transfer_id = ?`,
            id,
        ) || null;
    } catch (e) {
        if (!String(e.message || '').includes('no such column')) throw e;
        return db.get(
            `SELECT transfer_id, invoice_no, store_date, customer_name, customer_number,
                    file_name, created_at, created_by
             FROM store_transfers WHERE transfer_id = ?`,
            id,
        ) || null;
    }
}

function resolveTransferFilePath(row, kind = 'invoice') {
    if (!row) return null;
    const wantManifest = String(kind || '').toLowerCase() === 'manifest';
    const manifestName = String(row.manifest_file_name || '').trim();
    const invoiceName = String(row.file_name || '').trim();
    // New transfers use one workbook (Invoice + Manifest tabs). Older rows may have a separate manifest file.
    const name = wantManifest && manifestName ? manifestName : invoiceName;
    if (!name) return null;
    const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe || safe !== name) return null;
    const abs = path.join(transfersDir(), safe);
    if (!fs.existsSync(abs)) return null;
    return abs;
}

module.exports = {
    SETTING_ENABLED,
    SETTING_SEQ,
    REC_ITEM_ROWS,
    STORAGE_OPTIONS,
    DEFAULT_UPCHARGE,
    templatePath,
    manifestTemplatePath,
    transfersDir,
    isStoreTransfersEnabled,
    customerUsesCostUpcharge,
    unitPriceFromCost,
    listTransferCustomers,
    nextInvoiceNo,
    normalizeLineItems,
    buildTransferWorkbookBuffer,
    buildManifestWorkbookBuffer,
    createStoreTransfer,
    searchStoreTransfers,
    getStoreTransfer,
    resolveTransferFilePath,
    storageCode,
};
