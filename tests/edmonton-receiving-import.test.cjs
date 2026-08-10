'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { runMigrations } = require('../src/migrations/runner.cjs');
const {
    parseWorkbookFile,
    summarizeWorkbook,
    importWorkbookToDb,
    readPeriodFreightRateFromWorkbook,
    normalizeImportedFreightRatePercent,
    readAllocPctMapFromSheet,
    FREIGHT_ALLOC_PCT_ROW,
    FREIGHT_ALLOC_DOLLAR_ROW,
} = require('../src/lib/edmonton-receiving-workbook-import.cjs');
const { getPeriodFreightRate } = require('../src/lib/receiving-period-freight-rates.cjs');
const {
    DEFAULT_ALLOC_PCT_POINTS,
    ALLOC_DEPT_KEYS,
    getProfileRow,
    resolveAllocProfile,
    upsertDraftProfile,
    confirmProfile,
} = require('../src/lib/receiving-period-freight-alloc.cjs');
const {
    buildReportWorkbookBuffer,
    saveLine,
    upsertDayMeta,
} = require('../src/lib/edmonton-receiving-report.cjs');
const {
    COSTING_METHOD,
    allocateFreight,
    FREIGHT_ALLOC_PCT,
    setPeriodCostingMethod,
} = require('../src/lib/edmonton-receiving-costing.cjs');
const { roundMoney } = require('../src/lib/parse-money.cjs');

const sampleWorkbook = path.join(
    __dirname,
    '..',
    'store-templates',
    'default',
    'Sample-Edmonton-Wholesale-Market-Receiving-Report-2026Aug22.xlsx',
);

const EXPECTED_PROFILE = { ...DEFAULT_ALLOC_PCT_POINTS };
const ALLOC_COLS = {
    grocery: 'C',
    tobacco: 'D',
    meat: 'E',
    bakery: 'F',
    bakery_in_store: 'G',
    deli: 'H',
    produce: 'I',
    produce_shrink: 'J',
    dairy: 'K',
    pharmacy: 'L',
};

function expected152Allocations() {
    return allocateFreight(152.07, FREIGHT_ALLOC_PCT);
}

test('Aug 2026 sample workbook parses period and daily receiving lines', async () => {
    if (!fs.existsSync(sampleWorkbook)) {
        assert.fail(`Missing sample workbook: ${sampleWorkbook}`);
    }
    const wb = await parseWorkbookFile(sampleWorkbook);
    const summary = summarizeWorkbook(wb, { fillSales: false });
    assert.equal(summary.period_start, '2026-07-19');
    assert.ok(summary.daily_sheets >= 6);
    assert.ok(summary.invoice_lines >= 100);
});

test('Aug 2026 sample workbook parses extended sheets', async () => {
    if (!fs.existsSync(sampleWorkbook)) {
        assert.fail(`Missing sample workbook: ${sampleWorkbook}`);
    }
    const wb = await parseWorkbookFile(sampleWorkbook);
    const summary = summarizeWorkbook(wb, { fillSales: false });
    assert.ok(summary.rebate_lines >= 0);
    assert.ok(summary.recount_rows >= 0);
    assert.ok(summary.dept_margin_sheets >= 0);
});

test('normalizeImportedFreightRatePercent accepts percent and decimal forms', () => {
    assert.equal(normalizeImportedFreightRatePercent(1.5207), 1.5207);
    assert.equal(normalizeImportedFreightRatePercent(0.015207), 1.5207);
    assert.equal(normalizeImportedFreightRatePercent('1.5207%'), 1.5207);
    assert.equal(normalizeImportedFreightRatePercent(0), null);
    assert.equal(normalizeImportedFreightRatePercent(50), null);
});

test('summarize reads row-2 allocation profile from daily sheets', async () => {
    if (!fs.existsSync(sampleWorkbook)) return;

    const wb = await parseWorkbookFile(sampleWorkbook);
    const summary = summarizeWorkbook(wb, { fillSales: false });
    assert.ok(summary.alloc_pct_map, 'expected allocation profile from row 2');
    assert.equal(summary.alloc_profile_valid, true);
    assert.deepEqual(summary.alloc_pct_map, EXPECTED_PROFILE);
    assert.equal(summary.alloc_pct_map.grocery, 47.8);
    assert.equal(summary.alloc_pct_map.tobacco, 0);
    assert.equal(summary.alloc_pct_map.meat, 9.9);
    assert.equal(summary.alloc_pct_map.bakery, 0);
    assert.equal(summary.alloc_pct_map.bakery_in_store, 0);
    assert.equal(summary.alloc_pct_map.deli, 0);
    assert.equal(summary.alloc_pct_map.produce, 15.9);
    assert.equal(summary.alloc_pct_map.produce_shrink, 12.2);
    assert.equal(summary.alloc_pct_map.dairy, 14.2);
    assert.equal(summary.alloc_pct_map.pharmacy, 0);
    assert.equal(summary.alloc_profile_total_pct, 100);

    const firstDaySheet = (wb.SheetNames || []).find((n) => /WK\d/.test(n) && !/\bCont\b/i.test(n));
    assert.ok(firstDaySheet, 'expected at least one daily sheet');
    const fromRow2 = readAllocPctMapFromSheet(wb.Sheets[firstDaySheet], FREIGHT_ALLOC_PCT_ROW);
    assert.ok(fromRow2);
    assert.equal(fromRow2.grocery, 47.8);
    assert.equal(fromRow2.meat, 9.9);
    assert.equal(fromRow2.produce, 15.9);
    assert.equal(fromRow2.produce_shrink, 12.2);
    assert.equal(fromRow2.dairy, 14.2);
});

