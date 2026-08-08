'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const {
    enrichShrinkRows, shrinkReportCsv, shrinkReportHtml,
    analyzeFloorShrink, normalizeShrinkReason, parseShrinkImportCsv,
    parseShrinkImportUpload,
    createShrinkSession, closeShrinkSession, listShrinkSessions,
} = require('../src/lib/floor-shrink.cjs');

function makeDb() {
    const raw = new DatabaseSync(':memory:');
    const db = {
        exec: (sql) => raw.exec(sql),
        run: (sql, ...p) => raw.prepare(sql).run(...p),
        get: (sql, ...p) => raw.prepare(sql).get(...p),
        all: (sql, ...p) => raw.prepare(sql).all(...p),
    };
    require('../src/migrations/051_item_catalog.cjs').up(db);
    require('../src/migrations/052_item_catalog_prices.cjs').up(db);
    db.run(
        `INSERT INTO item_catalog
            (code, raw_code, description, department, retail_price, unit_cost, case_cost, case_qty, source, times_seen, first_seen, last_seen, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        '3700041537', '0003700041537', 'CASCADE DISH GEL', 'Grocery', 5.79, 4.18, 24.41, 6, 'csv', 1, 't', 't', 't',
    );
    db.run(
        `INSERT INTO item_catalog
            (code, raw_code, description, department, retail_price, unit_cost, case_cost, case_qty, source, times_seen, first_seen, last_seen, updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        '4131900001', '004131900001', '2% MILK 4L', 'Dairy', 6.49, 4.90, null, null, 'csv', 1, 't', 't', 't',
    );
    return { db, raw };
}

test('enrichShrinkRows multiplies catalog prices by quantity', () => {
    const { db, raw } = makeDb();
    const report = enrichShrinkRows(db, [
        { id: '1', sku: '0003700041537', item: '', quantity: 2, reason: 'Damaged', status: 'Open' },
        { id: '2', sku: '999999', item: 'UNKNOWN', quantity: 1, reason: '', status: 'Open' },
    ]);
    assert.equal(report.rows[0].line_retail, 11.58);
    assert.equal(report.rows[0].line_cost, 8.36);
    assert.equal(report.rows[0].status, 'Open');
    assert.equal(report.rows[0].department, 'Grocery');
    assert.equal(report.rows[1].priced, false);
    assert.equal(report.rows[1].department, 'Unassigned');
    assert.equal(report.totals.retail, 11.58);
    assert.equal(report.totals.cost, 8.36);
    assert.equal(report.totals.unpriced_lines, 1);
    const csv = shrinkReportCsv('2026-08-01', report);
    assert.match(csv, /CASCADE DISH GEL/);
    assert.match(csv, /11\.58/);
    assert.match(csv, /,Open,/);
    assert.match(csv, /Grocery/);
    assert.match(csv, /SUBTOTAL Grocery/);
    assert.match(csv, /GRAND TOTAL/);
    raw.close();
});

test('enrichShrinkRows breaks out retail and cost by department', () => {
    const { db, raw } = makeDb();
    const report = enrichShrinkRows(db, [
        { id: '1', sku: '0003700041537', item: '', quantity: 2, reason: 'Damaged', status: 'Open' },
        { id: '2', sku: '004131900001', item: '', quantity: 1, reason: 'Expired', status: 'Open' },
        { id: '3', sku: '999999', item: 'UNKNOWN', quantity: 3, reason: '', status: 'Open' },
    ]);

    assert.equal(report.departments.length, 3);
    const grocery = report.departments.find((d) => d.department === 'Grocery');
    const dairy = report.departments.find((d) => d.department === 'Dairy');
    const unassigned = report.departments.find((d) => d.department === 'Unassigned');
    assert.ok(grocery && dairy && unassigned);
    assert.equal(grocery.retail, 11.58);
    assert.equal(grocery.cost, 8.36);
    assert.equal(grocery.quantity, 2);
    assert.equal(dairy.retail, 6.49);
    assert.equal(dairy.cost, 4.9);
    assert.equal(unassigned.quantity, 3);
    assert.equal(unassigned.priced_lines, 0);
    assert.equal(report.totals.department_count, 2);
    assert.equal(report.totals.retail, 18.07);
    assert.equal(report.totals.cost, 13.26);

    // Unassigned sorts last; named depts alphabetical (Dairy before Grocery)
    assert.equal(report.departments[0].department, 'Dairy');
    assert.equal(report.departments[1].department, 'Grocery');
    assert.equal(report.departments[2].department, 'Unassigned');

    const csv = shrinkReportCsv('2026-08-01', report);
    assert.match(csv, /department,/);
    assert.match(csv, /SUBTOTAL Dairy/);
    assert.match(csv, /SUBTOTAL Grocery/);
    assert.match(csv, /SUBTOTAL Unassigned/);
    assert.match(csv, /GRAND TOTAL/);

    const html = shrinkReportHtml('2026-08-01', report);
    assert.match(html, /Floor Shrink by Department/);
    assert.match(html, /Department summary/);
    assert.match(html, /<h2>Dairy<\/h2>/);
    assert.match(html, /<h2>Grocery<\/h2>/);
    assert.match(html, /Dairy TOTAL/);
    assert.match(html, /GRAND TOTAL/);
    raw.close();
});

test('normalizeShrinkReason maps free text onto controlled buckets', () => {
    assert.equal(normalizeShrinkReason(''), 'Unspecified');
    assert.equal(normalizeShrinkReason('Damaged'), 'Damaged');
    assert.equal(normalizeShrinkReason('expired yogurt'), 'Outdated / Expired');
    assert.equal(normalizeShrinkReason('freezer burn'), 'Spoil / Quality');
    assert.equal(normalizeShrinkReason('weird custom note'), 'Other');
});

test('analyzeFloorShrink rolls up dept, reason, and top SKUs over a range', () => {
    const { db, raw } = makeDb();
    db.exec(`
        CREATE TABLE floor_shrink_sku (
            id TEXT PRIMARY KEY,
            store_date TEXT NOT NULL,
            sku TEXT NOT NULL DEFAULT '',
            item TEXT NOT NULL DEFAULT '',
            quantity REAL NOT NULL DEFAULT 1,
            reason TEXT NOT NULL DEFAULT '',
            zone TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT 'manual',
            logged_by TEXT NOT NULL DEFAULT '',
            time_logged TEXT NOT NULL,
            notes TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'Open',
            closed_at TEXT NOT NULL DEFAULT '',
            closed_by TEXT NOT NULL DEFAULT ''
        );
    `);
    db.run(
        `INSERT INTO floor_shrink_sku
            (id, store_date, sku, item, quantity, reason, zone, source, logged_by, time_logged, notes, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        'a', '2026-08-01', '0003700041537', '', 2, 'Damaged', '', 'manual', 'Alex', '2026-08-01T10:00:00Z', '', 'Closed',
    );
    db.run(
        `INSERT INTO floor_shrink_sku
            (id, store_date, sku, item, quantity, reason, zone, source, logged_by, time_logged, notes, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        'b', '2026-08-02', '004131900001', '', 1, 'expired', '', 'manual', 'Sam', '2026-08-02T11:00:00Z', '', 'Closed',
    );
    db.run(
        `INSERT INTO floor_shrink_sku
            (id, store_date, sku, item, quantity, reason, zone, source, logged_by, time_logged, notes, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        'c', '2026-08-02', '0003700041537', '', 1, 'Damaged', '', 'manual', 'Alex', '2026-08-02T12:00:00Z', '', 'Voided',
    );

    const analytics = analyzeFloorShrink(db, { start: '2026-08-01', end: '2026-08-02' });
    assert.equal(analytics.totals.line_count, 2);
    assert.equal(analytics.totals.financial_loss_cost, 13.26);
    assert.equal(analytics.totals.potential_loss_retail, 18.07);
    assert.ok(analytics.by_department.some((d) => d.department === 'Grocery'));
    assert.ok(analytics.by_reason.some((r) => r.reason === 'Damaged' && r.line_count === 1));
    assert.ok(analytics.by_reason.some((r) => r.reason === 'Outdated / Expired' && r.line_count === 1));
    assert.equal(analytics.top_skus[0].days_seen >= 1, true);
    assert.equal(analytics.coverage.reasoned_pct, 100);
    assert.equal(analytics.by_day.length, 2);
    assert.ok(analytics.by_logged_by.some((w) => w.logged_by === 'Alex'));
    raw.close();
});

test('parseShrinkImportUpload reads SMS bakery Inventory Count .xls', async () => {
    const filePath = 'C:\\SMS_EXPORT\\july27bakeryshrink.xls';
    if (!fs.existsSync(filePath)) {
        // Store-machine fixture; skip when not present in CI.
        return;
    }
    const contentBase64 = fs.readFileSync(filePath).toString('base64');
    const parsed = await parseShrinkImportUpload(path.basename(filePath), contentBase64);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.format, 'sms_inventory_count');
    assert.equal(parsed.store_date, '2026-07-27');
    assert.ok(parsed.candidates.length > 10);
    const white = parsed.candidates.find((c) => c.sku.includes('5564101230'));
    assert.ok(white);
    // COUNT Units = 1 (Variance TtlQty 15 is junk and must not be used)
    assert.equal(white.quantity, 1);
    assert.match(white.item, /WHITE SLICED/i);
});

test('parseShrinkImportCsv accepts old-way and TGP export shapes', () => {
    const oldWay = parseShrinkImportCsv(`upc,description,qty,reason,date
0003700041537,CASCADE,2,Damaged,2026-07-15
004131900001,MILK,1,Expired,2026-07-15
`);
    assert.equal(oldWay.ok, true);
    assert.equal(oldWay.candidates.length, 2);
    assert.equal(oldWay.candidates[0].store_date, '2026-07-15');
    assert.equal(oldWay.has_store_date_column, true);

    const tgp = parseShrinkImportCsv(`store_date,department,status,sku,item,quantity,reason,zone,unit_retail,unit_cost,line_retail,line_cost,logged_by,time_logged,catalog_code
2026-08-01,Grocery,Closed,0003700041537,CASCADE,2,Damaged,,5.79,4.18,11.58,8.36,Alex,t,3700041537
2026-08-01,SUBTOTAL Grocery,,,,,,,2,,,11.58,8.36,,,
2026-08-01,GRAND TOTAL,,,,,,,2,,,11.58,8.36,,,
`);
    assert.equal(tgp.ok, true);
    assert.equal(tgp.candidates.length, 1);
    assert.equal(tgp.candidates[0].zone, '');
});

test('shrink sessions can stay open concurrently after one is closed', () => {
    const { db, raw } = makeDb();
    require('../src/migrations/049_floor_shrink_sku.cjs').up(db);
    require('../src/migrations/053_floor_shrink_status.cjs').up(db);
    require('../src/migrations/054_floor_shrink_sessions.cjs').up(db);
    const a = createShrinkSession(db, {
        storeDate: '2026-08-01', label: 'Dairy', createdBy: 'Alex',
    });
    const b = createShrinkSession(db, {
        storeDate: '2026-08-01', label: 'Grocery', createdBy: 'Sam',
    });
    assert.equal(a.status, 'open');
    assert.equal(b.status, 'open');
    db.run(
        `INSERT INTO floor_shrink_sku
            (id, store_date, sku, item, quantity, reason, zone, source, logged_by, time_logged, notes, status, closed_at, closed_by, session_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        'x1', '2026-08-01', '0003700041537', '', 1, 'Damaged', '', 'manual', 'Alex', 't', '', 'Open', '', '', a.id,
    );
    const closed = closeShrinkSession(db, { sessionId: a.id, closedBy: 'Alex' });
    assert.equal(closed.ok, true);
    const list = listShrinkSessions(db, '2026-08-01');
    assert.equal(list.find((s) => s.id === a.id).status, 'closed');
    assert.equal(list.find((s) => s.id === b.id).status, 'open');
    raw.close();
});
