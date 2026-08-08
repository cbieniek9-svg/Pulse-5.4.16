'use strict';

/**
 * 5.4.7 receiving financial integrity — integration tests (API/lib paths, not UI chrome).
 * Run under Electron-as-Node when better-sqlite3 is ABI 145.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

const { roundMoney } = require('../src/lib/parse-money.cjs');
const { runMigrations } = require('../src/migrations/runner.cjs');
const {
    saveLine,
    deleteLine,
    upsertDayMeta,
    buildReportPayload,
    saveDayCertification,
    saveFreightOverride,
    buildReportWorkbookBuffer,
    listLines,
    getDayMeta,
} = require('../src/lib/edmonton-receiving-report.cjs');
const {
    buildPeriodCloseReadiness,
    assertPeriodCloseReady,
    saveSalesAmount,
    saveMarginMeta,
    saveSalesZeroConfirm,
    buildCostingComparisonPayload,
    activateReceivingPeriod,
} = require('../src/lib/edmonton-receiving-analytics.cjs');
const {
    setPeriodCostingMethod,
    COSTING_METHOD,
    reconcileDayFreight,
    computeItemLandedCost,
    allocateFreight,
    FREIGHT_ALLOC_PCT,
} = require('../src/lib/edmonton-receiving-costing.cjs');
const {
    DEFAULT_ALLOC_PCT_POINTS,
    upsertDraftProfile,
    confirmProfile,
} = require('../src/lib/receiving-period-freight-alloc.cjs');
const { upsertPeriodFreightRate } = require('../src/lib/receiving-period-freight-rates.cjs');

function confirmDeptAllocation(db, periodStart, actor = 'test') {
    upsertDraftProfile(db, periodStart, { ...DEFAULT_ALLOC_PCT_POINTS }, actor);
    confirmProfile(db, periodStart, actor, 'Manager confirmed allocation profile');
    return setPeriodCostingMethod(db, periodStart, {
        method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        reason: 'Manager confirmed period department allocation',
    }, actor);
}
const {
    computeDayFreightReconciliation,
    freightReconBlocksClose,
    saveDuplicateInvoiceExceptionAck,
    listDuplicateInvoiceGroups,
} = require('../src/lib/edmonton-receiving-integrity.cjs');
const {
    closeAndLockPeriod,
    submitPeriod,
    approvePeriod,
    reopenPeriod,
    getPeriodStatus,
} = require('../src/lib/edmonton-receiving-period-controls.cjs');
const {
    snapshotPeriod,
    listSnapshotRevisions,
    archivePeriodSalesToHistory,
} = require('../src/lib/edmonton-receiving-extended.cjs');
const { buildFullPeriodWorkbookBuffer } = require('../src/lib/edmonton-receiving-workbook-export.cjs');
const { buildProductionReadinessReport } = require('../src/lib/production-readiness.cjs');
const {
    inspectPcAdminPin,
} = require('../src/lib/pc-admin-pin.cjs');
const { upsertSetting } = require('../src/lib/settings-store.cjs');

function withTestDb(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-547-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);
        return fn(db, tmp);
    } finally {
        process.env.TGP_DATA_DIR = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
}

function seedPeriod(db, periodStart = '2026-06-01') {
    db.run(
        `INSERT INTO settings (setting_name, setting_value) VALUES ('Receiving_Report_Period_Start', ?)
         ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value`,
        periodStart,
    );
    return periodStart;
}

function fillSalesAndMargin(db, start) {
    for (let w = 1; w <= 5; w += 1) {
        saveSalesAmount(db, start, w, 'grocery', 1000, 'test');
        saveSalesAmount(db, start, w, 'dairy', 200, 'test');
        saveSalesAmount(db, start, w, 'produce', 150, 'test');
        saveSalesZeroConfirm(db, start, '__week__', w, 'Manager Test', 'No remaining sales in this week');
    }
    saveMarginMeta(db, start, {
        opening_inventory: 10000,
        closing_inventory: 9000,
    }, 'test');
    confirmDeptAllocation(db, start, 'test');
}

function certifyDay(db, storeDate, freightTotal = 0) {
    upsertDayMeta(db, storeDate, {
        receiver_name: 'Receiver',
        freight_total: freightTotal,
    }, 'mgr');
    return saveDayCertification(db, storeDate, {
        receiving_complete: true,
        invoices_entered: true,
        references_verified: true,
        freight_verified: true,
        receiver_identified: true,
        exceptions_documented: true,
        receiver_name: 'Receiver',
        freight_total: freightTotal,
    }, 'mgr');
}

describe('5.4.7 Item X freight save + reload', () => {
    test('Item X: grocery 32.03 + inv est 0.46 + rate 1% → payable 32.03 landed 32.35; estimate reference only', () => {
        withTestDb((db) => {
            seedPeriod(db);
            const item = computeItemLandedCost({
                baseCost: 32.03,
                estimatedFreight: 0.46,
                ratePercent: 1,
            });
            assert.equal(item.invoice_payable, 32.03);
            assert.equal(item.allocated_freight, 0.32);
            assert.equal(item.landed_cost, 32.35);

            // Same payload shape the UI persistRow sends (DEPT + FREIGHT fields)
            const saved = saveLine(db, '2026-06-02', {
                invoice_number: 'ITEM-X',
                supplier_name: 'SMS',
                grocery: 32.03,
                freight_grocery: 0.46,
            }, 'clerk');
            assert.equal(saved.grocery, 32.03);
            assert.equal(saved.freight_grocery, 0.46);
            assert.equal(saved.freight_total, 0.46);
            assert.equal(saved.total_invoice, 32.03);
            // Without persisted allocated_freight, landed is base only (invoice freight reference-only).
            assert.equal(saved.landed_purchases, 32.03);

            // Persist period department allocation onto the line (authoritative path).
            const dayAlloc = allocateFreight(0.46, FREIGHT_ALLOC_PCT);
            db.run(
                `UPDATE receiving_report_lines
                    SET applied_freight_rate=?, allocated_freight=?, eligible_merchandise=?,
                        landed_purchase_cost=?, freight_calc_source=?
                  WHERE invoice_number=?`,
                null,
                dayAlloc.grocery,
                32.03,
                roundMoney(32.03 + dayAlloc.grocery),
                'period_department_allocation',
                'ITEM-X',
            );

            upsertDayMeta(db, '2026-06-02', { receiver_name: 'Receiver', freight_total: 0.46 }, 'clerk');

            const reloaded = buildReportPayload(db, '2026-06-02');
            const line = reloaded.lines.find((l) => l.invoice_number === 'ITEM-X');
            assert.ok(line);
            assert.equal(line.grocery, 32.03);
            assert.equal(line.freight_grocery, 0.46);
            assert.equal(line.total_invoice, 32.03);
            assert.equal(line.allocated_freight, dayAlloc.grocery);
            assert.equal(line.landed_purchases, roundMoney(32.03 + dayAlloc.grocery));
            assert.equal(reloaded.freight_reconciliation.status, 'PASS');
            assert.equal(reloaded.freight_reconciliation.expected, 0.46);
            assert.equal(reloaded.freight_reconciliation.entered, 0.46);
        });
    });
});

describe('5.4.7 freight mismatch blocks cert and close', () => {
    test('expected 0.46 entered 0.30 → WARNING/FAIL and freight_reconciled FAIL', () => {
        withTestDb((db) => {
            const start = seedPeriod(db);
            saveLine(db, '2026-06-02', {
                invoice_number: 'MISMATCH',
                supplier_name: 'SYSCO',
                grocery: 32.03,
                freight_grocery: 0.30,
            }, 'clerk');
            upsertDayMeta(db, '2026-06-02', {
                receiver_name: 'Receiver',
                freight_total: 0.46,
            }, 'clerk');

            const recon = computeDayFreightReconciliation(db, '2026-06-02');
            assert.equal(recon.expected, 0.46);
            assert.equal(recon.entered, 0.30);
            assert.equal(recon.difference, -0.16);
            assert.ok(['WARNING', 'FAIL'].includes(recon.status));
            assert.equal(freightReconBlocksClose(recon), true);

            assert.throws(() => saveDayCertification(db, '2026-06-02', {
                receiving_complete: true,
                invoices_entered: true,
                references_verified: true,
                freight_verified: true,
                receiver_identified: true,
                exceptions_documented: true,
                receiver_name: 'Receiver',
                freight_total: 0.46,
            }, 'mgr'), (err) => err.status === 400);

            fillSalesAndMargin(db, start);
            const readiness = buildPeriodCloseReadiness(db, start);
            const freightCheck = readiness.checks.find((c) => c.id === 'freight_reconciled');
            assert.equal(freightCheck.status, 'fail');
            assert.equal(readiness.ready_to_close, false);
        });
    });
});

describe('5.4.8 deletion invalidates reviewed financial state', () => {
    test('certification persists explicit assertions and relevant edits invalidate all six', () => {
        withTestDb((db) => {
            seedPeriod(db);
            const line = saveLine(db, '2026-06-02', {
                supplier_name: 'SMS',
                invoice_number: 'CERT-1',
                grocery: 32.03,
                freight_grocery: 0,
            }, 'receiver');
            upsertDayMeta(db, '2026-06-02', {
                receiver_name: 'Receiver',
                freight_total: 0,
            }, 'receiver');
            saveDayCertification(db, '2026-06-02', {
                receiving_complete: true,
                invoices_entered: false,
                references_verified: false,
                freight_verified: false,
                receiver_identified: false,
                exceptions_documented: false,
            }, 'Manager A');
            let day = getDayMeta(db, '2026-06-02');
            assert.equal(day.certification.receiving_complete, true);
            assert.equal(day.certification.invoices_entered, false);
            assert.equal(day.certification.certified_at, null);

            certifyDay(db, '2026-06-02', 0);
            day = getDayMeta(db, '2026-06-02');
            assert.ok(day.certification.content_fingerprint);

            saveLine(db, '2026-06-02', {
                line_id: line.line_id,
                supplier_name: 'SMS',
                invoice_number: 'CERT-1',
                grocery: 33.03,
                freight_grocery: 0,
            }, 'receiver');
            day = getDayMeta(db, '2026-06-02');
            for (const key of [
                'receiving_complete',
                'invoices_entered',
                'references_verified',
                'freight_verified',
                'receiver_identified',
                'exceptions_documented',
            ]) assert.equal(day.certification[key], false);
            assert.equal(day.certification.content_fingerprint, '');
        });
    });

    test('deleting a freight line clears every certification flag and makes override stale', () => {
        withTestDb((db) => {
            const start = seedPeriod(db);
            const saved = saveLine(db, '2026-06-02', {
                invoice_number: 'DELETE-FREIGHT',
                supplier_name: 'SYSCO',
                grocery: 32.03,
                freight_grocery: 0.30,
            }, 'clerk');
            upsertDayMeta(db, '2026-06-02', { receiver_name: 'Receiver', freight_total: 0.46 }, 'clerk');
            saveFreightOverride(db, '2026-06-02', { reason: 'Carrier statement pending' }, 'Manager Pat');
            certifyDay(db, '2026-06-02', 0.46);

            deleteLine(db, saved.line_id, 'clerk');

            const day = db.get('SELECT * FROM receiving_report_day WHERE store_date=?', '2026-06-02');
            assert.equal(day.certified_at, null);
            assert.equal(day.certified_by, '');
            assert.equal(day.cert_content_fingerprint, '');
            assert.equal(day.cert_receiving_complete, 0);
            assert.equal(day.cert_invoices_entered, 0);
            assert.equal(day.cert_references_verified, 0);
            assert.equal(day.cert_freight_verified, 0);
            assert.equal(day.cert_receiver_identified, 0);
            assert.equal(day.cert_exceptions_documented, 0);
            assert.equal(day.freight_override_reason, '');
            assert.equal(day.freight_override_by, '');

            const recon = computeDayFreightReconciliation(db, '2026-06-02');
            assert.equal(recon.entered, 0);
            assert.equal(freightReconBlocksClose(recon), true);
            fillSalesAndMargin(db, start);
            const readiness = buildPeriodCloseReadiness(db, start);
            assert.equal(readiness.ready_to_close, false);
            assert.equal(readiness.checks.find((c) => c.id === 'freight_reconciled').status, 'fail');
        });
    });
});

describe('5.4.7 manager override + negative freight auth', () => {
    test('manager override succeeds, audits, and clears on freight edit', () => {
        withTestDb((db) => {
            seedPeriod(db);
            saveLine(db, '2026-06-02', {
                invoice_number: 'OV1',
                supplier_name: 'SYSCO',
                grocery: 10,
                freight_grocery: 0.30,
            }, 'clerk');
            upsertDayMeta(db, '2026-06-02', { receiver_name: 'R', freight_total: 0.46 }, 'clerk');

            const meta = saveFreightOverride(db, '2026-06-02', { reason: 'Invoice freight estimate pending' }, 'Manager Pat');
            assert.equal(meta.freight_reconciliation.status, 'OVERRIDE');
            assert.equal(meta.freight_override_by, 'Manager Pat');

            const audit = db.get(
                `SELECT * FROM receiving_report_financial_audit
                  WHERE store_date=? AND event_type='freight_override' ORDER BY created_at DESC`,
                '2026-06-02',
            );
            assert.ok(audit);
            const detail = JSON.parse(audit.detail_json || '{}');
            assert.equal(detail.expected, 0.46);
            assert.equal(detail.entered, 0.30);
            assert.ok(detail.difference != null);
            assert.ok(detail.tolerance != null);

            // Editing freight invalidates override
            saveLine(db, '2026-06-02', {
                line_id: listLines(db, '2026-06-02')[0].line_id,
                invoice_number: 'OV1',
                supplier_name: 'SYSCO',
                grocery: 10,
                freight_grocery: 0.40,
            }, 'clerk');
            const after = buildReportPayload(db, '2026-06-02');
            assert.notEqual(after.freight_reconciliation.status, 'OVERRIDE');
            assert.equal(String(after.freight_override_reason || ''), '');
            assert.equal(after.certified, false);
        });
    });

    test('negative freight blocked without manager exception; allowed with reason', () => {
        withTestDb((db) => {
            seedPeriod(db);
            assert.throws(() => saveLine(db, '2026-06-02', {
                invoice_number: 'NEG',
                supplier_name: 'SYSCO',
                grocery: 10,
                freight_grocery: -0.50,
            }, 'clerk'), (err) => err.status === 403 || err.code === 'NEGATIVE_FREIGHT_FORBIDDEN');

            const line = saveLine(db, '2026-06-02', {
                invoice_number: 'NEG',
                supplier_name: 'SYSCO',
                grocery: 10,
                freight_grocery: -0.50,
                negative_freight_reason: 'Supplier freight credit',
            }, 'Manager Pat', {
                allowNegativeFreight: true,
                negativeFreightReason: 'Supplier freight credit',
            });
            assert.equal(line.freight_grocery, -0.50);
            const ack = db.get(
                `SELECT * FROM receiving_report_negative_freight_acks WHERE line_id=?`,
                line.line_id,
            );
            assert.ok(ack);
            assert.equal(ack.reason, 'Supplier freight credit');
        });
    });
});

describe('5.4.7 pagination delete and overflow lines', () => {
    test('delete uses real line_id; page2 edit; 51 and 101 lines survive reload', () => {
        withTestDb((db) => {
            seedPeriod(db);
            const ids = [];
            for (let i = 1; i <= 101; i += 1) {
                const line = saveLine(db, '2026-06-03', {
                    invoice_number: `INV-${i}`,
                    supplier_name: 'SYSCO',
                    grocery: i === 51 ? 51.11 : 1,
                    freight_grocery: i === 1 ? 0.46 : 0,
                }, 'clerk');
                ids.push(line.line_id);
            }
            assert.equal(listLines(db, '2026-06-03').length, 101);

            // Edit line 51 by id
            const line51 = listLines(db, '2026-06-03').find((l) => l.invoice_number === 'INV-51');
            const edited = saveLine(db, '2026-06-03', {
                line_id: line51.line_id,
                invoice_number: 'INV-51',
                supplier_name: 'SYSCO',
                grocery: 99.99,
            }, 'clerk');
            assert.equal(edited.grocery, 99.99);

            deleteLine(db, line51.line_id);
            const afterDelete = listLines(db, '2026-06-03');
            assert.equal(afterDelete.length, 100);
            assert.ok(!afterDelete.some((l) => l.line_id === line51.line_id));

            // 51-line day
            for (let i = 1; i <= 51; i += 1) {
                saveLine(db, '2026-06-04', {
                    invoice_number: `P2-${i}`,
                    supplier_name: 'SYSCO',
                    grocery: 1,
                }, 'clerk');
            }
            assert.equal(listLines(db, '2026-06-04').length, 51);
            const reloaded = buildReportPayload(db, '2026-06-04');
            assert.equal(reloaded.lines.length, 51);
            assert.equal(reloaded.line_overflow, true);
        });
    });
});

describe('5.4.7 Excel export 51/101 + Item X', () => {
    test('daily export includes every line; Item X freight once; recon sheet present on period export', async () => {
        await withTestDb(async (db) => {
            const start = seedPeriod(db);
            confirmDeptAllocation(db, start, 'mgr');

            saveLine(db, '2026-06-02', {
                invoice_number: 'ITEM-X',
                supplier_name: 'SMS',
                grocery: 32.03,
                freight_grocery: 0.46,
            }, 'clerk');
            upsertDayMeta(db, '2026-06-02', { receiver_name: 'Receiver', freight_total: 0.46 }, 'clerk');

            for (let i = 1; i <= 51; i += 1) {
                saveLine(db, '2026-06-05', {
                    invoice_number: `D51-${i}`,
                    supplier_name: 'SYSCO',
                    grocery: 1,
                }, 'clerk');
            }
            upsertDayMeta(db, '2026-06-05', { receiver_name: 'Receiver', freight_total: 0 }, 'clerk');

            const day51 = await buildReportWorkbookBuffer(db, '2026-06-05');
            assert.equal(day51.payload.lines_written, 51);
            assert.ok(day51.payload.continuation_sheets >= 1);

            const wb51 = new ExcelJS.Workbook();
            await wb51.xlsx.load(day51.buffer);
            const invoices = [];
            wb51.eachSheet((sheet) => {
                for (let r = 6; r <= 55; r += 1) {
                    const v = sheet.getCell(`A${r}`).value;
                    if (v && String(v).trim() && String(v).trim() !== ' ') invoices.push(String(v).trim());
                }
            });
            for (let i = 1; i <= 51; i += 1) {
                assert.ok(invoices.includes(`D51-${i}`), `missing D51-${i}`);
            }

            const itemX = await buildReportWorkbookBuffer(db, '2026-06-02');
            const wbX = new ExcelJS.Workbook();
            await wbX.xlsx.load(itemX.buffer);
            const sheet = wbX.getWorksheet(itemX.payload.sheet_name);
            assert.ok(sheet);
            assert.equal(Number(sheet.getCell('C6').value), 32.03);
            assert.equal(Number(sheet.getCell('N3').value), 0.46);

            // 101-line day
            for (let i = 1; i <= 101; i += 1) {
                saveLine(db, '2026-06-06', {
                    invoice_number: `D101-${i}`,
                    supplier_name: 'SYSCO',
                    grocery: 1,
                }, 'clerk');
            }
            upsertDayMeta(db, '2026-06-06', { receiver_name: 'Receiver', freight_total: 0 }, 'clerk');
            const day101 = await buildReportWorkbookBuffer(db, '2026-06-06');
            assert.equal(day101.payload.lines_written, 101);
            assert.ok(day101.payload.continuation_sheets >= 2);

            const periodWb = await buildFullPeriodWorkbookBuffer(db, start);
            const pwb = new ExcelJS.Workbook();
            await pwb.xlsx.load(periodWb.buffer);
            const recon = pwb.getWorksheet('Pulse Freight Reconciliation');
            assert.ok(recon, 'Pulse Freight Reconciliation sheet required');
        });
    });
});

describe('5.4.7 sales blank vs confirmed zero + duplicates + snapshots', () => {
    test('blank sales blocks close; confirmed zero passes', () => {
        withTestDb((db) => {
            const start = seedPeriod(db);
            saveLine(db, '2026-06-02', {
                invoice_number: 'S1',
                supplier_name: 'SYSCO',
                grocery: 10,
            }, 'clerk');
            certifyDay(db, '2026-06-02', 0);
            saveMarginMeta(db, start, { opening_inventory: 1, closing_inventory: 1 }, 'test');
            confirmDeptAllocation(db, start, 'test');

            let readiness = buildPeriodCloseReadiness(db, start);
            assert.equal(readiness.checks.find((c) => c.id === 'sales_confirmed').status, 'fail');

            for (let w = 1; w <= 5; w += 1) {
                saveSalesZeroConfirm(db, start, '__week__', w, 'mgr', 'No sales this week');
            }
            readiness = buildPeriodCloseReadiness(db, start);
            assert.equal(readiness.checks.find((c) => c.id === 'sales_confirmed').status, 'pass');
        });
    });

    test('duplicate ack is durable and manager-scoped; different suppliers are not duplicates', () => {
        withTestDb((db) => {
            const start = seedPeriod(db);
            saveLine(db, '2026-06-02', {
                invoice_number: 'DUP-1',
                supplier_name: 'SYSCO',
                grocery: 10,
            }, 'clerk');
            saveLine(db, '2026-06-03', {
                invoice_number: 'DUP-1',
                supplier_name: 'SYSCO',
                grocery: 12,
            }, 'clerk');
            saveLine(db, '2026-06-04', {
                invoice_number: 'DUP-1',
                supplier_name: 'OTHER CO',
                grocery: 5,
            }, 'clerk');

            const groups = listDuplicateInvoiceGroups(db, start, '2026-07-05');
            assert.equal(groups.length, 1);
            assert.equal(groups[0].count, 2);

            saveDuplicateInvoiceExceptionAck(db, {
                periodStart: start,
                exceptionKey: groups[0].key,
                reason: 'Same truck split across days',
                lineIds: groups[0].lines.map((l) => l.line_id),
            }, 'Manager Pat');

            const readiness = buildPeriodCloseReadiness(db, start);
            const dupCheck = readiness.checks.find((c) => c.id === 'duplicate_invoices_resolved');
            assert.equal(dupCheck.status, 'pass');

            saveLine(db, '2026-06-05', {
                invoice_number: 'DUP-1',
                supplier_name: 'SYSCO',
                grocery: 7,
            }, 'clerk');
            const afterThird = buildPeriodCloseReadiness(db, start);
            assert.equal(
                afterThird.checks.find((c) => c.id === 'duplicate_invoices_resolved').status,
                'fail',
            );
        });
    });

    test('snapshot revisions remain after reopen/reclose; close rolls back on injected failure', () => {
        withTestDb((db) => {
            const start = seedPeriod(db);
            saveLine(db, '2026-06-02', {
                invoice_number: 'CL1',
                supplier_name: 'SYSCO',
                grocery: 10,
            }, 'clerk');
            certifyDay(db, '2026-06-02', 0);
            fillSalesAndMargin(db, start);

            submitPeriod(db, start, 'Manager Submitter');
            approvePeriod(db, start, 'Manager Approver');

            snapshotPeriod(db, start, 'mgr');
            const revs1 = listSnapshotRevisions(db, start);
            assert.ok(revs1.length >= 1);

            assert.throws(() => closeAndLockPeriod(db, start, 'mgr', {
                assertPeriodCloseReady,
                archivePeriodSalesToHistory,
                snapshotPeriod,
                auditOutbox: (d, payload) => {
                    const { writeCloseOutbox } = require('../src/lib/edmonton-receiving-integrity.cjs');
                    writeCloseOutbox(d, {
                        periodStart: payload.period_start,
                        eventType: payload.event,
                        payload,
                    });
                },
                failAt: 'snapshot',
            }), (err) => err.code === 'CLOSE_FAILURE_INJECTED');

            assert.notEqual(getPeriodStatus(db, start).status, 'locked');

            closeAndLockPeriod(db, start, 'mgr', {
                assertPeriodCloseReady,
                archivePeriodSalesToHistory,
                snapshotPeriod,
                auditOutbox: (d, payload) => {
                    const { writeCloseOutbox } = require('../src/lib/edmonton-receiving-integrity.cjs');
                    writeCloseOutbox(d, {
                        periodStart: payload.period_start,
                        eventType: payload.event,
                        payload,
                    });
                },
            });
            assert.equal(getPeriodStatus(db, start).status, 'locked');
            const revs2 = listSnapshotRevisions(db, start);
            assert.ok(revs2.length >= revs1.length);

            reopenPeriod(db, start, 'Manager Approver', 'fix totals');
            submitPeriod(db, start, 'Manager Submitter');
            approvePeriod(db, start, 'Manager Approver');
            closeAndLockPeriod(db, start, 'Manager Approver', {
                assertPeriodCloseReady,
                archivePeriodSalesToHistory,
                snapshotPeriod,
            });
            const revs3 = listSnapshotRevisions(db, start);
            assert.ok(revs3.length > revs2.length);
            // Prior revisions still present
            assert.ok(revs3.some((r) => r.revision === revs1[0].revision));
        });
    });
});

describe('5.4.7 costing comparison dairy/produce + PIN readiness + period view', () => {
    test('costing comparison uses dairy and produce_dept rollups', () => {
        withTestDb((db) => {
            const start = seedPeriod(db);
            fillSalesAndMargin(db, start);
            saveLine(db, '2026-06-02', {
                invoice_number: 'CMP',
                supplier_name: 'SYSCO',
                grocery: 100,
                dairy: 50,
                produce: 40,
                freight_grocery: 1,
                freight_dairy: 0.5,
                freight_produce: 0.4,
            }, 'clerk');
            upsertDayMeta(db, '2026-06-02', { freight_total: 1.9, receiver_name: 'R' }, 'clerk');

            const cmp = buildCostingComparisonPayload(db, start);
            const dairy = cmp.departments.find((d) => d.department === 'dairy');
            const produce = cmp.departments.find((d) => d.department === 'produce');
            assert.ok(dairy);
            assert.ok(produce);
            assert.ok(dairy.sales > 0, 'dairy sales must be nonzero from rollup');
            assert.ok(produce.sales > 0, 'produce sales must be nonzero from produce_dept');
            assert.equal(dairy.sales_available, true);
            assert.equal(produce.sales_available, true);
        });
    });

    test('default PIN 1234 fails readiness while active managers disable bootstrap', () => {
        withTestDb((db, tmp) => {
            const envFail = inspectPcAdminPin({ db, dataRoot: tmp, env: { PC_ADMIN_PIN: '1234' } });
            assert.equal(envFail.insecureDefault, true);
            assert.equal(envFail.source, 'env');

            const pinPath = path.join(tmp, 'pc-admin-pin.txt');
            fs.writeFileSync(pinPath, '1234\n');
            const fileFail = inspectPcAdminPin({ db, dataRoot: tmp, env: {} });
            assert.equal(fileFail.insecureDefault, true);
            assert.equal(fileFail.source, 'file_invalid');

            fs.unlinkSync(pinPath);
            db.run(
                `INSERT INTO staff (name, role, pin, active) VALUES ('Store Manager', 'Manager', '9999', 1)`,
            );
            const legacy = inspectPcAdminPin({ db, dataRoot: tmp, env: {} });
            assert.equal(legacy.insecureDefault, false);
            assert.equal(legacy.source, 'disabled');

            const prev = process.env.PC_ADMIN_PIN;
            process.env.PC_ADMIN_PIN = '1234';
            try {
                const report = buildProductionReadinessReport({ db });
                assert.equal(report.ok, false);
                assert.equal(report.status, 'error');
                assert.ok(report.summary.errors >= 1);
                const pinCheck = report.checks.find((c) => c.id === 'pc_admin_pin');
                assert.equal(pinCheck.status, 'error');
            } finally {
                if (prev == null) delete process.env.PC_ADMIN_PIN;
                else process.env.PC_ADMIN_PIN = prev;
            }

            process.env.PC_ADMIN_PIN = '58294731';
            try {
                const report = buildProductionReadinessReport({ db });
                const pinCheck = report.checks.find((c) => c.id === 'pc_admin_pin');
                assert.equal(pinCheck.status, 'ok');
            } finally {
                if (prev == null) delete process.env.PC_ADMIN_PIN;
                else process.env.PC_ADMIN_PIN = prev;
            }
        });
    });

    test('historical viewing does not change global operational period', () => {
        withTestDb((db) => {
            const start = seedPeriod(db, '2026-06-01');
            const operational = db.get(
                `SELECT setting_value FROM settings WHERE setting_name='Receiving_Report_Period_Start'`,
            ).setting_value;

            // Day save must never mutate operational period
            upsertDayMeta(db, '2026-06-02', { receiver_name: 'X', freight_total: 0 }, 'u1');
            let still = db.get(
                `SELECT setting_value FROM settings WHERE setting_name='Receiving_Report_Period_Start'`,
            ).setting_value;
            assert.equal(still, operational);

            // Session A activates May operational period
            activateReceivingPeriod(db, { period_start: '2026-05-03' });
            const activated = db.get(
                `SELECT setting_value FROM settings WHERE setting_name='Receiving_Report_Period_Start'`,
            ).setting_value;
            assert.equal(activated, '2026-05-03');

            // Session B views June data via day payload / dashboard without activate — restore June first as "their" view simulation
            // Viewing June report does not call activate; only day meta / buildReportPayload
            upsertSetting(db, 'Receiving_Report_Period_Start', start);
            buildReportPayload(db, '2026-05-10');
            still = db.get(
                `SELECT setting_value FROM settings WHERE setting_name='Receiving_Report_Period_Start'`,
            ).setting_value;
            assert.equal(still, start);

            // Session A had activated May; Session B's historical June view (explicit period helper) must not clobber if we only use resolvePeriodStartExplicit
            const { resolvePeriodStartExplicit } = require('../src/lib/edmonton-receiving-report.cjs');
            const viewed = resolvePeriodStartExplicit(db, { date: '2026-05-10', period_start: '2026-05-03' });
            assert.equal(viewed, '2026-05-03');
            still = db.get(
                `SELECT setting_value FROM settings WHERE setting_name='Receiving_Report_Period_Start'`,
            ).setting_value;
            assert.equal(still, start);
        });
    });
});

describe('5.4.8 migration 058', () => {
    test('fresh install reaches schema 58 with integrity completion columns', () => {
        withTestDb((db) => {
            const ver = db.get('SELECT MAX(version) AS v FROM schema_version').v;
            assert.ok(ver >= 58);
            assert.ok(db.get(`SELECT 1 AS ok FROM sqlite_master WHERE name='receiving_report_period_snapshot_revisions'`));
            assert.ok(db.get(`SELECT 1 AS ok FROM sqlite_master WHERE name='receiving_report_sales_zero_confirm'`));
            assert.ok(db.get(`SELECT 1 AS ok FROM sqlite_master WHERE name='receiving_report_negative_freight_acks'`));
            const cols = db.all(`PRAGMA table_info(receiving_report_day)`).map((c) => c.name);
            assert.ok(cols.includes('overflow_acknowledged_at'));
            assert.ok(cols.includes('cert_content_fingerprint'));
            assert.ok(cols.includes('freight_override_fingerprint'));
            const ackCols = db.all(`PRAGMA table_info(receiving_report_exception_acks)`).map((c) => c.name);
            assert.ok(ackCols.includes('group_fingerprint'));
            assert.ok(ackCols.includes('line_ids_json'));
        });
    });
});

describe('5.4.9 snapshot atomicity', () => {
    test('snapshotPeriod rolls back the current pointer when revision history insert fails', () => {
        withTestDb((db) => {
            const start = seedPeriod(db);
            upsertPeriodFreightRate(db, {
                period_start: start,
                rate_percent: 1.5207,
                actor: 'test',
            });
            db.exec('DROP TABLE receiving_report_period_snapshot_revisions');

            assert.throws(
                () => snapshotPeriod(db, start, 'Manager Test'),
                /receiving_report_period_snapshot_revisions/i,
            );
            assert.equal(
                db.get(
                    'SELECT COUNT(*) AS n FROM receiving_report_period_snapshots WHERE period_start=?',
                    start,
                ).n,
                0,
            );
        });
    });
});

describe('5.4.7 reconcileDayFreight null expected', () => {
    test('null expected is never PASS', () => {
        const r = reconcileDayFreight({ expected: null, entered: 0 });
        assert.notEqual(r.status, 'PASS');
        assert.equal(freightReconBlocksClose(r), true);
        const zero = reconcileDayFreight({ expected: 0, entered: 0 });
        assert.equal(zero.status, 'PASS');
    });
});
