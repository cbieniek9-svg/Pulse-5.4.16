'use strict';

/**
 * /rec is the React portal (client/src/rec). These assertions pin the live surface —
 * not the orphaned rec.html file that used to be the portal.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', 'client', 'src', 'rec');
const recApp = fs.readFileSync(path.join(root, 'RecApp.jsx'), 'utf8');
const timeEdit = fs.readFileSync(path.join(root, 'TimeEditPanel.jsx'), 'utf8');

test('/rec exposes print rec log controls without Reports access UI', () => {
    assert.match(recApp, /PRINT REC LOG/);
    assert.match(recApp, /openRecLog\('print'\)/);
    assert.match(recApp, /openRecLog\('csv'\)/);
    assert.match(recApp, /receiving-file-maintenance\?date=/);
    assert.doesNotMatch(recApp, /Reports access/i);
});

test('/rec file maintenance export uses session header, not query token', () => {
    assert.match(recApp, /'x-session-token':\s*token/);
    assert.doesNotMatch(recApp, /receiving-file-maintenance[^`"']*token=/);
});

test('/rec defaults file maintenance date to the previous store date', () => {
    assert.match(recApp, /setMaintDate/);
    assert.match(recApp, /addDays\([^,]+,\s*-1\)/);
});

test('/rec exposes editable time in/out on today rec log', () => {
    assert.match(recApp, /TimeEditPanel/);
    assert.match(timeEdit, /\/api\/receiving-log-correction/);
    assert.match(timeEdit, /type="date"/);
    assert.match(timeEdit, /type="time"/);
    assert.match(recApp, /REC_STREAM_TABLES|usePortalStream/);
});

test('/rec time-out captures optional invoice reference', () => {
    assert.match(recApp, /INVOICE \/ REF # \(OPTIONAL\)/);
    assert.match(recApp, /receiving_mark_departed[\s\S]*invoice_ref:\s*outInvoice\.trim\(\)/);
});

test('/rec.html permanently redirects to the React /rec portal', () => {
    const boot = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'lib', 'app-boot.cjs'), 'utf8');
    assert.match(boot, /'\/rec\.html':\s*'\/rec'/);
    assert.match(boot, /res\.redirect\(301,\s*to\)/);
    assert.doesNotMatch(boot, /sendFile\(path\.join\(appRoot,\s*'rec\.html'\)\)/);
});
