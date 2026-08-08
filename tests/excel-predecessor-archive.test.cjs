'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { baselineEstMinutes, listQuickMissChecks } = require('../src/lib/task-estimate-baselines.cjs');
const { buildMinimumHoursComparison, minimumHoursForWeekday } = require('../src/lib/labor-minimum-baseline.cjs');
const { getAuditWalkPayload, getStoreWalkChecklist } = require('../src/lib/audit-walk-templates.cjs');
const { listVendorDirectoryContacts } = require('../src/lib/vendor-directory.cjs');

test('baselineEstMinutes maps Store walk and Back stock from archive', () => {
    assert.equal(baselineEstMinutes('Store walk'), 30);
    assert.equal(baselineEstMinutes('Back stock'), 120);
    assert.equal(baselineEstMinutes('TGP Order'), 60);
});

test('listQuickMissChecks returns archive prompts', () => {
    const checks = listQuickMissChecks();
    assert.ok(checks.length >= 5);
    assert.ok(checks.some((c) => /FIFO/i.test(c.check)));
});

test('buildMinimumHoursComparison flags overage above threshold', () => {
    const monMin = minimumHoursForWeekday('Monday');
    assert.ok(monMin > 0);
    const over = buildMinimumHoursComparison(monMin * 1.2, 'Monday', { Labor_Soft_Overage_Threshold_Pct: '10' });
    assert.equal(over.over_minimum, true);
    const under = buildMinimumHoursComparison(monMin * 1.05, 'Monday', { Labor_Soft_Overage_Threshold_Pct: '10' });
    assert.equal(under.over_minimum, false);
});

test('getAuditWalkPayload includes store walk items', () => {
    const payload = getAuditWalkPayload();
    assert.ok(payload.item_counts.store_walk > 10);
    const sections = getStoreWalkChecklist();
    assert.ok(sections.some((s) => /EXTERIOR/i.test(s.section)));
});

test('listVendorDirectoryContacts includes Coke and rep phone', () => {
    const contacts = listVendorDirectoryContacts();
    const coke = contacts.find((c) => /coke/i.test(c.vendor));
    assert.ok(coke);
    assert.ok(coke.phone || coke.rep);
});
