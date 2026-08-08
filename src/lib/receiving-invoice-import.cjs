'use strict';

const crypto = require('crypto');
const { extractMarkdownScanText } = require('./markdown-ocr-router.cjs');
const { parseReceivingDocumentText, roundMoney } = require('./receiving-invoice-parse.cjs');
const {
    normalizeStoreDate,
    saveLine,
    normalizeLineInput,
} = require('./edmonton-receiving-report.cjs');
const { parseMoneyOrThrow, parseOptionalMoneyOrThrow } = require('./parse-money.cjs');

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function decodeUpload(filename, contentBase64) {
    const safeName = String(filename || '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 160) || 'upload.pdf';
    const buf = Buffer.from(String(contentBase64 || ''), 'base64');
    if (!buf.length) {
        const err = new Error('Empty upload.');
        err.status = 400;
        throw err;
    }
    if (buf.length > MAX_UPLOAD_BYTES) {
        const err = new Error('Upload is too large. Maximum PDF/image size is 8 MB.');
        err.status = 400;
        throw err;
    }
    if (!/\.(pdf|png|jpe?g|webp|tif|tiff)$/i.test(safeName)) {
        const err = new Error('Upload must be a PDF or image (.pdf, .png, .jpg, .webp, .tif).');
        err.status = 400;
        throw err;
    }
    return { safeName, buf };
}

async function scanReceivingDocument(filename, contentBase64, opts = {}) {
    const { safeName } = decodeUpload(filename, contentBase64);
    const text = await extractMarkdownScanText(safeName, contentBase64);
    const parsed = parseReceivingDocumentText(text, opts);
    return {
        filename: safeName,
        ocrText: text,
        ...parsed,
    };
}

function mapShrinkRow(row) {
    return {
        shrink_id: row.shrink_id,
        store_date: row.store_date,
        line_id: row.line_id || '',
        source_doc: row.source_doc || 'manual',
        source_filename: row.source_filename || '',
        invoice_number: row.invoice_number || '',
        supplier_name: row.supplier_name || '',
        sku: row.sku || '',
        description: row.description || '',
        department: row.department || '',
        quantity: roundMoney(row.quantity ?? 1),
        unit_cost: row.unit_cost == null ? null : roundMoney(row.unit_cost),
        extended_cost: roundMoney(row.extended_cost),
        reason: row.reason || '',
        sort_order: Number(row.sort_order || 0),
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by: row.created_by || '',
        updated_by: row.updated_by || '',
    };
}

function listShrinkLines(db, storeDate) {
    const date = normalizeStoreDate(storeDate);
    return db.all(
        `SELECT * FROM receiving_shrink_lines
          WHERE store_date=?
          ORDER BY sort_order ASC, created_at ASC, shrink_id ASC`,
        date,
    ).map(mapShrinkRow);
}

function listShrinkLinesForLine(db, lineId) {
    return db.all(
        `SELECT * FROM receiving_shrink_lines
          WHERE line_id=?
          ORDER BY sort_order ASC, created_at ASC, shrink_id ASC`,
        String(lineId || ''),
    ).map(mapShrinkRow);
}

function nextShrinkSort(db, storeDate) {
    const row = db.get(
        'SELECT MAX(sort_order) AS max_sort FROM receiving_shrink_lines WHERE store_date=?',
        normalizeStoreDate(storeDate),
    );
    return Number(row?.max_sort || 0) + 1;
}

function saveShrinkLine(db, storeDate, raw = {}, actorName = '') {
    const date = normalizeStoreDate(storeDate);
    const shrinkId = String(raw.shrink_id || '').trim() || crypto.randomUUID();
    const now = new Date().toISOString();
    const existing = db.get('SELECT shrink_id FROM receiving_shrink_lines WHERE shrink_id=?', shrinkId);
    const payload = {
        line_id: String(raw.line_id || '').trim(),
        source_doc: String(raw.source_doc || 'manual').trim() || 'manual',
        source_filename: String(raw.source_filename || '').trim(),
        invoice_number: String(raw.invoice_number || '').trim(),
        supplier_name: String(raw.supplier_name || '').trim(),
        sku: String(raw.sku || '').trim(),
        description: String(raw.description || '').trim(),
        department: String(raw.department || 'grocery').trim().toLowerCase() || 'grocery',
        quantity: parseMoneyOrThrow(raw.quantity ?? 1, 'Quantity') || 1,
        unit_cost: parseOptionalMoneyOrThrow(raw.unit_cost, 'Unit cost'),
        extended_cost: parseMoneyOrThrow(raw.extended_cost, 'Extended cost'),
        reason: String(raw.reason || '').trim(),
    };

    if (existing) {
        db.run(
            `UPDATE receiving_shrink_lines SET
                line_id=?, source_doc=?, source_filename=?, invoice_number=?, supplier_name=?,
                sku=?, description=?, department=?, quantity=?, unit_cost=?, extended_cost=?,
                reason=?, updated_at=?, updated_by=?
              WHERE shrink_id=?`,
            payload.line_id, payload.source_doc, payload.source_filename, payload.invoice_number,
            payload.supplier_name, payload.sku, payload.description, payload.department,
            payload.quantity, payload.unit_cost, payload.extended_cost, payload.reason,
            now, actorName || '', shrinkId,
        );
    } else {
        const sortOrder = Number.isFinite(Number(raw.sort_order))
            ? Number(raw.sort_order)
            : nextShrinkSort(db, date);
        db.run(
            `INSERT INTO receiving_shrink_lines (
                shrink_id, store_date, line_id, source_doc, source_filename, invoice_number,
                supplier_name, sku, description, department, quantity, unit_cost, extended_cost,
                reason, sort_order, created_at, updated_at, created_by, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            shrinkId, date, payload.line_id, payload.source_doc, payload.source_filename,
            payload.invoice_number, payload.supplier_name, payload.sku, payload.description,
            payload.department, payload.quantity, payload.unit_cost, payload.extended_cost,
            payload.reason, sortOrder, now, now, actorName || '', actorName || '',
        );
    }
    return mapShrinkRow(db.get('SELECT * FROM receiving_shrink_lines WHERE shrink_id=?', shrinkId));
}

function deleteShrinkLine(db, shrinkId) {
    const id = String(shrinkId || '').trim();
    if (!id) {
        const err = new Error('shrink_id is required.');
        err.status = 400;
        throw err;
    }
    const row = db.get('SELECT shrink_id FROM receiving_shrink_lines WHERE shrink_id=?', id);
    if (!row) {
        const err = new Error('Shrink line not found.');
        err.status = 404;
        throw err;
    }
    db.run('DELETE FROM receiving_shrink_lines WHERE shrink_id=?', id);
    return { success: true, shrink_id: id };
}

function buildShrinkSummary(shrinkLines) {
    const byDepartment = {};
    const bySku = {};
    let total = 0;
    shrinkLines.forEach((line) => {
        const amt = roundMoney(line.extended_cost);
        total += amt;
        const dept = line.department || 'grocery';
        byDepartment[dept] = roundMoney((byDepartment[dept] || 0) + amt);
        const skuKey = line.sku || line.description || line.shrink_id;
        if (!bySku[skuKey]) {
            bySku[skuKey] = {
                sku: line.sku || '',
                description: line.description || '',
                department: dept,
                quantity: 0,
                extended_cost: 0,
                line_count: 0,
            };
        }
        bySku[skuKey].quantity = roundMoney(bySku[skuKey].quantity + Number(line.quantity || 0));
        bySku[skuKey].extended_cost = roundMoney(bySku[skuKey].extended_cost + amt);
        bySku[skuKey].line_count += 1;
    });
    return {
        total: roundMoney(total),
        line_count: shrinkLines.length,
        sku_count: Object.keys(bySku).length,
        by_department: byDepartment,
        by_sku: Object.values(bySku).sort((a, b) => Math.abs(b.extended_cost) - Math.abs(a.extended_cost)),
    };
}

function commitReceivingImport(db, storeDate, payload = {}, actorName = '') {
    const date = normalizeStoreDate(storeDate);
    const invoiceRaw = payload.invoice || payload.invoice_candidate || {};
    const shrinkRows = Array.isArray(payload.shrink_lines)
        ? payload.shrink_lines
        : (Array.isArray(payload.shrink_candidates) ? payload.shrink_candidates : []);
    const filename = String(payload.filename || '').trim();
    const importId = crypto.randomUUID();
    const now = new Date().toISOString();

    let savedLine = null;
    if (invoiceRaw && (invoiceRaw.invoice_number || invoiceRaw.supplier_name || shrinkRows.length)) {
        const normalized = normalizeLineInput({
            ...invoiceRaw,
            line_kind: invoiceRaw.line_kind || (Number(invoiceRaw.total_invoice) < 0 ? 'write_off' : 'invoice'),
        });
        savedLine = saveLine(db, date, normalized, actorName);
    }

    const savedShrink = [];
    shrinkRows.forEach((row) => {
        savedShrink.push(saveShrinkLine(db, date, {
            ...row,
            line_id: savedLine?.line_id || row.line_id || '',
            source_doc: 'pdf_import',
            source_filename: filename,
            invoice_number: row.invoice_number || savedLine?.invoice_number || invoiceRaw.invoice_number || '',
            supplier_name: row.supplier_name || savedLine?.supplier_name || invoiceRaw.supplier_name || '',
        }, actorName));
    });

    db.run(
        `INSERT INTO receiving_invoice_imports
            (import_id, store_date, filename, doc_type, line_id, shrink_count, ocr_chars, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        importId,
        date,
        filename,
        String(payload.doc_type || 'auto'),
        savedLine?.line_id || '',
        savedShrink.length,
        Number(payload.ocr_chars || 0),
        now,
        actorName || '',
    );

    return {
        import_id: importId,
        line: savedLine,
        shrink_lines: savedShrink,
        shrink_summary: buildShrinkSummary(savedShrink),
    };
}

module.exports = {
    MAX_UPLOAD_BYTES,
    scanReceivingDocument,
    listShrinkLines,
    listShrinkLinesForLine,
    saveShrinkLine,
    deleteShrinkLine,
    buildShrinkSummary,
    commitReceivingImport,
};
