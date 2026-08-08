'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    addDays,
    receiverName,
    buildFileMaintenanceReceivingLogPayload,
    renderFileMaintenanceReceivingLogHtml,
    renderFileMaintenanceReceivingLogCsv,
} = require('../src/lib/file-maintenance-receiving-log.cjs');

test('file maintenance receiving log builds simple next-day invoice control rows', () => {
    const calls = [];
    const db = {
        getSettings() { return { Store_Timezone: 'America/Edmonton' }; },
        all(sql, ...params) {
            calls.push({ sql, params });
            if (sql.includes('PRAGMA table_info')) return [{ name: 'invoice_ref' }];
            return [
                {
                    exp_id: 'E1',
                    vendor: 'Coke',
                    expected_day: '2026-06-22',
                    status: 'Closed',
                    arrived_at: '2026-06-22T15:12:00.000Z',
                    arrived_by: 'Sarah',
                    departed_at: '2026-06-22T15:34:00.000Z',
                    departed_by: 'Sarah',
                    closed_by: 'Sarah',
                    time_closed: '2026-06-22T15:34:00.000Z',
                    invoice_ref: 'INV-123',
                    category: 'general',
                },
                {
                    exp_id: 'E2',
                    vendor: 'Pepsi',
                    expected_day: '2026-06-22',
                    status: 'Arrived',
                    arrived_at: '2026-06-22T18:00:00.000Z',
                    arrived_by: 'Morgan',
                    departed_at: '',
                    departed_by: '',
                    closed_by: '',
                    time_closed: '',
                    invoice_ref: '',
                    category: 'general',
                },
            ];
        },
    };

    const payload = buildFileMaintenanceReceivingLogPayload(db, '2026-06-22');

    assert.equal(payload.rows.length, 2);
    assert.equal(payload.rows[0].vendor, 'Coke');
    assert.equal(payload.rows[0].invoice_ref, 'INV-123');
    assert.equal(payload.rows[0].receiver, 'Sarah');
    assert.equal(payload.rows[1].notes, 'Not timed out');
    assert.equal(payload.open_count, 1);
    const orderCall = calls.find((c) => c.sql.includes('FROM expected_orders'));
    assert.match(orderCall.sql, /arrived=1/);
    assert.match(orderCall.sql, /arrived_at IS NOT NULL/);
    assert.doesNotMatch(orderCall.sql, /expected_day=\?/);

    const html = renderFileMaintenanceReceivingLogHtml(payload, 'Test Store');
    assert.match(html, /Receiving Log/);
    assert.doesNotMatch(html, /File Maintenance/);
    assert.match(html, /INV-123/);
    assert.match(html, /Not timed out/);

    const csv = renderFileMaintenanceReceivingLogCsv(payload);
    assert.match(csv, /Invoice \/ Ref #/);
    assert.match(csv, /INV-123/);
});

test('file maintenance helper handles receiver handoff names and date math', () => {
    assert.equal(addDays('2026-06-23', -1), '2026-06-22');
    assert.equal(receiverName({ arrived_by: 'Sarah', departed_by: 'James' }), 'Sarah / out by James');
    assert.equal(receiverName({ arrived_by: 'Sarah', departed_by: 'Sarah' }), 'Sarah');
    assert.equal(receiverName({ departed_by: 'James' }), 'James');
});

test('payload falls back when invoice_ref column is not present yet', () => {
    const db = {
        getSettings() { return {}; },
        all(sql) {
            if (sql.includes('PRAGMA table_info')) return [];
            assert.match(sql, /'' AS invoice_ref/);
            return [];
        },
    };
    const payload = buildFileMaintenanceReceivingLogPayload(db, '2026-06-22');
    assert.equal(payload.rows.length, 0);
});

test('file maintenance print excludes never-arrived Archived schedule ghosts', () => {
    const db = {
        getSettings() { return { Store_Timezone: 'America/Edmonton' }; },
        all(sql) {
            if (sql.includes('PRAGMA table_info')) return [{ name: 'invoice_ref' }];
            if (!sql.includes('FROM expected_orders')) return [];
            // Simulate DB filter: only return rows that would match arrived=1 + arrived_at.
            // Ghosts (arrived=0 / null arrived_at) must not be in the result set.
            assert.match(sql, /arrived=1/);
            assert.doesNotMatch(sql, /OR expected_day=\?/);
            return [
                {
                    exp_id: 'E-REAL',
                    vendor: 'TGP',
                    expected_day: '2026-07-28',
                    status: 'Closed',
                    arrived_at: '2026-07-28T15:06:00.000Z',
                    arrived_by: 'Ashley',
                    departed_at: '2026-07-28T16:09:00.000Z',
                    departed_by: 'Ashley',
                    closed_by: 'Ashley',
                    time_closed: '2026-07-28T16:09:00.000Z',
                    invoice_ref: '',
                    category: 'general',
                },
            ];
        },
    };
    const payload = buildFileMaintenanceReceivingLogPayload(db, '2026-07-28');
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].vendor, 'TGP');
    assert.equal(payload.rows[0].time_out, '2026-07-28T16:09:00.000Z');
});
