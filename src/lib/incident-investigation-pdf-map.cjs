'use strict';

// Coordinates measured from upright Appendix B page JPEGs (1700×2200 → 612×792).
// Checkbox coords are box centers. Text coords are baselines just above ruling lines.

const {
    EVENT_TYPES,
    SUBSTANDARD_ACTS,
    SUBSTANDARD_CONDITIONS,
    ROOT_PERSONAL,
    ROOT_JOB,
    CORRECTIVE_AREAS,
    SUPPORTING_DOCS,
} = require('./incident-investigation-catalog.cjs');

const CHECK = 10;
const BODY = 11;
const SMALL = 10;

function columnChecks(entries, { page, x, startY, rowH, keyFn, size = CHECK }) {
    return entries.map((entry, index) => ({
        key: keyFn(entry),
        page,
        x,
        y: +(startY - index * rowH).toFixed(1),
        size,
    }));
}

function ynTriple(key, page, y, xs, size = CHECK) {
    return [
        { key, page, x: xs.yes, y, size, equals: 'yes' },
        { key, page, x: xs.no, y, size, equals: 'no' },
        { key, page, x: xs.na, y, size, equals: 'na' },
    ];
}

function tableRows(count, page, startY, rowH, columns) {
    const texts = [];
    for (let index = 0; index < count; index += 1) {
        const y = +(startY - index * rowH).toFixed(1);
        for (const col of columns) {
            texts.push({
                key: col.key.replace('{i}', String(index)),
                page,
                x: col.x,
                y,
                size: col.size || BODY,
                maxWidth: col.maxWidth,
                maxLines: col.maxLines || 1,
                lineGap: col.lineGap,
            });
        }
    }
    return texts;
}

// --- Page 0 ---
// Underscores (thin rules): Incident # ~645; Date/Time of Report ~621; Retail ~591; Person ~569; Incident date/time ~523
const DESC_Ys = [270, 251, 233, 215, 197, 178, 159, 141, 122, 103];
const incidentTypeCols = [76, 240.1, 395.6];
const incidentTypeRowYs = [393.8, 378, 361.8, 345.6, 329.4];
const incidentTypeRows = [
    ['first_aid', 'motor_vehicle_incident', 'near_miss'],
    ['medical_aid_no_lost_time', 'contractor_recordable', 'third_party_incident'],
    ['restricted_work', 'property_damage', 'spill_or_release'],
    ['lost_time', 'fire_explosion_flood', 'work_refusal'],
    ['fatality', 'violence_or_harassment', 'other'],
];

const page0Texts = [
    { key: 'incident_number', page: 0, x: 155, y: 646, size: 12, maxWidth: 340 },
    { key: 'report_date', page: 0, x: 155, y: 623, size: BODY, maxWidth: 120 },
    { key: 'report_time', page: 0, x: 400, y: 623, size: BODY, maxWidth: 70 },
    { key: 'retail_name', page: 0, x: 175, y: 592, size: 12, maxWidth: 400 },
    { key: 'person_involved', page: 0, x: 285, y: 570, size: 12, maxWidth: 290 },
    { key: 'incident_date', page: 0, x: 155, y: 524, size: BODY, maxWidth: 120 },
    { key: 'incident_time', page: 0, x: 400, y: 524, size: BODY, maxWidth: 70 },
    { key: 'witnesses.0.name', page: 0, x: 72, y: 508, size: BODY, maxWidth: 165 },
    { key: 'witnesses.1.name', page: 0, x: 248, y: 508, size: BODY, maxWidth: 165 },
    { key: 'witnesses.2.name', page: 0, x: 428, y: 508, size: BODY, maxWidth: 150 },
];

// Description is reflowed across these ruling-line slots so long narrative is not cut.
const descriptionSlots = DESC_Ys.map((y) => ({
    page: 0, x: 88, y: y - 2, size: BODY, maxWidth: 500,
}));

const page0Checks = [
    { key: 'person_types.full_time', page: 0, x: 119.2, y: 552.6, size: CHECK },
    { key: 'person_types.part_time', page: 0, x: 248.8, y: 551.5, size: CHECK },
    { key: 'person_types.contractor', page: 0, x: 387, y: 550.5, size: CHECK },
    { key: 'person_types.customer', page: 0, x: 478.1, y: 550.8, size: CHECK },
    // AM/PM on the Date/Time of Report row (~621) and Incident time row (~523).
    { key: 'report_ampm', page: 0, x: 498, y: 622, size: CHECK, equals: 'AM' },
    { key: 'report_ampm', page: 0, x: 525.6, y: 622, size: CHECK, equals: 'PM' },
    { key: 'incident_ampm', page: 0, x: 498, y: 524, size: CHECK, equals: 'AM' },
    { key: 'incident_ampm', page: 0, x: 525.6, y: 524, size: CHECK, equals: 'PM' },
    ...incidentTypeRows.flatMap((row, rowIndex) => row.map((key, colIndex) => ({
        key: `payload.incidentTypes.${key}`,
        page: 0,
        x: incidentTypeCols[colIndex],
        y: incidentTypeRowYs[rowIndex],
        size: CHECK,
    }))),
];

