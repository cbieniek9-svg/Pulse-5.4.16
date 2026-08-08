'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
    INCIDENT_TYPES,
    EVENT_TYPES,
    SUBSTANDARD_ACTS,
    SUBSTANDARD_CONDITIONS,
    ROOT_PERSONAL,
    ROOT_JOB,
    CORRECTIVE_AREAS,
    SUPPORTING_DOCS,
} = require('../src/lib/incident-investigation-catalog.cjs');
const {
    nextIncidentNumber,
    createInvestigation,
    listInvestigations,
    getInvestigation,
    updateInvestigation,
    signInvestigationRole,
    submitInvestigation,
    validateForSubmit,
    addAttachment,
    getAttachment,
    deleteAttachment,
} = require('../src/lib/incident-investigations.cjs');

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function withTempDataRoot(t) {
    const previous = process.env.TGP_DATA_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-unit-'));
    process.env.TGP_DATA_DIR = dir;
    t.after(() => {
        if (previous === undefined) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    });
}

function makeDb() {
    const investigations = [];
    const attachments = [];
    return {
        exec() { /* schema noop for tests */ },
        get(sql, ...params) {
            const q = String(sql);
            if (q.includes('MAX(CAST(SUBSTR(incident_number')) {
                const prefix = String(params[0]).replace('%', '');
                const numbers = investigations
                    .filter((row) => row.incident_number.startsWith(prefix))
                    .map((row) => Number(row.incident_number.slice(-3)));
                return { next_number: numbers.length ? Math.max(...numbers) : 0 };
            }
            if (q.includes('FROM incident_investigations WHERE id')) {
                return investigations.find((row) => row.id === params[0]) || null;
            }
            if (q.includes('FROM incident_investigation_attachments') && q.includes('WHERE id')) {
                return attachments.find(
                    (row) => row.id === params[0] && row.investigation_id === params[1],
                ) || null;
            }
            return null;
        },
        all(sql, ...params) {
            const q = String(sql);
            if (q.includes('FROM incident_investigation_attachments')) {
                return attachments.filter((row) => row.investigation_id === params[0]);
            }
            if (q.includes('FROM incident_investigations')) {
                let rows = investigations.slice();
                if (q.includes('status = ?')) rows = rows.filter((row) => row.status === params[0]);
                return rows.slice(0, params[params.length - 1]);
            }
            return [];
        },
        run(sql, ...params) {
            const q = String(sql);
            if (q.startsWith('INSERT INTO incident_investigations')) {
                const [
                    id, incident_number, status, retail_name, person_types_json, witnesses_json,
                    payload_json, signoffs_json, created_at, created_by, updated_at, updated_by,
                ] = params;
                investigations.push({
                    id, incident_number, status, retail_name, person_types_json, witnesses_json,
                    payload_json, signoffs_json, created_at, created_by, updated_at, updated_by,
                    report_date: null, report_time: null, report_ampm: null, person_involved: null,
                    incident_date: null, incident_time: null, incident_ampm: null,
                    submitted_at: null, submitted_by: null,
                    last_submitted_at: null, last_submitted_by: null,
                });
            } else if (q.startsWith('UPDATE incident_investigations')) {
                const row = investigations.find((item) => item.id === params[params.length - 1]);
                if (!row) return;
                if (q.includes("status = 'submitted'")) {
                    row.status = 'submitted';
                    if (q.includes('last_submitted_at') || q.includes('last_submitted_by')) {
                        [row.last_submitted_at, row.last_submitted_by, row.updated_at, row.updated_by] = params;
                    } else {
                        [row.submitted_at, row.submitted_by, row.updated_at, row.updated_by] = params;
                    }
                    return;
                }
                const fields = q.match(/(\w+) = \?/g).map((entry) => entry.slice(0, -4));
                fields.forEach((field, index) => { row[field] = params[index]; });
            } else if (q.startsWith('INSERT INTO incident_investigation_attachments')) {
                const [
                    id, investigation_id, kind, original_name, stored_name, mime,
                    size_bytes, created_at, created_by,
                ] = params;
                attachments.push({
                    id, investigation_id, kind, original_name, stored_name, mime,
                    size_bytes, created_at, created_by,
                });
            } else if (q.startsWith('INSERT INTO incident_investigation_amend_events')) {
                // amend event persistence is covered by integrity tests against real sqlite
            } else if (q.startsWith('DELETE FROM incident_investigation_attachments')) {
                const index = attachments.findIndex(
                    (row) => row.id === params[0] && row.investigation_id === params[1],
                );
                if (index >= 0) attachments.splice(index, 1);
            }
        },
    };
}

