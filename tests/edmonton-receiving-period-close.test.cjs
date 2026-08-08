'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMigrations } = require('../src/migrations/runner.cjs');
const {
    buildReceivingChecklistSummary,
    buildPeriodCloseReadiness,
    assertPeriodCloseReady,
    saveSalesAmount,
    saveSalesZeroConfirm,
    saveMarginMeta,
} = require('../src/lib/edmonton-receiving-analytics.cjs');
const { saveLine, saveDayCertification } = require('../src/lib/edmonton-receiving-report.cjs');
const { setPeriodCostingMethod, COSTING_METHOD } = require('../src/lib/edmonton-receiving-costing.cjs');
const {
    DEFAULT_ALLOC_PCT_POINTS,
    upsertDraftProfile,
    confirmProfile,
} = require('../src/lib/receiving-period-freight-alloc.cjs');
const { upsertPeriodFreightRate } = require('../src/lib/receiving-period-freight-rates.cjs');
const { submitPeriod } = require('../src/lib/edmonton-receiving-period-controls.cjs');

function confirmDeptAllocation(db, periodStart, actor = 'test') {
    upsertDraftProfile(db, periodStart, { ...DEFAULT_ALLOC_PCT_POINTS }, actor);
    confirmProfile(db, periodStart, actor, 'Manager confirmed allocation profile');
    return setPeriodCostingMethod(db, periodStart, {
        method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        reason: 'Manager confirmed period department allocation',
    }, actor);
}

function withTestDb(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-close-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);
        return fn(db);
    } finally {
        process.env.TGP_DATA_DIR = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
}

function seedPastPeriod(db, periodStart = '2026-06-01') {
    db.run(
        `INSERT INTO settings (setting_name, setting_value) VALUES ('Receiving_Report_Period_Start', ?)
         ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value`,
        periodStart,
    );
    return periodStart;
}

test('buildReceivingChecklistSummary allows empty days when period end passed', () => {
    withTestDb((db) => {
        const start = seedPastPeriod(db);
        saveLine(db, '2026-06-02', {
            invoice_number: 'INV-CHECK-1',
            supplier_name: 'SYSCO',
            grocery: 10,
        }, 'test');

        const dayActivity = { '2026-06-02': 1 };
        const checklist = buildReceivingChecklistSummary(db, start, dayActivity);
        assert.equal(checklist.days_with_data, 1);
        assert.equal(checklist.days_with_warnings, 0);
        assert.equal(checklist.period_end_passed, true);
        assert.equal(checklist.receiving_ready, true);
    });
});

test('assertPeriodCloseReady blocks close until sales margin and day certification complete', () => {
    withTestDb((db) => {
        const start = seedPastPeriod(db);
        saveLine(db, '2026-06-02', {
            invoice_number: 'INV-CLOSE-1',
            supplier_name: 'SYSCO',
            grocery: 10,
        }, 'test');

        assert.throws(() => assertPeriodCloseReady(db, start), (err) => err.status === 400);

        for (let w = 1; w <= 5; w += 1) {
            saveSalesAmount(db, start, w, 'grocery', 100, 'test');
            saveSalesZeroConfirm(db, start, '__week__', w, 'manager', 'test remaining blanks');
        }
        saveMarginMeta(db, start, {
            opening_inventory: 1000,
            closing_inventory: 900,
        }, 'test');
        confirmDeptAllocation(db, start);
        saveDayCertification(db, '2026-06-02', {
            receiving_complete: true,
            invoices_entered: true,
            references_verified: true,
            freight_verified: true,
            receiver_identified: true,
            exceptions_documented: true,
            receiver_name: 'Receiver',
            freight_total: 0,
        }, 'test');

        const readiness = assertPeriodCloseReady(db, start);
        assert.equal(readiness.ready_to_close, true);
        assert.equal(readiness.model_status, 'PASS');
    });
});

test('buildPeriodCloseReadiness mirrors checklist gates', () => {
    withTestDb((db) => {
        const start = seedPastPeriod(db);
        const readiness = buildPeriodCloseReadiness(db, start);
        assert.equal(readiness.receiving_ready, readiness.receiving_checklist.receiving_ready);
        assert.equal(readiness.sales_ready, false);
        assert.equal(readiness.margin_ready, false);
        assert.equal(readiness.ready_to_close, false);
    });
});

test('submission and close readiness require a persisted costing selection', () => {
    withTestDb((db) => {
        const start = seedPastPeriod(db);

        assert.throws(
            () => submitPeriod(db, start, 'manager'),
            /Confirm the period costing method before submitting/i,
        );

        db.run(
            `INSERT INTO receiving_report_period_status (period_start, status, updated_at, updated_by)
             VALUES (?, 'approved', datetime('now'), 'legacy test')
             ON CONFLICT(period_start) DO UPDATE SET status='approved'`,
            start,
        );
        const readiness = buildPeriodCloseReadiness(db, start);
        const check = readiness.checks.find((row) => row.id === 'costing_method_confirmed');
        assert.equal(check.status, 'fail');

        confirmDeptAllocation(db, start, 'manager');
        assert.doesNotThrow(() => submitPeriod(db, start, 'manager'));
    });
});

test('operational periods reject non-authoritative costing confirmation', () => {
    withTestDb((db) => {
        const start = seedPastPeriod(db);
        upsertPeriodFreightRate(db, { period_start: start, rate_percent: 1.5, actor: 'manager' });
        for (const method of [
            COSTING_METHOD.INVOICE_FREIGHT,
            COSTING_METHOD.PERIOD_RATE,
            COSTING_METHOD.BASE_COST_ONLY,
        ]) {
            assert.throws(
                () => setPeriodCostingMethod(db, start, {
                    method,
                    reason: 'Attempted comparison method',
                }, 'manager'),
                (err) => err.status === 400 && err.code === 'NON_AUTHORITATIVE_COSTING_METHOD',
            );
        }
        assert.throws(
            () => setPeriodCostingMethod(db, start, {
                method: COSTING_METHOD.LEGACY_FIXED_ALLOCATION,
                reason: 'Legacy alias without profile',
            }, 'manager'),
            (err) => err.code === 'FREIGHT_ALLOC_PROFILE_MISSING',
        );
        assert.equal(
            db.get(
                `SELECT COUNT(*) AS n FROM receiving_report_period_status
                  WHERE period_start=? AND costing_method!=''`,
                start,
            )?.n || 0,
            0,
        );
    });
});

test('rejected submission keeps the period open and returns readiness details', () => {
    withTestDb((db) => {
        const start = seedPastPeriod(db);
        confirmDeptAllocation(db, start, 'manager');

        assert.throws(
            () => submitPeriod(db, start, { name: 'Manager A', staff_id: 101 }),
            (err) => err.status === 400
                && Array.isArray(err.readiness?.failed_checks)
                && err.readiness.failed_checks.length > 0,
        );
        assert.equal(
            db.get('SELECT status FROM receiving_report_period_status WHERE period_start=?', start).status,
            'open',
        );
    });
});
