'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('EOD sweep does not delete Daily Direction or Shift Updates tables', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.cjs'), 'utf8');
    const destructive = [
        /DELETE\s+FROM\s+daily_direction/i,
        /DELETE\s+FROM\s+shift_updates/i,
        /UPDATE\s+daily_direction\s+SET\s+.*posted_at\s*=\s*NULL/i,
        /UPDATE\s+shift_updates\s+SET\s+/i,
    ];
    destructive.forEach((pattern) => {
        assert.equal(pattern.test(src), false, `EOD should not match ${pattern}`);
    });
});

test('reports page allows historical Daily Direction rendering', () => {
    // Live Reports are the React SPA — public/js/reports is an orphaned twin.
    const section = fs.readFileSync(
        path.join(__dirname, '..', 'client', 'src', 'reports', 'sections', 'DailyDirectionSection.jsx'),
        'utf8',
    );
    assert.match(section, /DAILY DIRECTION\{isHistorical \? ' — ARCHIVE' : ''\}/);
    assert.match(section, /Saved manager-posted Daily Direction/);
});