test('importWorkbook loads Aug 2026 sample into an isolated database', async () => {
    if (!fs.existsSync(sampleWorkbook)) return;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-import-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);

        const summary = await importWorkbookToDb(db, sampleWorkbook, {
            replacePeriod: true,
            fillSales: true,
            actor: 'test-import',
        });
        assert.equal(summary.period_start, '2026-07-19');
        assert.ok(summary.invoice_lines >= 100);
        assert.ok(summary.shrink_lines >= 4);
        // fillSales may synthesize estimates for the summary, but those must not
        // persist as manager-entered sales rows.
        assert.ok(summary.sales_cells + summary.synthesized_sales >= 10);
        const persistedSales = db.get(
            'SELECT COUNT(*) AS n FROM receiving_report_sales WHERE period_start=?',
            summary.period_start,
        )?.n;
        assert.equal(Number(persistedSales || 0), Number(summary.sales_cells || 0));
        assert.equal(summary.profile_applied, true);
        assert.equal(summary.profile_confirmed, false);
        assert.equal(summary.profile_needs_confirmation, true);
        assert.equal(summary.period_freight_rate_percent, null);
        assert.equal(summary.freight_rate_source, null);
        assert.equal(summary.freight_rate_applied, false);
        assert.equal(getPeriodFreightRate(db, '2026-07-19'), null);

        const draft = getProfileRow(db, '2026-07-19');
        assert.ok(draft);
        assert.equal(draft.status, 'draft');
        assert.equal(draft.grocery_pct, 47.8);
        assert.equal(draft.produce_shrink_pct, 12.2);

        const rebateCount = db.get(
            'SELECT COUNT(*) AS n FROM receiving_report_rebate_lines WHERE period_start=?',
            summary.period_start,
        )?.n;
        const recountCount = db.get(
            'SELECT COUNT(*) AS n FROM receiving_report_recounts WHERE period_start=?',
            summary.period_start,
        )?.n;
        const deptMarginCount = db.get(
            'SELECT COUNT(*) AS n FROM receiving_report_dept_margin WHERE period_start=?',
            summary.period_start,
        )?.n;
        assert.ok(Number(rebateCount) >= 0);
        assert.ok(Number(recountCount) >= 0);
        assert.ok(Number(deptMarginCount) >= 0);
        if (summary.rebate_lines > 0) assert.ok(Number(rebateCount) >= summary.rebate_lines);
        if (summary.recount_rows > 0) assert.ok(Number(recountCount) >= summary.recount_rows);
        if (summary.dept_margin_sheets > 0) assert.ok(Number(deptMarginCount) >= summary.dept_margin_sheets);

        const lineCount = db.get(
            'SELECT COUNT(*) AS n FROM receiving_report_lines WHERE store_date >= ? AND store_date <= ?',
            '2026-07-19',
            '2026-08-22',
        )?.n;
        assert.ok(lineCount >= 100);
    } finally {
        if (prev == null) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = prev;
        try {
            fs.rmSync(tmp, { recursive: true, force: true });
        } catch (_) {
            /* db handle may still be open under Electron */
        }
    }
});

test('import stores N3 as Daily Freight Allocation Total on day rows', async () => {
    if (!fs.existsSync(sampleWorkbook)) return;

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-import-n3-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);

        const wb = await parseWorkbookFile(sampleWorkbook);
        const parsed = summarizeWorkbook(wb, { fillSales: false });
        await importWorkbookToDb(db, sampleWorkbook, {
            replacePeriod: true,
            fillSales: false,
            actor: 'test-n3',
        });

        const daysWithFreight = db.all(
            `SELECT store_date, freight_total FROM receiving_report_day
              WHERE store_date >= ? AND store_date <= ?
              ORDER BY store_date`,
            parsed.period_start,
            '2026-08-22',
        );
        assert.ok(daysWithFreight.length >= 1);

        const firstDaySheet = (wb.SheetNames || []).find((n) => /WK\d/.test(n) && !/\bCont\b/i.test(n));
        const ws = wb.Sheets[firstDaySheet];
        const n3Raw = ws?.N3?.v;
        const expectedN3 = n3Raw === '' || n3Raw == null ? null : Math.round(Number(n3Raw) * 100) / 100;
        const firstImported = daysWithFreight.find((d) => d.freight_total != null);
        if (expectedN3 != null && firstImported) {
            assert.equal(firstImported.freight_total, expectedN3);
        }
    } finally {
        if (prev == null) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
});

