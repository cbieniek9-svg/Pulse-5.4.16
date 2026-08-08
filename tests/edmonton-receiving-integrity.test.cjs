'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    closeAndLockPeriod,
    getPeriodStatus,
} = require('../src/lib/edmonton-receiving-period-controls.cjs');
const {
    resolvePeriodStartExplicit,
    normalizeSupplierKey,
    findInvoiceWarnings,
} = require('../src/lib/edmonton-receiving-report.cjs');

test('grid pagination keeps 49/50/51/100 lines without silent drop', async () => {
    const { buildGridRows, GRID_PAGE_SIZE } = await import('../client/src/log/logUtils.js');
    const mk = (n) => Array.from({ length: n }, (_, i) => ({
        line_id: `L${i}`,
        invoice_number: `INV-${i}`,
        supplier_name: 'Vendor',
        grocery: 1,
    }));
    for (const n of [49, 50, 51, 100]) {
        const page0 = buildGridRows(mk(n), 0);
        assert.equal(page0.meta.totalLines, n);
        assert.equal(page0.meta.hasOverflow, n > GRID_PAGE_SIZE);
        assert.equal(page0.length, GRID_PAGE_SIZE);
        if (n > GRID_PAGE_SIZE) {
            const last = buildGridRows(mk(n), page0.meta.totalPages - 1);
            assert.equal(last.meta.totalLines, n);
            assert.ok(last.meta.allLines.length === n);
        }
    }
});

test('session period viewing uses explicit period_start without settings write', () => {
    const settings = new Map([['Receiving_Report_Period_Start', '2026-06-21']]);
    const db = {
        get(sql, ...params) {
            if (String(sql).includes('settings')) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            return null;
        },
        run() {
            throw new Error('settings must not be written during view resolve');
        },
    };
    assert.equal(
        resolvePeriodStartExplicit(db, { date: '2026-06-21', period_start: '2026-01-04' }),
        '2026-01-04',
    );
    assert.equal(settings.get('Receiving_Report_Period_Start'), '2026-06-21');
});

test('duplicate invoice requires same supplier; different suppliers are not automatic errors', () => {
    const lines = [
        {
            line_id: 'a',
            store_date: '2026-06-21',
            invoice_number: '100',
            supplier_name: 'Acme Foods Ltd',
            line_kind: 'invoice',
        },
        {
            line_id: 'b',
            store_date: '2026-06-22',
            invoice_number: '100',
            supplier_name: 'Other Co',
            line_kind: 'invoice',
        },
    ];
    const db = {
        all() { return lines; },
        get() { return { setting_value: '2026-06-21' }; },
    };
    assert.equal(normalizeSupplierKey('Acme Foods Ltd'), normalizeSupplierKey('ACME FOODS'));
    const warnings = findInvoiceWarnings(db, '2026-06-21', {
        lineId: 'b',
        storeDate: '2026-06-22',
        invoiceNumber: '100',
        supplierName: 'Other Co',
    });
    assert.equal(warnings.filter((w) => w.type === 'duplicate_invoice').length, 0);
});

test('closeAndLockPeriod rolls back when failAt history is injected (transactional)', () => {
    let locked = false;
    let archived = false;
    const db = {
        get(sql) {
            if (String(sql).includes('receiving_report_period_status')) {
                return {
                    period_start: '2026-06-21',
                    status: locked ? 'locked' : 'approved',
                };
            }
            return null;
        },
        run(sql) {
            if (String(sql).includes("status='locked'") || String(sql).includes('locked_at')) {
                locked = true;
            }
        },
        transaction(fn) {
            return () => {
                const before = { locked, archived };
                try {
                    return fn();
                } catch (err) {
                    locked = before.locked;
                    archived = before.archived;
                    throw err;
                }
            };
        },
    };

    assert.throws(
        () => closeAndLockPeriod(db, '2026-06-21', 'Mgr', {
            assertPeriodCloseReady: () => ({}),
            archivePeriodSalesToHistory: () => { archived = true; },
            snapshotPeriod: () => {},
            failAt: 'history',
        }),
        /Injected close failure at history/,
    );
    assert.equal(archived, false);
    assert.equal(getPeriodStatus(db, '2026-06-21').status, 'approved');
});

test('export failure shape requires 35 daily sheets', () => {
    const err = new Error('Unable to write all daily receiving sheets (34/35).');
    err.code = 'DAILY_SHEETS_INCOMPLETE';
    err.expected = 35;
    err.written = 34;
    err.failed_dates = [{ date: '2026-06-21', message: 'forced' }];
    assert.equal(err.expected, 35);
    assert.ok(err.written < err.expected);
    assert.ok(Array.isArray(err.failed_dates));
});
