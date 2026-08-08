'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMigrations } = require('../src/migrations/runner.cjs');
const {
    listAvailablePeriods,
    activateReceivingPeriod,
    saveSalesAmount,
    saveMarginMeta,
} = require('../src/lib/edmonton-receiving-analytics.cjs');

function withTestDb(fn) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'log-period-list-'));
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

test('listAvailablePeriods merges margin, sales, and settings rows', () => {
    withTestDb((db) => {
        saveMarginMeta(db, '2026-05-04', { period_number: 7, opening_inventory: 1, closing_inventory: 2 }, 'test');
        saveSalesAmount(db, '2026-06-08', 1, 'grocery', 100, 'test');
        db.run(
            `INSERT INTO settings (setting_name, setting_value) VALUES ('Receiving_Report_Period_Start', '2026-07-13')
             ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value`,
        );

        const periods = listAvailablePeriods(db);
        assert.ok(periods.some((p) => p.period_number === 7));
        assert.ok(periods.some((p) => p.period_start === '2026-06-08'));
        assert.ok(periods.some((p) => p.period_start === '2026-07-13'));
    });
});

test('activateReceivingPeriod resolves by period number', () => {
    withTestDb((db) => {
        saveMarginMeta(db, '2026-07-13', {
            period_number: 9,
            is_count_period: 1,
            opening_inventory: 100,
            closing_inventory: 90,
        }, 'test');

        const activated = activateReceivingPeriod(db, { period_number: 9 });
        assert.equal(activated.period_start, '2026-07-13');
        assert.equal(activated.operational_period_start, '2026-07-13');
        assert.equal(activated.period_number, 9);
        assert.equal(activated.is_count_period, true);
    });
});