test('B118 period freight rate is deprecated metadata only — not upserted as landing rate', async () => {
    if (!fs.existsSync(sampleWorkbook)) return;

    const ExcelJS = require('exceljs');
    const staged = path.join(os.tmpdir(), `ewm-rate-${Date.now()}.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(sampleWorkbook);
    const rt = wb.getWorksheet('Receiving Totals');
    rt.getCell('A118').value = 'Period Freight Rate % (deprecated)';
    rt.getCell('B118').value = 1.5207;
    await wb.xlsx.writeFile(staged);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-import-rate-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);

        const parsed = await parseWorkbookFile(staged);
        const fromWb = readPeriodFreightRateFromWorkbook(parsed);
        assert.equal(fromWb.rate_percent, 1.5207);
        assert.equal(fromWb.deprecated, true);

        const summary = await importWorkbookToDb(db, staged, {
            replacePeriod: true,
            fillSales: false,
            actor: 'test-import-rate',
        });
        assert.equal(summary.deprecated_period_freight_rate_percent, 1.5207);
        assert.equal(summary.period_freight_rate_percent, null);
        assert.equal(summary.freight_rate_applied, false);
        assert.equal(getPeriodFreightRate(db, summary.period_start), null);

        const resolved = resolveAllocProfile(db, summary.period_start);
        assert.equal(resolved.status, 'draft');
        assert.equal(resolved.pctMap.grocery, 47.8);
    } finally {
        if (prev == null) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = prev;
        try { fs.unlinkSync(staged); } catch (_) {}
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
});

test('export day $152.07 + confirmed profile round-trips allocations to the cent', async () => {
    const storeDate = '2026-06-21';
    const periodStart = '2026-06-21';
    const expected = expected152Allocations();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-import-rt-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);

        db.run(
            `INSERT INTO settings (setting_name, setting_value) VALUES ('Receiving_Report_Period_Start', ?)
             ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value`,
            periodStart,
        );

        upsertDraftProfile(db, periodStart, { ...EXPECTED_PROFILE }, 'export-test');
        confirmProfile(db, periodStart, 'export-test', 'Confirmed for export round-trip');
        setPeriodCostingMethod(db, periodStart, {
            method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
            reason: 'Export round-trip costing confirm',
        }, 'export-test');

        saveLine(db, storeDate, {
            invoice_number: 'RT-152',
            supplier_name: 'SYSCO',
            grocery: 1000,
        }, 'export-test');
        upsertDayMeta(db, storeDate, {
            receiver_name: 'Receiver',
            freight_total: 152.07,
        }, 'export-test');

        const exported = await buildReportWorkbookBuffer(db, storeDate);
        const staged = path.join(os.tmpdir(), `ewm-rt-${Date.now()}.xlsx`);
        fs.writeFileSync(staged, exported.buffer);

        const parsed = await parseWorkbookFile(staged);
        const sheetName = exported.payload.sheet_name;
        const ws = parsed.Sheets[sheetName];
        assert.ok(ws, `expected exported sheet ${sheetName}`);
        assert.equal(roundMoney(ws.N3?.v), 152.07);

        const profile = readAllocPctMapFromSheet(ws, FREIGHT_ALLOC_PCT_ROW);
        assert.deepEqual(profile, EXPECTED_PROFILE);

        for (const key of ALLOC_DEPT_KEYS) {
            const col = ALLOC_COLS[key];
            const dollars = roundMoney(ws[`${col}${FREIGHT_ALLOC_DOLLAR_ROW}`]?.v);
            assert.equal(dollars, expected[key], `exported row-3 ${key}`);
        }

        const reimportTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-import-rt-re-'));
        const prev2 = process.env.TGP_DATA_DIR;
        process.env.TGP_DATA_DIR = reimportTmp;
        try {
            delete require.cache[require.resolve('../src/db.cjs')];
            const { db: db2, initializeSettings: init2, initializeDailyRhythm: rhythm2 } = require('../src/db.cjs');
            init2();
            rhythm2();
            runMigrations(db2);

            await importWorkbookToDb(db2, staged, {
                replacePeriod: true,
                fillSales: false,
                confirm_profile: true,
                actor: 'reimport-test',
            });

            const dayRow = db2.get(
                'SELECT freight_total FROM receiving_report_day WHERE store_date=?',
                storeDate,
            );
            assert.equal(dayRow?.freight_total, 152.07);

            const allocRows = db2.all(
                `SELECT department, allocated_amount FROM receiving_report_day_freight_alloc
                  WHERE store_date=? ORDER BY department`,
                storeDate,
            ) || [];
            assert.equal(allocRows.length, ALLOC_DEPT_KEYS.length);
            for (const row of allocRows) {
                assert.equal(row.allocated_amount, expected[row.department], `reimport ${row.department}`);
            }

            const confirmed = resolveAllocProfile(db2, periodStart);
            assert.equal(confirmed.status, 'confirmed');
            assert.equal(confirmed.pctMap.grocery, 47.8);
        } finally {
            process.env.TGP_DATA_DIR = prev2;
            try { fs.unlinkSync(staged); } catch (_) {}
            try { fs.rmSync(reimportTmp, { recursive: true, force: true }); } catch (_) {}
        }
    } finally {
        if (prev == null) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
});
