'use strict';

const fs = require('fs');
const path = require('path');
const { getDataRoot } = require('../paths.cjs');
const { SUPPORTING_DOCS } = require('./incident-investigation-catalog.cjs');

const SIGN_ROLES = {
    lead: { managerOnly: false },
    safety_committee: { managerOnly: true },
    senior_management: { managerOnly: true },
};

const PNG_DATA_URL_RE = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/;

const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS incident_investigations (
      id TEXT PRIMARY KEY,
      incident_number TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'draft',
      report_date TEXT,
      report_time TEXT,
      report_ampm TEXT,
      retail_name TEXT,
      person_involved TEXT,
      person_types_json TEXT NOT NULL DEFAULT '{}',
      incident_date TEXT,
      incident_time TEXT,
      incident_ampm TEXT,
      witnesses_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL DEFAULT '{}',
      signoffs_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      submitted_at TEXT,
      submitted_by TEXT,
      last_submitted_by TEXT,
      last_submitted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS incident_investigation_attachments (
      id TEXT PRIMARY KEY,
      investigation_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      original_name TEXT NOT NULL,
      stored_name TEXT NOT NULL,
      mime TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_investigation_amend_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      investigation_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ii_status_date ON incident_investigations(status, incident_date DESC);
    CREATE INDEX IF NOT EXISTS idx_ii_att_inv ON incident_investigation_attachments(investigation_id);
    CREATE INDEX IF NOT EXISTS idx_ii_amend_inv
      ON incident_investigation_amend_events(investigation_id, created_at);
`;

function hasColumn(db, table, column) {
    return (db.all(`PRAGMA table_info(${table})`) || []).some((row) => row.name === column);
}

function defaultPayload() {
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
        correctiveLinks: Array.from(
            { length: 8 },
            () => ({ idNum: '', brNum: '', caNum: '', explanation: '' }),
        ),
        actionLog: Array.from({ length: 5 }, () => ({ action: '', person: '', dueDate: '' })),
        supportingDocs: Object.fromEntries(
            SUPPORTING_DOCS.map(({ key }) => [key, { utilized: null, copyAttached: null }]),
        ),
    };
}

function defaultSignoffs() {
    return {
        lead: { name: '', date: '', signatureFile: '' },
        safety_committee: { name: '', date: '', signatureFile: '' },
        senior_management: { name: '', date: '', signatureFile: '' },
    };
}

function ensureIncidentInvestigationSchema(db) {
    db.exec(SCHEMA_SQL);
    if (!hasColumn(db, 'incident_investigations', 'last_submitted_by')) {
        db.exec('ALTER TABLE incident_investigations ADD COLUMN last_submitted_by TEXT');
    }
    if (!hasColumn(db, 'incident_investigations', 'last_submitted_at')) {
        db.exec('ALTER TABLE incident_investigations ADD COLUMN last_submitted_at TEXT');
    }
}

function formatDay(storeDateStamp) {
    const day = String(storeDateStamp || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const err = new Error('Store date must be YYYY-MM-DD.');
        err.status = 400;
        throw err;
    }
    return day.replace(/-/g, '');
}

function nextIncidentNumber(db, storeDateStamp) {
    const day = formatDay(storeDateStamp);
    const prefix = `INV-${day}-`;
    const row = db.get(
        `SELECT MAX(CAST(SUBSTR(incident_number, -3) AS INTEGER)) AS next_number
         FROM incident_investigations WHERE incident_number LIKE ?`,
        `${prefix}%`,
    ) || {};
    return `${prefix}${String((Number(row.next_number) || 0) + 1).padStart(3, '0')}`;
}

function parseJson(value, fallback) {
    if (typeof value !== 'string') return value == null ? fallback : value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function parsePatchJson(value, fieldLabel) {
    if (typeof value !== 'string') return value;
    try {
        return JSON.parse(value);
    } catch {
        const err = new Error(`Invalid JSON for ${fieldLabel}.`);
        err.status = 400;
        throw err;
    }
}

function serializeJson(value, fallback) {
    return JSON.stringify(value == null ? fallback : value);
}

function hydrate(row) {
    if (!row) return null;
    const {
        person_types_json,
        witnesses_json,
        payload_json,
        signoffs_json,
        ...rest
    } = row;
    return {
        ...rest,
        person_types: parseJson(person_types_json, {}),
        witnesses: parseJson(witnesses_json, []),
        payload: parseJson(payload_json, defaultPayload()),
        signoffs: parseJson(signoffs_json, defaultSignoffs()),
    };
}

function getAttachmentsDir(investigationId) {
    return path.join(getDataRoot(), 'data', 'incident_investigations', String(investigationId));
}

function assertDraftMutable(row) {
    if (String(row?.status) !== 'draft') {
        const err = new Error('Investigation is locked after submit. A manager must reopen it to amend.');
        err.status = 409;
        err.code = 'INVESTIGATION_LOCKED';
        throw err;
    }
}

function appendAmendEvent(db, investigationId, action, actorName, serverTime, note = null) {
    db.run(
        `INSERT INTO incident_investigation_amend_events (
            investigation_id, action, actor_name, created_at, note
         ) VALUES (?,?,?,?,?)`,
        investigationId,
        action,
        actorName,
        serverTime,
        note,
    );
}

function getAttachment(db, investigationId, attachmentId) {
    return db.get(
        `SELECT * FROM incident_investigation_attachments
         WHERE id = ? AND investigation_id = ?`,
        attachmentId,
        investigationId,
    ) || null;
}

function addAttachment(db, investigationId, {
    kind,
    originalName,
    storedName,
    mime,
    sizeBytes,
    actorName,
    serverTime = new Date().toISOString(),
}) {
    const investigation = getInvestigation(db, investigationId);
    if (!investigation) {
        const err = new Error('Investigation not found.');
        err.status = 404;
        throw err;
    }
    assertDraftMutable(investigation);
    const id = `IIA-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    db.run(
        `INSERT INTO incident_investigation_attachments (
            id, investigation_id, kind, original_name, stored_name, mime,
            size_bytes, created_at, created_by
         ) VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        investigationId,
        kind,
        originalName,
        storedName,
        mime || null,
        Number(sizeBytes) || 0,
        serverTime,
        actorName,
    );
    return getAttachment(db, investigationId, id);
}

function deleteAttachment(db, investigationId, attachmentId) {
    const investigation = getInvestigation(db, investigationId);
    if (!investigation) return false;
    assertDraftMutable(investigation);
    const attachment = getAttachment(db, investigationId, attachmentId);
    if (!attachment) return false;
    db.run(
        'DELETE FROM incident_investigation_attachments WHERE id = ? AND investigation_id = ?',
        attachmentId,
        investigationId,
    );
    return true;
}

function getInvestigation(db, id) {
    const row = db.get('SELECT * FROM incident_investigations WHERE id = ?', id);
    if (!row) return null;
    return {
        ...hydrate(row),
        attachments: db.all(
            `SELECT * FROM incident_investigation_attachments
             WHERE investigation_id = ? ORDER BY created_at ASC`,
            id,
        ) || [],
    };
}

function listInvestigations(db, opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const status = String(opts.status || '').trim();
    const params = [];
    let where = '1=1';
    if (status) {
        where += ' AND status = ?';
        params.push(status);
    }
    params.push(limit);
    return (db.all(
        `SELECT * FROM incident_investigations
         WHERE ${where}
         ORDER BY incident_date DESC, datetime(updated_at) DESC
         LIMIT ?`,
        ...params,
    ) || []).map(hydrate);
}

function createInvestigation(db, {
    actorName,
    serverTime = new Date().toISOString(),
    storeDateStamp,
    retailName,
}) {
    const id = `II-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const payload = defaultPayload();
    const signoffs = defaultSignoffs();
    const insertOnce = () => {
        const incidentNumber = nextIncidentNumber(db, storeDateStamp);
        db.run(
            `INSERT INTO incident_investigations (
                id, incident_number, status, retail_name, person_types_json, witnesses_json,
                payload_json, signoffs_json, created_at, created_by, updated_at, updated_by
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            id, incidentNumber, 'draft', retailName || null,
            '{}', '[]', serializeJson(payload, {}), serializeJson(signoffs, {}),
            serverTime, actorName, serverTime, actorName,
        );
    };
    // Allocate number + insert atomically; retry once on UNIQUE race.
    try {
        if (typeof db.transaction === 'function') db.transaction(insertOnce)();
        else insertOnce();
    } catch (e) {
        const msg = String(e.message || e);
        if (!/UNIQUE|constraint/i.test(msg)) throw e;
        if (typeof db.transaction === 'function') db.transaction(insertOnce)();
        else insertOnce();
    }
    return getInvestigation(db, id);
}

const HEADER_COLUMNS = new Set([
    'report_date', 'report_time', 'report_ampm', 'retail_name', 'person_involved',
    'incident_date', 'incident_time', 'incident_ampm',
]);

function updateInvestigation(db, id, patch = {}, actorName, serverTime = new Date().toISOString()) {
    const existing = getInvestigation(db, id);
    if (!existing) {
        const err = new Error('Investigation not found.');
        err.status = 404;
        throw err;
    }
    assertDraftMutable(existing);
    if (
        Object.prototype.hasOwnProperty.call(patch, 'signoffs')
        || Object.prototype.hasOwnProperty.call(patch, 'signoffs_json')
    ) {
        const err = new Error('Signoffs must be updated via the signature endpoint.');
        err.status = 400;
        err.code = 'SIGNOFFS_PATCH_FORBIDDEN';
        throw err;
    }
    const updates = ['updated_at = ?', 'updated_by = ?'];
    const params = [serverTime, actorName];
    for (const column of HEADER_COLUMNS) {
        if (Object.prototype.hasOwnProperty.call(patch, column)) {
            updates.push(`${column} = ?`);
            params.push(patch[column] == null ? null : String(patch[column]));
        }
    }
    const jsonFields = [
        ['person_types', 'person_types_json', {}],
        ['witnesses', 'witnesses_json', []],
        ['payload', 'payload_json', defaultPayload()],
    ];
    for (const [property, column, fallback] of jsonFields) {
        const value = Object.prototype.hasOwnProperty.call(patch, property)
            ? patch[property]
            : patch[column];
        if (value !== undefined) {
            const parsed = parsePatchJson(value, property);
            updates.push(`${column} = ?`);
            params.push(serializeJson(parsed, fallback));
        }
    }
    params.push(id);
    db.run(`UPDATE incident_investigations SET ${updates.join(', ')} WHERE id = ?`, ...params);
    return getInvestigation(db, id);
}

function signInvestigationRole(db, id, role, dataUrl, actorName, opts = {}) {
    const investigation = getInvestigation(db, id);
    if (!investigation) {
        const err = new Error('Investigation not found.');
        err.status = 404;
        throw err;
    }
    assertDraftMutable(investigation);
    const meta = SIGN_ROLES[role];
    if (!meta) {
        const err = new Error('Unknown signature role.');
        err.status = 400;
        throw err;
    }
    if (meta.managerOnly && !opts.isManager) {
        const err = new Error('Manager login required for this signature role.');
        err.status = 403;
        err.code = 'SIGNATURE_ROLE_FORBIDDEN';
        throw err;
    }
    const match = PNG_DATA_URL_RE.exec(String(dataUrl || ''));
    if (!match) {
        const err = new Error('Signature must be a PNG data URL.');
        err.status = 400;
        throw err;
    }
    const image = Buffer.from(match[1], 'base64');
    if (!image.length) {
        const err = new Error('Signature image is empty.');
        err.status = 400;
        throw err;
    }
    const filename = `sig-${role}.png`;
    const directory = getAttachmentsDir(id);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, filename), image);

    const serverTime = opts.serverTime || new Date().toISOString();
    const stampDate = String(opts.storeDate || serverTime.slice(0, 10)).trim();
    const actor = String(actorName || '').trim();
    const signoffs = {
        ...defaultSignoffs(),
        ...investigation.signoffs,
        [role]: {
            ...(investigation.signoffs?.[role] || {}),
            name: actor,
            date: stampDate,
            signatureFile: filename,
        },
    };
    db.run(
        `UPDATE incident_investigations
         SET signoffs_json = ?, updated_at = ?, updated_by = ?
         WHERE id = ?`,
        serializeJson(signoffs, defaultSignoffs()),
        serverTime,
        actor,
        id,
    );
    return getInvestigation(db, id);
}

function validateForSubmit(row) {
    const missing = [];
    if (!String(row?.incident_number || '').trim()) missing.push('Incident number');
    if (!String(row?.incident_date || '').trim()) missing.push('Incident date');
    if (!String(row?.person_involved || '').trim()) missing.push('Person involved');
    const payload = row?.payload || parseJson(row?.payload_json, {});
    if (!String(payload?.descriptionLines?.[0] || '').trim()) missing.push('Description (line 1)');
    const signoffs = row?.signoffs || parseJson(row?.signoffs_json, {});
    if (!String(signoffs?.lead?.name || '').trim()) missing.push('Lead investigator name');
    if (!String(signoffs?.lead?.signatureFile || '').trim()) missing.push('Lead investigator signature');
    return missing;
}

function submitInvestigation(db, id, actorName, serverTime = new Date().toISOString()) {
    const row = getInvestigation(db, id);
    if (!row) {
        const err = new Error('Investigation not found.');
        err.status = 404;
        throw err;
    }
    if (String(row.status) !== 'draft') {
        const err = new Error('Investigation is already submitted.');
        err.status = 409;
        err.code = 'INVESTIGATION_ALREADY_SUBMITTED';
        throw err;
    }
    const missing = validateForSubmit(row);
    if (missing.length) {
        const err = new Error(`Complete required fields before submit: ${missing.join(', ')}`);
        err.status = 400;
        err.missing = missing;
        throw err;
    }
    const isFirst = !row.submitted_at;
    if (isFirst) {
        db.run(
            `UPDATE incident_investigations
             SET status = 'submitted', submitted_at = ?, submitted_by = ?, updated_at = ?, updated_by = ?
             WHERE id = ?`,
            serverTime, actorName, serverTime, actorName, id,
        );
    } else {
        db.run(
            `UPDATE incident_investigations
             SET status = 'submitted', last_submitted_at = ?, last_submitted_by = ?, updated_at = ?, updated_by = ?
             WHERE id = ?`,
            serverTime, actorName, serverTime, actorName, id,
        );
    }
    appendAmendEvent(db, id, 'submit', actorName, serverTime);
    return getInvestigation(db, id);
}

function reopenInvestigation(db, id, actorName, opts = {}) {
    if (!opts.isManager) {
        const err = new Error('Manager login required to reopen an investigation.');
        err.status = 403;
        err.code = 'INVESTIGATION_REOPEN_FORBIDDEN';
        throw err;
    }
    const row = getInvestigation(db, id);
    if (!row) {
        const err = new Error('Investigation not found.');
        err.status = 404;
        throw err;
    }
    if (String(row.status) !== 'submitted') {
        const err = new Error('Only submitted investigations can be reopened.');
        err.status = 409;
        err.code = 'INVESTIGATION_LOCKED';
        throw err;
    }
    const serverTime = opts.serverTime || new Date().toISOString();
    db.run(
        `UPDATE incident_investigations
         SET status = 'draft', updated_at = ?, updated_by = ?
         WHERE id = ?`,
        serverTime,
        actorName,
        id,
    );
    appendAmendEvent(db, id, 'reopen', actorName, serverTime);
    return getInvestigation(db, id);
}

module.exports = {
    ensureIncidentInvestigationSchema,
    nextIncidentNumber,
    createInvestigation,
    listInvestigations,
    getInvestigation,
    updateInvestigation,
    signInvestigationRole,
    submitInvestigation,
    reopenInvestigation,
    validateForSubmit,
    defaultPayload,
    getAttachmentsDir,
    getAttachment,
    addAttachment,
    deleteAttachment,
    assertDraftMutable,
    appendAmendEvent,
};
