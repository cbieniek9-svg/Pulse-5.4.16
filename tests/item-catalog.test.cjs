'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const ExcelJS = require('exceljs');

const {
    normalizeCode, lookupItem, searchItems, upsertItem, linkAlias,
    learnFromEntry, backfillFromHistory, importItemCsv, importItemUpload, catalogStats,
    upcCheckDigit, codeCandidates, catalogRowIssue, purgeCatalogJunk,
    extractVendorItemCode, parseMoney, importItemTable, resolveDepartment,
} = require('../src/lib/item-catalog.cjs');

/** Build an .xlsx buffer from named sheets of AOA data (replaces SheetJS .xls writers). */
async function buildCatalogXlsx(sheets) {
    const wb = new ExcelJS.Workbook();
    for (const { name, rows } of sheets) {
        const ws = wb.addWorksheet(name);
        for (const row of rows) {
            if (!row || !row.length) ws.addRow([]);
            else ws.addRow(row);
        }
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Minimal stand-in for the app db wrapper, backed by a real in-memory SQLite. */
function makeDb() {
    const raw = new DatabaseSync(':memory:');
    const db = {
        exec: (sql) => raw.exec(sql),
        run: (sql, ...params) => raw.prepare(sql).run(...params),
        get: (sql, ...params) => raw.prepare(sql).get(...params),
        all: (sql, ...params) => raw.prepare(sql).all(...params),
        transaction: (fn) => () => {
            raw.exec('BEGIN');
            try { fn(); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; }
        },
    };
    require('../src/migrations/051_item_catalog.cjs').up(db);
    require('../src/migrations/052_item_catalog_prices.cjs').up(db);
    return db;
}

test('normalizeCode ignores punctuation, case and leading zeros', () => {
    assert.equal(normalizeCode(' 064-29609 '), '6429609');
    assert.equal(normalizeCode('6429609'), '6429609');
    assert.equal(normalizeCode('ab-12 cd'), 'AB12CD');
    assert.equal(normalizeCode('  '), '');
    assert.equal(normalizeCode('000'), '0');
});

test('resolveDepartment maps SMS S.Dept numbers to major names', () => {
    assert.equal(resolveDepartment('1'), 'Grocery');
    assert.equal(resolveDepartment('5'), 'Dairy');
    assert.equal(resolveDepartment('22'), 'Produce');
    assert.equal(resolveDepartment('53'), 'Dairy Milk');
    assert.equal(resolveDepartment('3- Health & Beauty Aids'), 'Health & Beauty Aids');
    assert.equal(resolveDepartment('41'), 'Dept 41');
    assert.equal(resolveDepartment(''), '');
});

test('upsertItem creates then counts repeat sightings', () => {
    const db = makeDb();
    const first = upsertItem(db, { code: '6429609', description: 'English Muffins', zone: 'A1' });
    assert.equal(first.created, true);

    const second = upsertItem(db, { code: '06429609', description: '' });
    assert.equal(second.created, false);

    const row = lookupItem(db, '6429609');
    assert.equal(row.description, 'English Muffins');
    assert.equal(row.times_seen, 2);
    assert.equal(row.matched_via, 'code');
});

test('a blank description never wipes a known one, but a CSV description replaces a learned one', () => {
    const db = makeDb();
    upsertItem(db, { code: '111', description: 'Rough Floor Name' });
    upsertItem(db, { code: '111', description: '' });
    assert.equal(lookupItem(db, '111').description, 'Rough Floor Name');

    upsertItem(db, { code: '111', description: 'Official Head Office Name', source: 'csv' });
    assert.equal(lookupItem(db, '111').description, 'Official Head Office Name');

    // A later floor entry must not undo the authoritative name.
    upsertItem(db, { code: '111', description: 'typo nmae', source: 'learned' });
    assert.equal(lookupItem(db, '111').description, 'Official Head Office Name');
});

test('linkAlias maps a scanned UPC onto the shelf-tag item', () => {
    const db = makeDb();
    upsertItem(db, { code: '6429609', description: 'English Muffins' });
    assert.equal(linkAlias(db, '0 12345 67890 5', '6429609'), true);

    const hit = lookupItem(db, '12345678905');
    assert.equal(hit.description, 'English Muffins');
    assert.equal(hit.matched_via, 'alias');

    // Refuses to alias onto a missing item, or to shadow a real item.
    assert.equal(linkAlias(db, '999', 'nope'), false);
    upsertItem(db, { code: '777', description: 'Other' });
    assert.equal(linkAlias(db, '777', '6429609'), false);
});

test('linkAlias merge folds a barcode that was learned as its own product', () => {
    const db = makeDb();
    upsertItem(db, { code: '309724', description: 'C.GOLD KETCHUP', source: 'csv' });
    // The same ketchup, learned separately when someone scanned the package.
    upsertItem(db, { code: '5731609764', description: 'CO-OP GOLD KETCHUP 1L', zone: 'A12' });
    assert.equal(catalogStats(db).total, 2);

    // Without merge the correction is refused, which is what left duplicates behind.
    assert.equal(linkAlias(db, '5731609764', '309724'), false);

    assert.equal(linkAlias(db, '5731609764', '309724', { merge: true }), true);
    assert.equal(catalogStats(db).total, 1);

    const hit = lookupItem(db, '5731609764');
    assert.equal(hit.code, '309724');
    assert.equal(hit.description, 'C.GOLD KETCHUP');
    assert.equal(hit.matched_via, 'alias');
    // Detail the surviving row was missing is carried across, not thrown away.
    assert.equal(hit.zone, 'A12');
});

test('linkAlias merge re-points aliases that trailed the absorbed row', () => {
    const db = makeDb();
    upsertItem(db, { code: '309724', description: 'C.GOLD KETCHUP' });
    upsertItem(db, { code: '5731609764', description: 'CO-OP GOLD KETCHUP 1L' });
    linkAlias(db, '057316097640', '5731609764');

    assert.equal(linkAlias(db, '5731609764', '309724', { merge: true }), true);
    assert.equal(lookupItem(db, '057316097640').code, '309724');
});

test('learnFromEntry links a new barcode that carries a known description', () => {
    const db = makeDb();
    learnFromEntry(db, { code: '6429609', description: 'English Muffins' });
    learnFromEntry(db, { code: '12345678905', description: 'english muffins' });

    const viaBarcode = lookupItem(db, '12345678905');
    assert.equal(viaBarcode.code, '6429609');
    assert.equal(viaBarcode.matched_via, 'alias');
});

test('learnFromEntry routes an aliased code back to the primary item', () => {
    const db = makeDb();
    upsertItem(db, { code: '6429609', description: 'English Muffins' });
    linkAlias(db, '12345678905', '6429609');
    learnFromEntry(db, { code: '12345678905', description: 'English Muffins' });

    assert.equal(catalogStats(db).total, 1);
    assert.equal(lookupItem(db, '6429609').times_seen, 2);
});

test('backfillFromHistory seeds the catalog from kill_dates and shrink rows', () => {
    const db = makeDb();
    db.exec(`
        CREATE TABLE kill_dates (id TEXT, item TEXT, item_code TEXT, zone TEXT);
        CREATE TABLE floor_shrink_sku (id TEXT, sku TEXT, item TEXT, zone TEXT);
        INSERT INTO kill_dates VALUES ('k1','Pumpernickel','6451454','A1');
        INSERT INTO kill_dates VALUES ('k2','Pumpernickel','6451454','A1');
        INSERT INTO kill_dates VALUES ('k3','No Code','','A1');
        INSERT INTO floor_shrink_sku VALUES ('f1','6209753','Gourmet Brownie','A1');
    `);

    const result = backfillFromHistory(db);
    assert.equal(result.scanned, 3);
    assert.equal(result.created, 2);
    assert.equal(lookupItem(db, '6451454').times_seen, 2);
    assert.equal(lookupItem(db, '6209753').description, 'Gourmet Brownie');
});

test('importItemCsv maps common headers and links alias columns', () => {
    const db = makeDb();
    const csv = [
        'SKU,Description,Zone,Department,Size,Alias',
        '6429609,English Muffins,A1,Bakery,6 pk,012345678905',
        '6451454,Pumpernickel,A1,Bakery,,',
        ',Missing Code,,,,',
    ].join('\n');

    const preview = importItemCsv(db, csv, { dryRun: true });
    assert.equal(preview.import_count, 2);
    assert.equal(preview.skipped['missing code'], 1);

    const result = importItemCsv(db, csv, { actor: 'Chris' });
    assert.equal(result.imported, 2);
    assert.equal(result.aliases, 1);
    assert.equal(lookupItem(db, '12345678905').description, 'English Muffins');
    assert.equal(lookupItem(db, '6429609').department, 'Bakery');
});

test('importItemCsv reads a two-up price book as two products per line', () => {
    const db = makeDb();
    const csv = [
        'Code,Description,,,Pack size,Size,Case Price,Price,Marg,Code,Description,,Pack Size,Size,Case Price,Price,Marg',
        '5731609764,CO-OP GOLD KETCHUP 1L,,,12,1LTLT,52.99,4.95,0,5700003855,HZ LOW SODIUM KETCHUP,,12,750MLML,65.61,5.47,0',
        // Section banner on the left, and a page that ran out of products on the right.
        ',SPAGHETTI/TOMATO SAUCE,,,,,,,,,,,,,,,',
        '5659505379,BICKS PREPARED HORSERADISH,,,12,250MLML,,3.29,0,,,,,,,,',
    ].join('\n');

    const res = importItemCsv(db, csv, { actor: 'tester' });
    assert.equal(res.imported, 3);
    assert.equal(lookupItem(db, '5700003855').description, 'HZ LOW SODIUM KETCHUP');
    assert.equal(lookupItem(db, '5659505379').description, 'BICKS PREPARED HORSERADISH');
    // The banner has no code, and the empty right-hand block is not counted as debris.
    assert.equal(res.skipped['missing code'], 1);
});

test('importItemCsv skipKnown widens barcode coverage without restating known items', () => {
    const db = makeDb();
    upsertItem(db, { code: '309724', description: 'C.GOLD KETCHUP', source: 'csv' });
    linkAlias(db, '5731609764', '309724');

    const csv = [
        'Code,Description',
        '5731609764,CO-OP GOLD KETCHUP 1L',
        '5659505379,BICKS PREPARED HORSERADISH',
    ].join('\n');

    const res = importItemCsv(db, csv, { skipKnown: true, actor: 'tester' });
    assert.equal(res.imported, 1);
    assert.equal(res.already_known, 1);

    // The barcode we already resolved keeps pointing at the head-office item and name.
    const known = lookupItem(db, '5731609764');
    assert.equal(known.code, '309724');
    assert.equal(known.description, 'C.GOLD KETCHUP');
    // The barcode nobody had now scans.
    assert.equal(lookupItem(db, '5659505379').description, 'BICKS PREPARED HORSERADISH');
});

test('a NOUPC placeholder never becomes a scannable code', () => {
    const db = makeDb();
    const csv = [
        'Code,Description',
        'NOUPC-6419287,BROWN SUGAR ENVELOPE 3G',
        '5659505379,BICKS PREPARED HORSERADISH',
    ].join('\n');

    const res = importItemCsv(db, csv, { actor: 'tester' });
    assert.equal(res.imported, 1);
    assert.equal(res.skipped['placeholder for an item with no barcode'], 1);
    assert.equal(lookupItem(db, 'NOUPC-6419287'), null);
});

test('importItemCsv rejects a file with no code column', () => {
    const db = makeDb();
    assert.throws(() => importItemCsv(db, 'name,price\nfoo,1'), /code column/i);
});

test('upcCheckDigit matches known barcodes and ignores leading zeros', () => {
    assert.equal(upcCheckDigit('05731600105'), 4);
    assert.equal(upcCheckDigit('5731600105'), 4);
    assert.equal(upcCheckDigit('01234567890'), 5);
});

test('a scanned barcode finds an item filed without its check digit', () => {
    const db = makeDb();
    // Head-office files list the Co-op item as 5731600105; the package scans 057316001054.
    upsertItem(db, { code: '5731600105', description: 'CO-OP BLUEBERRIES FANCY', source: 'csv' });

    const scanned = lookupItem(db, '057316001054');
    assert.equal(scanned.description, 'CO-OP BLUEBERRIES FANCY');
    assert.equal(scanned.matched_via, 'barcode');

    // Same story once the scanner has already stripped the leading zero.
    assert.equal(lookupItem(db, '57316001054').code, '5731600105');
    // And the exact code still wins outright.
    assert.equal(lookupItem(db, '5731600105').matched_via, 'code');
});

test('an item filed with its check digit is still found from the short code', () => {
    const db = makeDb();
    upsertItem(db, { code: '057316001054', description: 'CO-OP BLUEBERRIES FANCY', source: 'csv' });
    assert.equal(lookupItem(db, '5731600105').matched_via, 'barcode');
});

test('check-digit guessing never reaches unrelated codes', () => {
    const db = makeDb();
    upsertItem(db, { code: '5731600105', description: 'CO-OP BLUEBERRIES FANCY' });

    // One digit off, so the check digit fails and nothing is matched.
    assert.equal(lookupItem(db, '057316001055'), null);
    // Short shelf/vendor codes are left exactly as typed.
    assert.deepEqual(codeCandidates('6429609'), ['6429609']);
});

test('scanning a barcode remembers it as an alias for the catalog item', () => {
    const db = makeDb();
    upsertItem(db, { code: '5731600105', description: 'CO-OP BLUEBERRIES FANCY', source: 'csv' });
    learnFromEntry(db, { code: '057316001054', description: 'coop blueberries' });

    assert.equal(catalogStats(db).total, 1);
    assert.equal(catalogStats(db).aliases, 1);
    const hit = lookupItem(db, '57316001054');
    assert.equal(hit.matched_via, 'alias');
    assert.equal(hit.description, 'CO-OP BLUEBERRIES FANCY');
});

test('a description read as a code is not mistaken for a rounded barcode', () => {
    // "DOVE MEN BW ACTIVE + FRESH" normalizes to ...ACTIVE+FRESH..., which contains "E+".
    const issue = catalogRowIssue({ code: 'DOVE MEN BW ACTIVE + FRESH 532', description: '' });
    assert.equal(issue, 'report title line');
    assert.doesNotMatch(String(issue), /scientific notation/);
});

/**
 * The real SMS "Price List with Cost" export, cell for cell:
 * header labels sit one column right of the data, Vendor covers a number cell and an
 * unlabelled vendor-name cell, and columns 2/3/7 are always empty spacers.
 */
function smsPriceListRows(count = 60) {
    const header = ['', 'Code', 'Description', '', 'Vendor', '', 'V.Code', 'S.Dept.', 'Regular/Qty', '', 'Case', 'Margin'];
    const body = [];
    for (let i = 0; i < count; i += 1) {
        const unit = 4.18 + i * 0.01;
        const qty = 6;
        body.push([
            `000370004${String(1000 + i)}`,
            `CASCADE AUTO DISH GEL ${i}`,
            '', '',
            '100323',
            'The Grocery People - Re',
            String(317000 + i),
            '',
            '1',
            (unit * 1.35).toFixed(2),
            (unit * qty).toFixed(2),
            String(qty),
            unit.toFixed(2),
            '27.81',
        ]);
    }
    return { header, body };
}

test('a formatted SMS export is read from the data when its header is offset', () => {
    const db = makeDb();
    const { header, body } = smsPriceListRows();
    const result = importItemTable(db, header, body, { dryRun: true });

    // Every row is a product, instead of being dropped as a report title line.
    assert.equal(result.import_count, body.length);
    assert.match(result.errors.join(' '), /did not line up/i);
    assert.equal(result.columns.code, 0);
    assert.equal(result.columns.description, 1);
    assert.equal(result.columns.alias_code, 6);
    assert.equal(result.columns.department, 8);
});

test('the repaired mapping imports codes, names and prices that agree with the case pack', () => {
    const db = makeDb();
    const { header, body } = smsPriceListRows();
    importItemTable(db, header, body, { actor: 'Chris' });

    const hit = lookupItem(db, '0003700041000');
    assert.equal(hit.description, 'CASCADE AUTO DISH GEL 0');
    assert.equal(hit.department, 'Grocery');
    assert.equal(hit.unit_cost, 4.18);
    assert.equal(hit.case_qty, 6);
    assert.equal(hit.case_cost, 25.08);
    assert.equal(lookupItem(db, '317000').description, 'CASCADE AUTO DISH GEL 0');
    // A description must never be filed as though it were the product code.
    assert.equal(lookupItem(db, 'CASCADE AUTO DISH GEL 0'), null);
});

test('real Price List rows map to the right columns even though costs do not divide evenly', () => {
    const db = makeDb();
    // Transcribed from the report: unit cost carries freight, so 4.18 x 6 = 25.08
    // against a 24.41 case cost. The mapping still has to be accepted.
    const real = [
        ['0003700041537', 'CASCADE AUTO DISH GEL FRESH SCENT', '317636', 5.79, 24.41, 6, 4.18],
        ['0003700041767', 'SWIFFER DUSTER REFILLS 10EA', '420307', 14.00, 42.02, 4, 10.52],
        ['0003700041825', 'TIDE LQ 2X HE FREE 1.36L 32EA', '6272108', 12.99, 60.81, 6, 10.26],
        ['0003700041827', 'TIDE LQ 2X HE FREE 2.04L 48EA', '6272116', 17.79, 56.61, 4, 14.33],
        ['0003700042683', 'ALWAYS P/LINER UNSCTD MAX PROTECT', '397786', 4.99, 47.96, 12, 4.01],
        ['0003700043227', 'GAIN SHEETS ORIGINAL 9x 120EA', '43227', 7.49, 18.21, 9, 2.02],
        ['0003700045112', 'DAWN PRO LINE DSH DETRGNT 1.12LT', '903492', 6.69, 42.19, 8, 5.38],
        ['0003700045532', 'FBRZ AIR FRSH TWST CRAN -J 250GR', '2417590', 4.49, 17.18, 6, 2.89],
        ['0003700045535', 'FEBREZE AIR EFFECTS MEADOWS&RAIN', '563114', 3.99, 25.77, 9, 2.89],
        ['0003700045541', 'FEB NOTICEABLE MDOW/RAIN 8x 26ML', '335315', 5.99, 33.45, 8, 4.19],
        ['0003700046160', 'MR CLEAN MULTI PURPOSE SPRAY LEM', '571331', 5.29, 43.01, 12, 3.65],
        ['0003700046300', 'FEB NOTICE 2PK RF MD/RAIN 6x 52ML', '335547', 9.29, 45.55, 6, 7.61],
    ];
    const header = ['', 'Code', 'Description', '', 'Vendor', '', 'V.Code', 'S.Dept.', 'Regular/Qty', '', 'Case', 'Margin'];
    const body = real.map(([code, desc, vcode, reg, base, cs, unit]) => ([
        code, desc, '', '', '100323', 'The Grocery People - Re', vcode, '',
        '1', reg.toFixed(2), base.toFixed(2), String(cs), unit.toFixed(2), '27.81',
    ]));

    importItemTable(db, header, body, { actor: 'Chris' });

    const cascade = lookupItem(db, '0003700041537');
    assert.equal(cascade.description, 'CASCADE AUTO DISH GEL FRESH SCENT');
    assert.equal(cascade.department, 'Grocery');
    assert.equal(cascade.retail_price, 5.79);
    assert.equal(cascade.unit_cost, 4.18);
    assert.equal(cascade.case_cost, 24.41);
    assert.equal(cascade.case_qty, 6);
    assert.equal(lookupItem(db, '317636').description, 'CASCADE AUTO DISH GEL FRESH SCENT');
    // The vendor number must never be mistaken for the item's own code.
    assert.equal(lookupItem(db, '100323'), null);
});

test('stock with no barcode is filed under its vendor item code, not dropped', () => {
    const db = makeDb();
    const header = ['', 'Code', 'Description', '', 'Vendor', '', 'V.Code', 'S.Dept.', 'Regular/Qty', '', 'Case', 'Margin'];
    const body = [
        // Straight from the SMS export: gift cards and packaging carry no UPC, so the
        // Code cell is blank or a stub, but each has its own vendor item code.
        ['0', 'KERNELS $25 GIFTCARD 1', '', '', '1175', 'BLACKHAWK', '2487916', '', '41', '100', '495.81', '1', '4.95', '0'],
        ['', 'KERNELS $25 GIFTCARD 1', '', '', '1175', 'BLACKHAWK', '2488070', '', '41', '100', '90.05', '1', '90.05', '0'],
        ['6', '6" MEGAPACK PIZZA BOX 50PK', '', '', '4624430', 'PEGASUS', 'WC6WB', '', '2', '8.69', '7', '1', '7.00', '19'],
        // Page furniture and a department banner with no vendor code stay out.
        ['WHOLESALE MARKET -', '', '', '', '', '', '', '', 'Printed :', '8/1/2026 12:40 PM', '', 'Page 1'],
        ['', 'Code', 'Description', '', 'Vendor', '', 'V.Code', 'S.Dept.', 'Regular/Qty', '', 'Case', 'Margin'],
        ['3', 'GROCERY', '', '', '', '', '', '', '', '', '', ''],
    ];
    for (let i = 0; i < 60; i += 1) {
        body.push([
            `000370${String(1000000 + i)}`, `PRODUCT ${i} NAME`, '', '',
            '100323', 'The Grocery People - Re', String(500000 + i), '',
            '1', '2.80', '12.00', '6', '2.00', '27.81',
        ]);
    }

    const preview = importItemTable(db, header, body, { dryRun: true });
    assert.equal(preview.filed_by_vendor_code, 3);
    assert.equal(preview.skipped['repeated column header'], 1);
    assert.equal(preview.skipped['report title line'], 1);
    assert.equal(preview.skipped['department or section heading'], 1);
    assert.match(preview.errors.join(' '), /no barcode in SMS/i);

    importItemTable(db, header, body, { actor: 'Chris' });
    assert.equal(lookupItem(db, '2487916').description, 'KERNELS $25 GIFTCARD 1');
    assert.equal(lookupItem(db, '2488070').description, 'KERNELS $25 GIFTCARD 1');
    assert.equal(lookupItem(db, 'WC6WB').description, '6" MEGAPACK PIZZA BOX 50PK');
    // A page heading must never be filed as a product under a column label.
    assert.equal(lookupItem(db, 'V.Code'), null);
    assert.equal(lookupItem(db, '3'), null);
    assert.equal(catalogStats(db).junk, 0);
});

test('a correctly aligned header is left alone', () => {
    const db = makeDb();
    const rows = [];
    for (let i = 0; i < 30; i += 1) rows.push([`57316${String(10000 + i)}`, `PRODUCT ${i}`]);
    const result = importItemTable(db, ['Code', 'Description'], rows, { dryRun: true });

    assert.equal(result.import_count, 30);
    assert.equal(result.columns.code, 0);
    assert.doesNotMatch(result.errors.join(' '), /did not line up/i);
});

test('catalogRowIssue spots the debris in a printed product report', () => {
    assert.equal(catalogRowIssue({ code: 'CODE', description: 'Description' }), 'repeated column header');
    assert.match(catalogRowIssue({ code: '8.41006E+11', description: 'ESPUNA TAPAS' }), /scientific notation/);
    assert.equal(catalogRowIssue({ code: '1', description: 'GROCERY' }), 'department or section heading');
    assert.equal(catalogRowIssue({ code: 'EDMONTON WAREHOUSE M', description: '' }), 'report title line');
    assert.equal(catalogRowIssue({ code: '5731600105', description: 'CO-OP BLUEBERRIES' }), null);
    assert.equal(catalogRowIssue({ code: '4011', description: 'BANANAS' }), null);
});

test('importItemCsv keeps report debris out and flags mangled barcodes', () => {
    const db = makeDb();
    const csv = [
        'Code,Description',
        '5731600105,CO-OP BLUEBERRIES FANCY',
        'EDMONTON WAREHOUSE M,',
        'CODE,Description',
        '1,GROCERY',
        '8.41006E+11,ESPUNA TAPAS ESSENTIALS 160GR',
        '5731600112,CO-OP GOLD PITTED BING CHERRIES',
    ].join('\n');

    const result = importItemCsv(db, csv);
    assert.equal(result.imported, 2);
    assert.equal(result.skipped['repeated column header'], 1);
    assert.equal(result.skipped['department or section heading'], 1);
    assert.equal(result.skipped['report title line'], 1);
    assert.equal(catalogStats(db).total, 2);
    assert.match(result.errors.join(' '), /ExcelFile|formatted as Text/i);
});

test('extractVendorItemCode pulls the trailing number from Price List V.Code', () => {
    assert.equal(extractVendorItemCode('The Grocery People - Re 317636'), '317636');
    assert.equal(extractVendorItemCode('The Grocery People - HE 397786'), '397786');
    assert.equal(extractVendorItemCode('The Grocery People - Re 6272108'), '6272108');
    assert.equal(extractVendorItemCode('144311'), '144311');
    assert.equal(extractVendorItemCode(''), '');
    assert.equal(parseMoney('$5.79'), 5.79);
    assert.equal(parseMoney('24.41'), 24.41);
});

test('SMS Price List with Cost maps UPC, V.Code alias, and unit prices', () => {
    const db = makeDb();
    const csv = [
        'Code,Description,Vendor,V.Code,S.Dept.,Regular/Qty,Base cost,Case,Unit cost,Margin',
        '0003700041537,CASCADE AUTO DISH GEL FRESH SCENT,100323,The Grocery People - Re 317636,1,$5.79,$24.41,6,$4.18,27.81%',
        '0005659500485,BICKS SWEET MUSTARD PICKLES,100323,The Grocery People - Re 144311,1,$4.99,$35.88,12,$2.99,40.08%',
    ].join('\n');

    const result = importItemCsv(db, csv, { actor: 'Chris' });
    assert.equal(result.imported, 2);
    assert.equal(result.aliases, 2);

    const cascade = lookupItem(db, '0003700041537');
    assert.equal(cascade.description, 'CASCADE AUTO DISH GEL FRESH SCENT');
    assert.equal(cascade.retail_price, 5.79);
    assert.equal(cascade.unit_cost, 4.18);
    assert.equal(cascade.case_cost, 24.41);
    assert.equal(cascade.case_qty, 6);
    assert.equal(lookupItem(db, '317636').matched_via, 'alias');

    const pickles = lookupItem(db, '5659500485');
    assert.equal(pickles.description, 'BICKS SWEET MUSTARD PICKLES');
    assert.equal(lookupItem(db, '144311').description, 'BICKS SWEET MUSTARD PICKLES');
});

test('SMS price catalog maps UPC as code and Case Code as alias', () => {
    const db = makeDb();
    const csv = [
        'Case Code,Unit Code,UPC,Description,Pack,Size,Case Price,Each Price,Status',
        '668913,70668913,0005731602011,CO-OP CENTSIBLES KETCHUP SQUEEZE,12,1L,45.00,3.75,N',
        '2448967,72448967,0005731615065,CO-OP GOLD KETCHUP 1.5L,12,1.5L,54.96,7.75,N',
    ].join('\n');

    const result = importItemCsv(db, csv, { actor: 'Chris' });
    assert.equal(result.imported, 2);
    assert.equal(result.aliases, 2);
    assert.equal(lookupItem(db, '0005731602011').description, 'CO-OP CENTSIBLES KETCHUP SQUEEZE');
    assert.equal(lookupItem(db, '668913').description, 'CO-OP CENTSIBLES KETCHUP SQUEEZE');
    assert.equal(lookupItem(db, '057316020116').description, 'CO-OP CENTSIBLES KETCHUP SQUEEZE');
    assert.equal(lookupItem(db, '5731615065').size, '1.5L');
});

test('Unit Code is ignored because SMS derives it from the Case Code', () => {
    const db = makeDb();
    const csv = [
        'Case Code,Unit Code,UPC,Description,Pack,Size,Case Price,Each Price,Status',
        '309724,70309724,0005731609764,CO-OP GOLD KETCHUP 1L,12,1L,52.99,4.95,N',
    ].join('\n');

    importItemCsv(db, csv, { actor: 'Chris' });
    assert.equal(lookupItem(db, '309724').description, 'CO-OP GOLD KETCHUP 1L');
    assert.equal(lookupItem(db, '70309724'), null, 'the derived unit code should never be stored');
});

test('importItemUpload reads an SMS ExcelFile and skips title rows', async () => {
    const db = makeDb();
    const buf = await buildCatalogXlsx([{
        name: 'Catalog',
        rows: [
            ['Customer Price Catalog by Dept / Family'],
            ['Dept: 0 to 9999'],
            ['Family: 0 to 999999999'],
            [],
            ['Case Code', 'Unit Code', 'UPC', 'Description', 'Pack', 'Size', 'Case Price', 'Each Price', 'Status'],
            ['668913', '70668913', '0005731602011', 'CO-OP CENTSIBLES KETCHUP SQUEEZE', '12', '1L', '45.00', '3.75', 'N'],
            ['309724', '70309724', '0005731609764', 'CO-OP GOLD KETCHUP 1L', '12', '1L', '52.99', '4.95', 'N'],
        ],
    }]);
    const result = await importItemUpload(db, 'CustomerPriceCatalog.xlsx', buf.toString('base64'), { actor: 'Chris' });

    assert.equal(result.format, 'excel');
    assert.ok(result.header_row >= 2, 'title lines should sit above the column header');
    assert.equal(result.imported, 2);
    assert.equal(result.aliases, 2);
    assert.equal(lookupItem(db, '5731602011').description, 'CO-OP CENTSIBLES KETCHUP SQUEEZE');
    assert.equal(lookupItem(db, '309724').matched_via, 'alias');
});

test('importItemUpload survives Excel storing codes as numbers', async () => {
    const db = makeDb();
    // Numeric cells are what Excel leaves behind once it has eaten the leading zeros and
    // rendered the long barcode as "9.78031E+12" on screen.
    const buf = await buildCatalogXlsx([{
        name: 'Catalog',
        rows: [
            ['Case Code', 'Unit Code', 'UPC', 'Description', 'Pack', 'Size'],
            [668913, 70668913, 5731602011, 'CO-OP CENTSIBLES KETCHUP SQUEEZE', 12, '1L'],
            [668915, 70668915, 9780306406157, 'LONG EAN TEST', 6, '500G'],
        ],
    }]);
    const result = await importItemUpload(db, 'CustomerPriceCatalog.xlsx', buf.toString('base64'), { actor: 'Chris' });

    assert.equal(result.imported, 2);
    assert.deepEqual(result.errors, [], 'numeric cells should not read as mangled codes');
    // Zeros Excel dropped do not matter: both forms normalize to the same code.
    assert.equal(lookupItem(db, '5731602011').description, 'CO-OP CENTSIBLES KETCHUP SQUEEZE');
    assert.equal(lookupItem(db, '0005731602011').description, 'CO-OP CENTSIBLES KETCHUP SQUEEZE');
    assert.equal(lookupItem(db, '668913').matched_via, 'alias');
    // The long barcode must keep its digits instead of becoming 9.78031e+12.
    assert.equal(lookupItem(db, '9780306406157').description, 'LONG EAN TEST');
});

test('importItemUpload reads every sheet of a split export', async () => {
    const db = makeDb();
    const header = ['Case Code', 'Unit Code', 'UPC', 'Description', 'Pack', 'Size'];
    // Crystal Reports spills a long catalog onto a second sheet; both are the same report.
    const buf = await buildCatalogXlsx([
        {
            name: 'Page 1',
            rows: [
                ['Customer Price Catalog by Dept / Family'],
                header,
                ['668913', '70668913', '0005731602011', 'CO-OP CENTSIBLES KETCHUP SQUEEZE', '12', '1L'],
            ],
        },
        {
            name: 'Page 2',
            rows: [
                header,
                ['144311', '70144311', '0005659500485', 'BICKS SWEET MUSTARD PICKLES', '12', '1L'],
            ],
        },
    ]);
    const result = await importItemUpload(db, 'Catalog.xlsx', buf.toString('base64'), { actor: 'Chris' });

    assert.deepEqual(result.sheets, ['Page 1', 'Page 2']);
    assert.equal(result.rows_read, 2, 'both sheets contribute their body rows');
    assert.equal(result.imported, 2);
    // The item that only exists on the second sheet has to be findable.
    assert.equal(lookupItem(db, '0005659500485').description, 'BICKS SWEET MUSTARD PICKLES');
    assert.equal(lookupItem(db, '144311').matched_via, 'alias');
});

test('purgeCatalogJunk clears debris an earlier import let through', () => {
    const db = makeDb();
    upsertItem(db, { code: '5731600105', description: 'CO-OP BLUEBERRIES FANCY' });
    upsertItem(db, { code: 'CODE', description: 'Description' });
    upsertItem(db, { code: '1', description: 'GROCERY' });
    linkAlias(db, '057316001054', '5731600105');
    assert.equal(catalogStats(db).junk, 2);

    const result = purgeCatalogJunk(db);
    assert.equal(result.removed, 2);
    assert.equal(catalogStats(db).total, 1);
    assert.equal(catalogStats(db).junk, 0);
    // Real products and their barcodes survive.
    assert.equal(lookupItem(db, '057316001054').description, 'CO-OP BLUEBERRIES FANCY');
});

test('searchItems finds by description fragment and by code', () => {
    const db = makeDb();
    upsertItem(db, { code: '6429609', description: 'English Muffins Variety' });
    upsertItem(db, { code: '6451454', description: 'Pumpernickel Loaf' });

    assert.equal(searchItems(db, { q: 'muffin' }).length, 1);
    assert.equal(searchItems(db, { q: '6451' })[0].description, 'Pumpernickel Loaf');
    assert.equal(searchItems(db, { q: '' }).length, 0);
});
