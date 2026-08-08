'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMigrations } = require('../src/migrations/runner.cjs');
const {
    getPeriodStatus,
    assertPeriodEditable,
    submitPeriod,
    approvePeriod,
    reopenPeriod,
    closeAndLockPeriod,
} = require('../src/lib/edmonton-receiving-period-controls.cjs');
const { findInvoiceWarnings, saveLine } = require('../src/lib/edmonton-receiving-report.cjs');
const { setPeriodCostingMethod, COSTING_METHOD } = require('../src/lib/edmonton-receiving-costing.cjs');
const {
    DEFAULT_ALLOC_PCT_POINTS,
    upsertDraftProfile,
    confirmProfile,
} = require('../src/lib/receiving-period-freight-alloc.cjs');
const { buildDockReconciliationPayload, vendorsMatch } = require('../src/lib/edmonton-receiving-dock-reconcile.cjs');
const {
    canAccessFinancialLog,
    claimShadowAccess,
    readShadowConfig,
    updateShadowSettings,
} = require('../src/lib/edmonton-receiving-shadow.cjs');

function withTestDb(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-period-'));
    const prev = process.env.TGP_DATA_DIR;
    process.env.TGP_DATA_DIR = tmp;
    try {
        delete require.cache[require.resolve('../src/db.cjs')];
        const { db, initializeSettings, initializeDailyRhythm } = require('../src/db.cjs');
        initializeSettings();
        initializeDailyRhythm();
        runMigrations(db);
        db.run(
            `INSERT INTO settings (setting_name, setting_value) VALUES ('Receiving_Report_Period_Start', '2026-08-03')
             ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value`,
        );
        return fn(db);
    } finally {
        process.env.TGP_DATA_DIR = prev;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    }
}

function confirmCosting(db, periodStart) {
    upsertDraftProfile(db, periodStart, { ...DEFAULT_ALLOC_PCT_POINTS }, 'Manager A');
    confirmProfile(db, periodStart, 'Manager A', 'Manager confirmed allocation profile');
    setPeriodCostingMethod(db, periodStart, {
        method: COSTING_METHOD.PERIOD_DEPARTMENT_ALLOCATION,
        reason: 'Manager confirmed period department allocation',
    }, 'Manager A');
}

test('period workflow submit approve lock reopen', () => {
    withTestDb((db) => {
        const start = '2026-08-03';

        assert.equal(getPeriodStatus(db, start).status, 'open');
        confirmCosting(db, start);
        submitPeriod(db, start, { name: 'Manager A', staff_id: 101 }, { assertPeriodReady: () => ({ ready_to_close: true }) });
        assert.equal(getPeriodStatus(db, start).status, 'submitted');
        assert.throws(() => assertPeriodEditable(db, start), (err) => err.status === 423);

        reopenPeriod(db, start, { name: 'Manager A', staff_id: 101 }, 'Submitted too early');
        assert.equal(getPeriodStatus(db, start).status, 'open');

        submitPeriod(db, start, { name: 'Manager A', staff_id: 101 }, { assertPeriodReady: () => ({ ready_to_close: true }) });
        assert.throws(
            () => approvePeriod(db, start, { name: 'Manager A', staff_id: 101 }),
            (err) => err.status === 403 && err.code === 'SEPARATION_OF_DUTIES_REQUIRED',
        );
        approvePeriod(db, start, { name: 'Manager B', staff_id: 202 });
        assert.equal(getPeriodStatus(db, start).status, 'approved');

        assert.throws(() => assertPeriodEditable(db, start), (err) => err.status === 423);

        const locked = closeAndLockPeriod(db, start, { name: 'Manager B', staff_id: 202 }, {
            assertPeriodCloseReady: () => ({ ready_to_close: true }),
            archivePeriodSalesToHistory: () => {},
            snapshotPeriod: () => {},
            auditOutbox: () => {},
        });
        assert.equal(locked.status, 'locked');

        assert.throws(
            () => reopenPeriod(db, start, { name: 'Manager B', staff_id: 202 }, ''),
            /reason is required/i,
        );
        reopenPeriod(db, start, { name: 'Manager B', staff_id: 202 }, 'Correction needed');
        assert.equal(getPeriodStatus(db, start).status, 'open');
        assert.doesNotThrow(() => assertPeriodEditable(db, start));
    });
});

