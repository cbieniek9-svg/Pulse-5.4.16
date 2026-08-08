'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isCsFullEnabled,
    isCsHubEnabled,
    isBetacsEnabled,
    bucketDueOrders,
} = require('../src/lib/special-orders.cjs');

test('isCsFullEnabled reads Cs_Full_Enabled and falls back to Betacs_Enabled', () => {
    assert.equal(isCsFullEnabled({ Cs_Full_Enabled: '1' }), true);
    assert.equal(isCsFullEnabled({ Cs_Full_Enabled: '0', Betacs_Enabled: '1' }), false);
    assert.equal(isCsFullEnabled({ Betacs_Enabled: '1' }), true);
    assert.equal(isCsFullEnabled({}), false);
    assert.equal(isBetacsEnabled({ Cs_Full_Enabled: '1' }), true);
});

test('isCsHubEnabled defaults off', () => {
    assert.equal(isCsHubEnabled({}), false);
    assert.equal(isCsHubEnabled({ Cs_Hub_Enabled: '0' }), false);
    assert.equal(isCsHubEnabled({ Cs_Hub_Enabled: '1' }), true);
});

test('config crm flag shape documented via isCsCrmEnabled', () => {
    const { isCsCrmEnabled, isCsCrmActive } = require('../src/lib/cs-customers.cjs');
    assert.equal(isCsCrmEnabled({ Cs_Crm_Enabled: '0' }), false);
    assert.equal(isCsCrmActive({ Cs_Crm_Enabled: '1', Cs_Full_Enabled: '1' }), true);
    // /api/cs/config exposes crm only when both CRM and CS_Full are on
    const crm = isCsCrmEnabled({ Cs_Crm_Enabled: '1', Cs_Full_Enabled: '1' })
        && isCsFullEnabled({ Cs_Full_Enabled: '1' });
    assert.equal(crm, true);
});

test('bucketDueOrders splits overdue / today / upcoming', () => {
    const buckets = bucketDueOrders([
        { order_id: '1', needed_by: '2026-07-10' },
        { order_id: '2', needed_by: '2026-07-17' },
        { order_id: '3', needed_by: '2026-07-20' },
        { order_id: '4', needed_by: '' },
    ], '2026-07-17');
    assert.equal(buckets.overdue.map((o) => o.order_id).join(','), '1');
    assert.equal(buckets.dueToday.map((o) => o.order_id).join(','), '2');
    assert.deepEqual(buckets.upcoming.map((o) => o.order_id).sort(), ['3', '4']);
    assert.equal(buckets.overdueCount, 1);
});
