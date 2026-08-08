'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReceivingLogPayload, renderReceivingLogPrintHtml } = require('../src/lib/receiving-log-export.cjs');

function mockDb({ stats = [], deliveries = [], settings = {} } = {}) {
    return {
        getSettings: () => settings,
        all(sql, ...params) {
            if (sql.includes('receiving_stats')) return stats;
            if (sql.includes('expected_orders')) {
                const day = params[0];
                return deliveries.filter((d) => {
                    if (d.category === 'hardware') return false;
                    if (!d.arrived_at) return false;
                    if (d.status === 'Pending') return false;
                    return String(d.arrived_at).slice(0, 10) === day;
                });
            }
            return [];
        },
    };
}

test('buildReceivingLogPayload uses store timezone in SQL date filters', () => {
    const calls = [];
    const db = {
        getSettings: () => ({ Store_Timezone: 'America/Edmonton' }),
        all(sql, day) {
            calls.push({ sql, day });
            if (sql.includes('receiving_stats')) {
                return [{
                    vendor: 'Evening Vendor',
                    processed_by: 'Sam',
                    duration_mins: 30,
                    arrival_time: '2026-06-09T02:30:00.000Z',
                    completion_time: '2026-06-09T03:00:00.000Z',
                }];
            }
            if (sql.includes('expected_orders')) {
                return [{
                    vendor: 'Evening Vendor',
                    status: 'Closed',
                    expected_day: 'Monday',
                    arrived_at: '2026-06-09T02:30:00.000Z',
                    departed_at: '2026-06-09T03:00:00.000Z',
                    arrived_by: 'Sam',
                    category: 'general',
                }];
            }
            return [];
        },
    };
    const payload = buildReceivingLogPayload(db, '2026-06-08');
    assert.match(calls[0].sql, /date\(arrival_time, '[+-]\d+ minutes'\)/);
    assert.match(calls[1].sql, /date\(arrived_at, '[+-]\d+ minutes'\)/);
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].vendor, 'Evening Vendor');
});

test('buildReceivingLogPayload rejects bad date', () => {
    assert.throws(() => buildReceivingLogPayload(mockDb(), 'bad'), /YYYY-MM-DD/);
});

test('buildReceivingLogPayload merges deliveries and stats for a day', () => {
    const db = mockDb({
        stats: [{
            vendor: 'SYSCO',
            processed_by: 'Sam',
            duration_mins: 42,
            arrival_time: '2026-06-08T14:00:00.000Z',
            completion_time: '2026-06-08T14:42:00.000Z',
        }],
        deliveries: [{
            vendor: 'SYSCO',
            status: 'Closed',
            expected_day: 'Monday',
            arrived_at: '2026-06-08T14:00:00.000Z',
            departed_at: '2026-06-08T14:42:00.000Z',
            arrived_by: 'Sam',
            departed_by: 'Sam',
            category: 'general',
            item: '',
            invoice_ref: 'INV-12345',
        }],
    });
    const payload = buildReceivingLogPayload(db, '2026-06-08');
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.rows[0].vendor, 'SYSCO');
    assert.equal(payload.rows[0].invoice_ref, 'INV-12345');
    assert.equal(payload.rows[0].expected_day, 'Monday');
    assert.equal(payload.rows[0].duration_mins, 42);
    const html = renderReceivingLogPrintHtml(payload, 'Test Store');
    assert.match(html, /SYSCO/);
    assert.match(html, /INV-12345/);
    assert.match(html, /INVOICE \/ REF #/);
    assert.match(html, /Monday/);
    assert.match(html, /EXPECTED/);
});

test('buildReceivingLogPayload keeps same-day Archived rows and drops old arrivals', () => {
    const db = mockDb({
        stats: [],
        deliveries: [
            {
                vendor: 'POST-EOD',
                status: 'Archived',
                expected_day: 'Monday',
                arrived_at: '2026-06-08T10:00:00.000Z',
                category: 'general',
            },
            {
                vendor: 'OLD',
                status: 'Closed',
                expected_day: 'Sunday',
                arrived_at: '2026-06-07T10:00:00.000Z',
                departed_at: '2026-06-08T11:00:00.000Z',
                category: 'general',
            },
            {
                vendor: 'TODAY',
                status: 'Closed',
                expected_day: 'Monday',
                arrived_at: '2026-06-08T14:00:00.000Z',
                category: 'general',
            },
        ],
    });
    const payload = buildReceivingLogPayload(db, '2026-06-08');
    assert.equal(payload.rows.length, 2);
    assert.ok(payload.rows.some((r) => r.vendor === 'TODAY'));
    assert.ok(payload.rows.some((r) => r.vendor === 'POST-EOD'));
});
