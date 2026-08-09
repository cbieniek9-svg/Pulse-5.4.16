import { isManagerRole as isCanonicalManagerRole } from '../lib/roles.js';
import { SUPPORTING_DOCS } from './safeConstants.js';

export function isManagerRole(role) {
    return isCanonicalManagerRole(role);
}

export function parsePermissions(raw) {
    return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function canUseSafe(role, permissions) {
    if (isManagerRole(role)) return true;
    return parsePermissions(permissions).includes('safe');
}

export function sectionIssueNoteKey(sectionKey) {
    if (sectionKey === 'interior') return 'interior_issue_note';
    if (sectionKey === 'exterior') return 'exterior_issue_note';
    return null;
}

export function defaultInvestigationPayload() {
    return {
        incidentTypes: {},
        incidentTypeOther: '',
        descriptionLines: Array(10).fill(''),
        process: {
            hazardAssessment: null,
            controlsImplemented: null,
            jhaExists: null,
            jhaFollowed: null,
            equipmentMaterials: '',
        },
        eventTypes: {},
        substandardActs: {},
        substandardActsOther: '',
        substandardConditions: {},
        substandardConditionsOther: '',
        immediateContributions: Array.from({ length: 5 }, () => ({ idNum: '', explanation: '' })),
        rootPersonal: {},
        rootPersonalOther: '',
        rootJob: {},
        rootJobOther: '',
        rootLinks: Array.from({ length: 5 }, () => ({ idNum: '', brNum: '', explanation: '' })),
        correctiveAreas: {},
        correctiveOther: '',
        correctiveLinks: Array.from({ length: 8 }, () => ({ idNum: '', brNum: '', caNum: '', explanation: '' })),
        actionLog: Array.from({ length: 5 }, () => ({ action: '', person: '', dueDate: '' })),
        supportingDocs: Object.fromEntries(SUPPORTING_DOCS.map(([key]) => [key, { utilized: null, copyAttached: null }])),
    };
}

export function prepareInvestigation(investigation) {
    const payload = investigation.payload || {};
    const base = defaultInvestigationPayload();
    const prepared = {
        ...investigation,
        payload: {
            ...base,
            ...payload,
            process: { ...base.process, ...(payload.process || {}) },
            supportingDocs: { ...base.supportingDocs, ...(payload.supportingDocs || {}) },
        },
        person_types: investigation.person_types || {},
        witnesses: Array.isArray(investigation.witnesses) ? investigation.witnesses : [],
        signoffs: mergeSignoffs(investigation.signoffs ?? {}),
    };
    ['descriptionLines', 'immediateContributions', 'rootLinks', 'correctiveLinks', 'actionLog'].forEach((key) => {
        if (!Array.isArray(prepared.payload[key])) prepared.payload[key] = base[key];
    });
    return prepared;
}

function mergeSignoffs(signoffs) {
    const src = signoffs ?? {};
    const defaults = { name: '', date: '', signatureFile: '' };
    return {
        lead: { ...defaults, ...(src.lead || {}) },
        safety_committee: { ...defaults, ...(src.safety_committee || {}) },
        senior_management: { ...defaults, ...(src.senior_management || {}) },
    };
}

export function getPath(object, path) {
    return path.split('.').reduce((value, key) => value?.[key], object);
}

export function setPath(object, path, value) {
    const parts = path.split('.');
    const last = parts.pop();
    const target = parts.reduce((acc, key) => acc[key] ??= {}, object);
    target[last] = value;
}

export function investigationPatch(investigation) {
    const i = investigation;
    const witnesses = (i.witnesses || []).filter((w) => w?.name || w?.contact);
    return {
        report_date: i.report_date,
        report_time: i.report_time,
        report_ampm: i.report_ampm,
        retail_name: i.retail_name,
        person_involved: i.person_involved,
        incident_date: i.incident_date,
        incident_time: i.incident_time,
        incident_ampm: i.incident_ampm,
        person_types: i.person_types,
        witnesses,
        payload: i.payload,
    };
}

export function clientMissingFields(investigation) {
    const missing = [];
    const i = investigation;
    if (!String(i.incident_number || '').trim()) missing.push('Incident number');
    if (!String(i.incident_date || '').trim()) missing.push('Incident date');
    if (!String(i.person_involved || '').trim()) missing.push('Person involved');
    if (!String(i.payload?.descriptionLines?.[0] || '').trim()) missing.push('Description (line 1)');
    if (!String(i.signoffs?.lead?.name || '').trim()) missing.push('Lead investigator name');
    if (!String(i.signoffs?.lead?.signatureFile || '').trim()) missing.push('Lead investigator signature');
    return missing;
}