test('Appendix B catalog lists match paper form counts', () => {
    assert.equal(INCIDENT_TYPES.length, 15); // includes Other
    assert.equal(EVENT_TYPES.length, 13);
    assert.equal(SUBSTANDARD_ACTS.length, 20);
    assert.equal(SUBSTANDARD_CONDITIONS.length, 20);
    assert.equal(ROOT_PERSONAL.length, 9); // 1-8 + Other
    assert.equal(ROOT_JOB.length, 9); // 9-16 + Other
    assert.equal(CORRECTIVE_AREAS.length, 22);
    assert.equal(SUPPORTING_DOCS.length, 8);
});

test('nextIncidentNumber increments within a store day', () => {
    const db = makeDb();
    const first = createInvestigation(db, {
        actorName: 'Pat',
        serverTime: '2026-01-28T12:00:00.000Z',
        storeDateStamp: '2026-01-28',
        retailName: 'Test Store',
    });
    assert.equal(first.incident_number, 'INV-20260128-001');
    assert.equal(nextIncidentNumber(db, '2026-01-28'), 'INV-20260128-002');
});

test('createInvestigation creates a draft with initialized payload', () => {
    const db = makeDb();
    const investigation = createInvestigation(db, {
        actorName: 'Pat',
        serverTime: '2026-01-28T12:00:00.000Z',
        storeDateStamp: '2026-01-28',
        retailName: 'Test Store',
    });
    assert.equal(investigation.status, 'draft');
    assert.equal(investigation.retail_name, 'Test Store');
    assert.equal(investigation.payload.descriptionLines.length, 10);
    assert.deepEqual(Object.keys(investigation.payload.supportingDocs), SUPPORTING_DOCS.map((doc) => doc.key));
    assert.equal(investigation.payload_json, undefined);
    assert.equal(investigation.signoffs_json, undefined);
    assert.equal(investigation.person_types_json, undefined);
    assert.equal(investigation.witnesses_json, undefined);
    assert.deepEqual(listInvestigations(db, { status: 'draft' }).map((row) => row.id), [investigation.id]);
});

test('updateInvestigation rejects invalid JSON string patches', () => {
    const db = makeDb();
    const created = createInvestigation(db, {
        actorName: 'Pat',
        serverTime: '2026-01-28T12:00:00.000Z',
        storeDateStamp: '2026-01-28',
        retailName: 'Test Store',
    });
    assert.throws(
        () => updateInvestigation(db, created.id, { payload: '{bad' }, 'Pat', '2026-01-28T13:00:00.000Z'),
        (err) => err.status === 400 && /Invalid JSON for payload/.test(err.message),
    );
});

test('submitInvestigation requires mandatory fields and submits complete investigation', (t) => {
    withTempDataRoot(t);
    const db = makeDb();
    const created = createInvestigation(db, {
        actorName: 'Pat',
        serverTime: '2026-01-28T12:00:00.000Z',
        storeDateStamp: '2026-01-28',
        retailName: 'Test Store',
    });
    assert.deepEqual(validateForSubmit(created), [
        'Incident date',
        'Person involved',
        'Description (line 1)',
        'Lead investigator name',
        'Lead investigator signature',
    ]);
    assert.throws(
        () => submitInvestigation(db, created.id, 'Pat', '2026-01-28T13:00:00.000Z'),
        (err) => err.status === 400 && err.missing.includes('Incident date'),
    );

    updateInvestigation(db, created.id, {
        incident_date: '2026-01-28',
        person_involved: 'unknown',
        payload: { ...created.payload, descriptionLines: ['Wet floor', ...created.payload.descriptionLines.slice(1)] },
    }, 'Pat', '2026-01-28T13:00:00.000Z');
    signInvestigationRole(db, created.id, 'lead', PNG_DATA_URL, 'Pat', {
        isManager: false,
        storeDate: '2026-01-28',
        serverTime: '2026-01-28T13:30:00.000Z',
    });
    const submitted = submitInvestigation(db, created.id, 'Pat', '2026-01-28T14:00:00.000Z');
    assert.equal(submitted.status, 'submitted');
    assert.deepEqual(getInvestigation(db, created.id).attachments, []);
});

test('attachment helpers scope reads and deletion to their investigation', () => {
    const db = makeDb();
    const created = createInvestigation(db, {
        actorName: 'Pat',
        serverTime: '2026-01-28T12:00:00.000Z',
        storeDateStamp: '2026-01-28',
        retailName: 'Test Store',
    });
    const attachment = addAttachment(db, created.id, {
        kind: 'photo',
        originalName: 'scene.jpg',
        storedName: 'scene-unique.jpg',
        mime: 'image/jpeg',
        sizeBytes: 42,
        actorName: 'Pat',
        serverTime: '2026-01-28T12:05:00.000Z',
    });

    assert.equal(attachment.investigation_id, created.id);
    assert.equal(getAttachment(db, created.id, attachment.id).stored_name, 'scene-unique.jpg');
    assert.equal(getAttachment(db, 'another-investigation', attachment.id), null);
    assert.equal(deleteAttachment(db, created.id, attachment.id), true);
    assert.equal(getAttachment(db, created.id, attachment.id), null);
});