// --- Page 1 ---
// Process Yes/No/NA measured at x=391 / 440 / 489, rows 654/638/622/606
const processYs = [654.1, 637.9, 621.7, 605.5];
const processKeys = [
    'payload.process.hazardAssessment',
    'payload.process.controlsImplemented',
    'payload.process.jhaExists',
    'payload.process.jhaFollowed',
];
const processXs = { yes: 391, no: 440, na: 489 };

// Acts/conditions: measured columns; start at first measured row (not above headers).
const ACT_X = 74.5;
const COND_X = 325.1;
const ACT_START = 381.2;
const ACT_ROW = 15.54;

// Type of Event is column-major on the form: 5 / 5 / 3 items down each column.
const eventXs = [74, 232, 370];
const eventStartY = 517.3;
const eventRowH = 15.1;
function eventSlot(index) {
    if (index < 5) return { col: 0, row: index };
    if (index < 10) return { col: 1, row: index - 5 };
    return { col: 2, row: index - 10 };
}

const page1Checks = [
    ...processKeys.flatMap((key, index) => ynTriple(key, 1, processYs[index], processXs)),
    ...EVENT_TYPES.map((entry, index) => {
        const { col, row } = eventSlot(index);
        return {
            key: `payload.eventTypes.${entry.key}`,
            page: 1,
            x: eventXs[col],
            y: +(eventStartY - row * eventRowH).toFixed(1),
            size: CHECK,
        };
    }),
    ...columnChecks(SUBSTANDARD_ACTS, {
        page: 1, x: ACT_X, startY: ACT_START, rowH: ACT_ROW,
        keyFn: (e) => `payload.substandardActs.${e.key}`,
    }),
    ...columnChecks(SUBSTANDARD_CONDITIONS, {
        page: 1, x: COND_X, startY: ACT_START, rowH: ACT_ROW,
        keyFn: (e) => `payload.substandardConditions.${e.key}`,
    }),
];

const page1Texts = [
    { key: 'payload.process.equipmentMaterials', page: 1, x: 260, y: 571, size: BODY, maxWidth: 320 },
    { key: 'payload.substandardActsOther', page: 1, x: 115, y: 97, size: SMALL, maxWidth: 200 },
    { key: 'payload.substandardConditionsOther', page: 1, x: 365, y: 97, size: SMALL, maxWidth: 200 },
];

// --- Page 2 ---
// Immediate table data-row baselines (above cell bottom rules ~619…548).
const page2Texts = [
    ...tableRows(5, 2, 622, 17.7, [
        { key: 'payload.immediateContributions.{i}.idNum', x: 72, maxWidth: 48 },
        { key: 'payload.immediateContributions.{i}.explanation', x: 125, maxWidth: 450, maxLines: 2, lineGap: 8 },
    ]),
    { key: 'payload.rootPersonalOther', page: 2, x: 115, y: 305, size: SMALL, maxWidth: 200, maxLines: 2, lineGap: 8 },
    { key: 'payload.rootJobOther', page: 2, x: 365, y: 305, size: SMALL, maxWidth: 200, maxLines: 2, lineGap: 8 },
    // "How does Immediate contribute to Basic/Root" — lift baselines off the cell floors.
    ...tableRows(5, 2, 221, 17.6, [
        { key: 'payload.rootLinks.{i}.idNum', x: 72, maxWidth: 42 },
        { key: 'payload.rootLinks.{i}.brNum', x: 125, maxWidth: 42 },
        { key: 'payload.rootLinks.{i}.explanation', x: 180, maxWidth: 390, maxLines: 2, lineGap: 8 },
    ]),
];

// Basic/Root checkboxes: first item under column headers (not on the header text).
// Personal column x≈72; Job/System column x≈333 (not 398).
const ROOT_START = 437.5;
const ROOT_ROW = 14.6;
const page2Checks = [
    ...columnChecks(ROOT_PERSONAL.filter((e) => e.key !== 'other'), {
        page: 2, x: 74, startY: ROOT_START, rowH: ROOT_ROW,
        keyFn: (e) => `payload.rootPersonal.${e.key}`,
    }),
    { key: 'payload.rootPersonal.other', page: 2, x: 74, y: 317, size: CHECK },
    ...columnChecks(ROOT_JOB.filter((e) => e.key !== 'other'), {
        page: 2, x: 335, startY: ROOT_START, rowH: ROOT_ROW,
        keyFn: (e) => `payload.rootJob.${e.key}`,
    }),
    { key: 'payload.rootJob.other', page: 2, x: 335, y: 316, size: CHECK },
];

