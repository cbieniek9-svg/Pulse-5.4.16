'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyReceivingLogCorrection } = require('../src/lib/receiving-log-correction.cjs');

function makeDb(order, stats = []) {
    const writes = [];
    return {
        order,
        stats: [...stats],
        get(sql, id) {
            if (sql.includes('expected_orders')) return this.order;
            return null;
        },
        run(sql, ...params) {
            writes.push({ sql, params });
            if (sql.includes('UPDATE expected_orders')) {
                const [, arrived_at, departed_at, invoice_ref, status] = params;
                this.order = {
                    ...this.order,
                    arrived: params[0],
                    arrived_at,
                    departed_at,
                    invoice_ref,
                    status,
                    time_closed: params[5],
                    closed_by: params[6],
                };
            }
            if (sql.includes('INSERT OR REPLACE INTO receiving_stats')) {
                this.stats = [{
                    id: params[0],
                    vendor: params[1],
                    arrival_time: params[2],
                    completion_time: params[3],
                    duration_mins: params[4],
                    processed_by: params[5],
                }];
            }
            if (sql.includes('DELETE FROM receiving_stats')) {
                this.stats = this.stats.filter((s) => s.id !== params[0]);
            }
            return { changes: 1 };
        },
        writes,
    };
}

test('applyReceivingLogCorrection updates times, invoice, and receiving_stats', () => {
    const db = makeDb({
        exp_id: 'E-1',
        vendor: 'TGP',
        status: 'Closed',
        arrived: 1,
        arrived_at: '2026-07-01T14:00:00.000Z',
        departed_at: '2026-07-01T16:30:00.000Z',
        departed_by: 'Alex',
        invoice_ref: '',
    });

    const result = applyReceivingLogCorrection(db, {
        expId: 'E-1',
        arrivedAt: '2026-07-01T14:00:00.000Z',
        departedAt: '2026-07-01T15:00:00.000Z',
        invoiceRef: 'INV-12345',
        actorName: 'Manager',
    });

    assert.equal(result.invoice_ref, 'INV-12345');
    assert.equal(result.duration_mins, 60);
    assert.equal(db.stats.length, 1);
    assert.equal(db.stats[0].duration_mins, 60);
    assert.equal(db.stats[0].id, 'STAT-E-1');
});

test('applyReceivingLogCorrection rejects time out before time in', () => {
    const db = makeDb({
        exp_id: 'E-2',
        vendor: 'Sysco',
        status: 'Closed',
        arrived: 1,
        arrived_at: '2026-07-01T15:00:00.000Z',
        departed_at: '2026-07-01T16:00:00.000Z',
    });

    assert.throws(() => applyReceivingLogCorrection(db, {
        expId: 'E-2',
        arrivedAt: '2026-07-01T15:00:00.000Z',
        departedAt: '2026-07-01T14:30:00.000Z',
        actorName: 'Manager',
    }), /on or after/);
});

test('applyReceivingLogCorrection allows adding invoice after time out', () => {
    const db = makeDb({
        exp_id: 'E-3',
        vendor: 'US Foods',
        status: 'Closed',
        arrived: 1,
        arrived_at: '2026-07-01T13:00:00.000Z',
        departed_at: '2026-07-01T13:45:00.000Z',
        invoice_ref: '',
    });

    const result = applyReceivingLogCorrection(db, {
        expId: 'E-3',
        arrivedAt: '2026-07-01T13:00:00.000Z',
        departedAt: '2026-07-01T13:45:00.000Z',
        invoiceRef: 'PO-999',
        actorName: 'Manager',
    });

    assert.equal(result.invoice_ref, 'PO-999');
    assert.equal(db.stats[0].duration_mins, 45);
});
