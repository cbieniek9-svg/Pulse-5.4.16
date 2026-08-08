'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
    buildInvestigationPdf,
    fitSingleLine,
    wrapAllText,
    collectDescriptionText,
} = require('../src/lib/incident-investigation-pdf.cjs');

const minimalFilled = {
    id: 'II-test',
    incident_number: 'INV-20260128-001',
    status: 'draft',
    report_date: '2026-01-28',
    report_time: '09:30',
    report_ampm: 'AM',
    retail_name: 'Test Store',
    person_involved: 'Test Person',
    person_types: { full_time: true },
    incident_date: '2026-01-28',
    incident_time: '09:15',
    incident_ampm: 'AM',
    witnesses: [{ name: 'Witness One' }, { name: 'Witness Two' }],
    payload: {
        incidentTypes: { first_aid: true },
        descriptionLines: ['A test incident description.'],
        process: { hazardAssessment: 'yes', controlsImplemented: 'yes', jhaExists: 'na', jhaFollowed: 'na', equipmentMaterials: 'Pallet jack' },
        eventTypes: { struck_by: true },
        substandardActs: { act_07: true },
        substandardConditions: { cond_27: true },
        immediateContributions: [{ idNum: '7', explanation: 'PPE not used correctly during the task.' }],
        rootPersonal: { root_personal_05: true },
        rootJob: { root_job_14: true },
        rootLinks: [{ idNum: '7', brNum: '5', explanation: 'Lack of knowledge led to PPE misuse.' }],
        correctiveAreas: { ca_11: true },
        correctiveLinks: [
            { idNum: '7', brNum: '5', caNum: '11', explanation: 'Reinforce PPE expectations.' },
            { idNum: '', brNum: '', caNum: '', explanation: '' },
            { idNum: '', brNum: '', caNum: '', explanation: '' },
            { idNum: '', brNum: '', caNum: '', explanation: '' },
            { idNum: '', brNum: '', caNum: '', explanation: '' },
            { idNum: '7', brNum: '14', caNum: '10', explanation: 'Extra row six training follow-up.' },
        ],
        actionLog: [{ action: 'Retrain team on PPE', person: 'Supervisor', dueDate: '2026-02-01' }],
        supportingDocs: { doc_photos: { utilized: 'yes', copyAttached: 'yes' } },
    },
    signoffs: {
        lead: { name: 'Lead Investigator', date: '2026-01-28', signatureFile: '' },
        safety_committee: { name: '', date: '', signatureFile: '' },
        senior_management: { name: '', date: '', signatureFile: '' },
    },
};

test('buildInvestigationPdf returns upright multi-page Letter PDF', async () => {
    const bytes = await buildInvestigationPdf({ investigation: minimalFilled, attachmentFiles: [] });
    assert.ok(bytes.byteLength > 1000);
    const doc = await PDFDocument.load(bytes);
    assert.ok(doc.getPageCount() >= 1);
    for (const page of doc.getPages()) {
        assert.equal(page.getRotation().angle, 0);
        assert.equal(page.getSize().width, 612);
        assert.equal(page.getSize().height, 792);
    }
});

test('fitSingleLine never drops characters', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const long = 'This is a fairly long corrective action description for the log';
    const fitted = fitSingleLine(font, long, 11, 120);
    assert.equal(fitted.text, long);
    assert.ok(fitted.size < 11);
});

test('wrapAllText keeps every word across form lines and overflow', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const words = Array.from({ length: 80 }, (_, i) => `token${i}`);
    const narrative = words.join(' ');
    const packed = wrapAllText(font, narrative, 11, 160, { maxLines: 2 });
    const kept = `${packed.lines.join(' ')} ${packed.overflow}`.trim().split(/\s+/);
    assert.deepEqual(kept, words);
    assert.ok(packed.overflow.length > 0);
});

test('collectDescriptionText joins all chronological lines', () => {
    const text = collectDescriptionText({
        payload: { descriptionLines: ['First detail.', '', 'Third detail.'] },
    });
    assert.equal(text, 'First detail. Third detail.');
});

test('long description grows the generated PDF instead of truncating', async () => {
    const words = Array.from({ length: 900 }, (_, i) => `word${i}`);
    const narrative = words.join(' ');
    const filled = {
        ...minimalFilled,
        payload: {
            ...minimalFilled.payload,
            descriptionLines: [narrative, 'trailing line kept'],
            correctiveLinks: Array.from({ length: 8 }, (_, i) => ({
                idNum: String(i + 1),
                brNum: String(i + 1),
                caNum: String(i + 1),
                explanation: `Extra row explanation ${i + 1} with more detail than a tiny box can hold`,
            })),
        },
    };
    const shortBytes = await buildInvestigationPdf({ investigation: minimalFilled, attachmentFiles: [] });
    const longBytes = await buildInvestigationPdf({ investigation: filled, attachmentFiles: [] });
    const shortDoc = await PDFDocument.load(shortBytes);
    const longDoc = await PDFDocument.load(longBytes);
    assert.ok(longDoc.getPageCount() >= shortDoc.getPageCount());
    assert.ok(longBytes.byteLength > shortBytes.byteLength);
});