test('findInvoiceWarnings requires matching normalized supplier and invoice', () => {
    withTestDb((db) => {
        saveLine(db, '2026-08-04', {
            invoice_number: 'INV-100',
            supplier_name: 'SYSCO',
            grocery: 10,
        }, 'test');
        saveLine(db, '2026-08-05', {
            invoice_number: 'inv 100',
            supplier_name: 'Other',
            grocery: 5,
        }, 'test');
        saveLine(db, '2026-08-05', {
            invoice_number: ' INV 100 ',
            supplier_name: 'Sysco Foods',
            grocery: 5,
        }, 'test');

        const warnings = findInvoiceWarnings(db, '2026-08-03', {
            storeDate: '2026-08-06',
            invoiceNumber: 'INV-100',
            supplierName: 'SYSCO',
        });
        assert.equal(warnings.length, 2);
        assert.ok(warnings.every((warning) => /SYSCO/i.test(warning.supplier_name)));
    });
});

test('vendorsMatch and dock reconciliation payload', () => {
    assert.equal(vendorsMatch('THE GROCERY PEOPLE', 'Grocery People'), true);

    withTestDb((db) => {
        db.run(
            `INSERT INTO expected_orders (exp_id, vendor, expected_day, status, arrived, arrived_at)
             VALUES ('e1', 'SYSCO', 'Monday', 'Arrived', 1, '2026-08-04T10:00:00')`,
        );
        saveLine(db, '2026-08-04', {
            invoice_number: 'A1',
            supplier_name: 'SYSCO FOODS',
            grocery: 12,
        }, 'test');

        const payload = buildDockReconciliationPayload(db, '2026-08-04');
        assert.equal(payload.period_start, '2026-08-03');
        const day = payload.days.find((d) => d.store_date === '2026-08-04');
        assert.ok(day);
        assert.equal(day.matched_count, 1);
    });
});

test('closeAndLockPeriod archives approved period without editable guard', () => {
    withTestDb((db) => {
        const start = '2026-08-03';
        confirmCosting(db, start);
        submitPeriod(db, start, { name: 'Manager A', staff_id: 101 }, { assertPeriodReady: () => ({ ready_to_close: true }) });
        approvePeriod(db, start, { name: 'Manager B', staff_id: 202 });
        assert.throws(() => assertPeriodEditable(db, start), (err) => err.status === 423);

        const locked = closeAndLockPeriod(db, start, 'Manager B', {
            assertPeriodCloseReady: () => ({ ready_to_close: true }),
            archivePeriodSalesToHistory: () => {},
            snapshotPeriod: () => {},
        });
        assert.equal(locked.status, 'locked');
    });
});

test('financial log shadow mode restricts access until claimed', () => {
    withTestDb((db) => {
        assert.equal(readShadowConfig(db).shadow_mode, true);
        assert.equal(canAccessFinancialLog(db, 'Anyone'), false);

        claimShadowAccess(db, 'Test Manager');
        assert.equal(canAccessFinancialLog(db, 'Test Manager'), true);
        assert.equal(canAccessFinancialLog(db, 'Other Manager'), false);

        assert.throws(() => claimShadowAccess(db, 'Another'), (err) => err.status === 409);
    });
});

test('updateShadowSettings toggles mode and allowlist', () => {
    withTestDb((db) => {
        updateShadowSettings(db, { shadow_mode: true, allowlist: 'Manager One, Manager Two' });
        let cfg = readShadowConfig(db);
        assert.equal(cfg.shadow_mode, true);
        assert.deepEqual(cfg.allowlist, ['Manager One', 'Manager Two']);

        updateShadowSettings(db, { shadow_mode: false });
        cfg = readShadowConfig(db);
        assert.equal(cfg.shadow_mode, false);
        assert.equal(canAccessFinancialLog(db, 'Anyone'), true);

        updateShadowSettings(db, { allowlist: '' });
        cfg = readShadowConfig(db);
        assert.deepEqual(cfg.allowlist, []);
    });
});
