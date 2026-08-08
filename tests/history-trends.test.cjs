'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    resolveOperationalRetentionDays,
    resolveTrendWindowDays,
    addDays,
    dateRange,
    localizeSnapshotDateSql,
    snapshotsToCsv,
} = require('../src/lib/history-trends.cjs');

test('retention defaults to 365 days and clamps unsafe values', () => {
    assert.equal(resolveOperationalRetentionDays({}), 365);
    assert.equal(resolveOperationalRetentionDays({ Operational_Retention_Days: '90' }), 90);
    assert.equal(resolveOperationalRetentionDays({ Operational_Retention_Days: '5' }), 30);
    assert.equal(resolveOperationalRetentionDays({ Operational_Retention_Days: '99999' }), 3650);
});

test('trend window defaults to 90 and supports report settings', () => {
    assert.equal(resolveTrendWindowDays({}), 90);
    assert.equal(resolveTrendWindowDays({ Report_Trend_Window_Days: '30' }), 30);
    assert.equal(resolveTrendWindowDays({}, 180), 180);
    assert.equal(resolveTrendWindowDays({}, 3), 7);
});

test('date helpers produce inclusive ranges', () => {
    assert.equal(addDays('2026-06-22', -1), '2026-06-21');
    assert.deepEqual(dateRange('2026-06-20', '2026-06-22'), ['2026-06-20', '2026-06-21', '2026-06-22']);
});

test('snapshot CSV is spreadsheet-safe', () => {
    const csv = snapshotsToCsv([
        { store_date: '2026-06-22', tasks_created: 1, manager_on_duty: '=bad' },
    ]);
    assert.match(csv, /store_date/);
    assert.match(csv, /"'=bad"/);
});


test('snapshot SQL localizes UTC timestamp buckets without shifting date-only fields', () => {
    const sql = `
        SELECT COUNT(*) FROM tasks WHERE date(time_closed)=? AND date(kill_date)=?
    `;
    const localized = localizeSnapshotDateSql(sql, '-360 minutes');
    assert.match(localized, /date\(time_closed, '-360 minutes'\)=\?/);
    assert.match(localized, /date\(kill_date\)=\?/);
});
