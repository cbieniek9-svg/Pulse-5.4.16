'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

function importClientModule(relativePath) {
    return import(pathToFileURL(path.join(__dirname, '..', relativePath)).href);
}

test('receiving time formatter returns a placeholder for invalid timestamps', async () => {
    const { fmtTime } = await importClientModule('client/src/rec/recUtils.js');

    assert.equal(fmtTime('not-a-timestamp'), '—');
    assert.equal(fmtTime(''), '—');
});

test('prepared investigation signoffs retain fields omitted by a partial API payload', async () => {
    const { prepareInvestigation } = await importClientModule('client/src/safe/safeUtils.js');
    const prepared = prepareInvestigation({
        payload: {},
        signoffs: {
            lead: { name: 'Alex' },
            safety_committee: { date: '2026-08-08' },
        },
    });

    assert.deepEqual(prepared.signoffs.lead, {
        name: 'Alex',
        date: '',
        signatureFile: '',
    });
    assert.deepEqual(prepared.signoffs.safety_committee, {
        name: '',
        date: '2026-08-08',
        signatureFile: '',
    });
    assert.deepEqual(prepared.signoffs.senior_management, {
        name: '',
        date: '',
        signatureFile: '',
    });
});

test('prepared investigation succeeds when signoffs is null', async () => {
    const { prepareInvestigation } = await importClientModule('client/src/safe/safeUtils.js');
    const prepared = prepareInvestigation({
        payload: {},
        signoffs: null,
    });

    assert.deepEqual(prepared.signoffs, {
        lead: { name: '', date: '', signatureFile: '' },
        safety_committee: { name: '', date: '', signatureFile: '' },
        senior_management: { name: '', date: '', signatureFile: '' },
    });
});
