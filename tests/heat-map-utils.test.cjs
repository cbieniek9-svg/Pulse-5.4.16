'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { heatMapLastAuditIso, isHeatMapZoneCold } = require('../src/lib/heat-map-utils.cjs');

test('heatMapLastAuditIso reads object and legacy string shapes', () => {
    assert.equal(heatMapLastAuditIso('2026-06-27T12:00:00.000Z'), '2026-06-27T12:00:00.000Z');
    assert.equal(heatMapLastAuditIso({ last_audit: '2026-06-27T10:00:00.000Z', status: 'pass' }), '2026-06-27T10:00:00.000Z');
    assert.equal(heatMapLastAuditIso(null), '');
});

test('isHeatMapZoneCold treats missing and stale audits as cold', () => {
    const now = Date.parse('2026-06-27T16:00:00.000Z');
    const threshold = 4 * 60 * 60 * 1000;
    assert.equal(isHeatMapZoneCold(null, now, threshold), true);
    assert.equal(isHeatMapZoneCold({ last_audit: '2026-06-27T10:00:00.000Z' }, now, threshold), true);
    assert.equal(isHeatMapZoneCold({ last_audit: '2026-06-27T15:30:00.000Z' }, now, threshold), false);
});
