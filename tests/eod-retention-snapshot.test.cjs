'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('EOD uses configurable retention and snapshots before purge', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.cjs'), 'utf8');
    assert.match(src, /resolveOperationalRetentionDays/);
    assert.match(src, /buildDailyReportSnapshot/);
    assert.doesNotMatch(src, /90 \* 24 \* 60 \* 60 \* 1000/);
    assert.match(src, /Operational_Retention_Days|retentionDays/);
});