// --- Page 3 ---
// CA columns measured: left x=74.3 start 640.1; right x=334.4 start 639.4; gap≈14.9
const page3Checks = [
    ...columnChecks(CORRECTIVE_AREAS.slice(0, 11), {
        page: 3, x: 74.3, startY: 640.1, rowH: 14.9,
        keyFn: (e) => `payload.correctiveAreas.${e.key}`,
    }),
    ...columnChecks(CORRECTIVE_AREAS.slice(11), {
        page: 3, x: 334.4, startY: 639.4, rowH: 14.9,
        keyFn: (e) => `payload.correctiveAreas.${e.key}`,
    }),
];

const page3Texts = [
    { key: 'payload.correctiveOther', page: 3, x: 115, y: 469, size: SMALL, maxWidth: 240, maxLines: 2, lineGap: 8 },
    ...tableRows(5, 3, 380, 17.6, [
        { key: 'payload.correctiveLinks.{i}.idNum', x: 72, maxWidth: 40 },
        { key: 'payload.correctiveLinks.{i}.brNum', x: 118, maxWidth: 40 },
        { key: 'payload.correctiveLinks.{i}.caNum', x: 165, maxWidth: 40 },
        { key: 'payload.correctiveLinks.{i}.explanation', x: 220, maxWidth: 350, maxLines: 2, lineGap: 8 },
    ]),
    // Action Log — keep text above cell bottom rules.
    ...tableRows(5, 3, 192, 17.6, [
        { key: 'payload.actionLog.{i}.action', x: 72, maxWidth: 260, maxLines: 2, lineGap: 8 },
        { key: 'payload.actionLog.{i}.person', x: 345, maxWidth: 125 },
        { key: 'payload.actionLog.{i}.dueDate', x: 485, maxWidth: 80 },
    ]),
];

// --- Page 4 ---
// Supporting-doc data rows (gap≈17.6). Copy-attached column measured; utilized Yes/No @104.5/167.
// Supporting-doc row centers (copy-attached column hollow-box measure).
const DOC_Ys = [584, 567, 549, 531, 514, 496, 479, 461];
const page4Checks = SUPPORTING_DOCS.flatMap((entry, index) => {
    const y = DOC_Ys[index];
    return [
        { key: `payload.supportingDocs.${entry.key}.utilized`, page: 4, x: 104.5, y, size: CHECK, equals: 'yes' },
        { key: `payload.supportingDocs.${entry.key}.utilized`, page: 4, x: 167, y, size: CHECK, equals: 'no' },
        { key: `payload.supportingDocs.${entry.key}.copyAttached`, page: 4, x: 419.4, y, size: CHECK, equals: 'yes' },
        { key: `payload.supportingDocs.${entry.key}.copyAttached`, page: 4, x: 484.5, y, size: CHECK, equals: 'no' },
    ];
});

// Sign-off: Name col @178, Date @332, Signature @422; row baselines mid-cell
const page4Texts = [
    { key: 'signoffs.lead.name', page: 4, x: 178, y: 363, size: 12, maxWidth: 150 },
    { key: 'signoffs.lead.date', page: 4, x: 332, y: 363, size: 12, maxWidth: 80 },
    { key: 'signoffs.safety_committee.name', page: 4, x: 178, y: 328, size: 12, maxWidth: 150 },
    { key: 'signoffs.safety_committee.date', page: 4, x: 332, y: 328, size: 12, maxWidth: 80 },
    { key: 'signoffs.senior_management.name', page: 4, x: 178, y: 293, size: 12, maxWidth: 150 },
    { key: 'signoffs.senior_management.date', page: 4, x: 332, y: 293, size: 12, maxWidth: 80 },
];

const images = [
    { key: 'signoffs.lead.signatureFile', page: 4, x: 422, y: 348, width: 115, height: 30, resolvePath: true },
    { key: 'signoffs.safety_committee.signatureFile', page: 4, x: 422, y: 313, width: 115, height: 30, resolvePath: true },
    { key: 'signoffs.senior_management.signatureFile', page: 4, x: 422, y: 278, width: 115, height: 30, resolvePath: true },
];

module.exports = {
    texts: [...page0Texts, ...page1Texts, ...page2Texts, ...page3Texts, ...page4Texts],
    checks: [...page0Checks, ...page1Checks, ...page2Checks, ...page3Checks, ...page4Checks],
    images,
    descriptionSlots,
};
