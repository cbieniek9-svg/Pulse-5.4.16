'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runMigrations, listMigrationFiles } = require('../src/migrations/runner.cjs');
const {
    createInvestigation,
    updateInvestigation,
    submitInvestigation,
    reopenInvestigation,
    getInvestigation,
    addAttachment,
    deleteAttachment,
    signInvestigationRole,
    getAttachmentsDir,
} = require('../src/lib/incident-investigations.cjs');

/** Minimal non-empty PNG data URL for signature writes. */
const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function withTempDataRoot(t) {
    const previous = process.env.TGP_DATA_DIR;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ii-sig-'));
    process.env.TGP_DATA_DIR = dir;
    t.after(() => {
        if (previous === undefined) delete process.env.TGP_DATA_DIR;
        else process.env.TGP_DATA_DIR = previous;
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

function requireSqlite(t) {
    try {
        const Database = require('better-sqlite3');
        const probe = new Database(':memory:');
        probe.close();
        return Database;
    } catch (error) {
        const message = String(error?.message || error);
        if (message.includes('NODE_MODULE_VERSION') || message.includes('Could not locate the bindings file')) {
            t.skip(`better-sqlite3 is not loadable in this runtime: ${message}`);
            return null;
        }
        throw error;
    }
}

function wrap(sqlite) {
    return {
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run: (sql, ...params) => sqlite.prepare(sql).run(...params),
        exec: (sql) => sqlite.exec(sql),
        transaction: (fn) => sqlite.transaction(fn),
    };
}

/** Pre-seed schema_version through 61 with pre-062 incident investigation tables. */
function createUpgradeFixtureThrough(t, throughVersion = 61) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    db.exec(`
        CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL,
            name TEXT NOT NULL
        );
        CREATE TABLE incident_investigations (
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
            submitted_by TEXT
        );
        CREATE TABLE incident_investigation_attachments (
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
    `);
    for (let version = 1; version <= throughVersion; version += 1) {
        db.run(
            'INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)',
            version,
            '2026-08-04T00:00:00.000Z',
            `fixture_${version}`,
        );
    }
    return { sqlite, db };
}

function columnNames(db, table) {
    return db.all(`PRAGMA table_info(${table})`).map((row) => row.name);
}

function assertAmendEventsSchema(db) {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
    assert.ok(
        tables.includes('incident_investigation_amend_events'),
        'incident_investigation_amend_events must exist',
    );
    const cols = columnNames(db, 'incident_investigation_amend_events');
    for (const expected of [
        'id',
        'investigation_id',
        'action',
        'actor_name',
        'created_at',
        'note',
    ]) {
        assert.ok(cols.includes(expected), `amend events missing column ${expected}`);
    }
    assert.ok(
        db.all("PRAGMA index_list('incident_investigation_amend_events')")
            .some((index) => index.name === 'idx_ii_amend_inv'),
        'idx_ii_amend_inv must exist',
    );
}

test('migration 062 adds last_submitted columns and amend events table', (t) => {
    const fixture = createUpgradeFixtureThrough(t, 61);
    if (!fixture) return;
    const { sqlite, db } = fixture;

    assert.ok(
        listMigrationFiles().includes('062_incident_inventory_integrity.cjs'),
        'migration 062 must exist',
    );

    runMigrations(db);

    const cols = columnNames(db, 'incident_investigations');
    assert.ok(cols.includes('last_submitted_by'));
    assert.ok(cols.includes('last_submitted_at'));
    assertAmendEventsSchema(db);
    assert.equal(
        db.get('SELECT name FROM schema_version WHERE version = 62').name,
        'incident_inventory_integrity',
    );

    sqlite.close();
});

test('migration 062 up body is directly idempotent', (t) => {
    const fixture = createUpgradeFixtureThrough(t, 61);
    if (!fixture) return;
    const { sqlite, db } = fixture;
    assert.ok(
        listMigrationFiles().includes('062_incident_inventory_integrity.cjs'),
        'migration 062 must exist',
    );
    const migration = require('../src/migrations/062_incident_inventory_integrity.cjs');

    migration.up(db);
    migration.up(db);

    const cols = columnNames(db, 'incident_investigations');
    assert.equal(cols.filter((name) => name === 'last_submitted_by').length, 1);
    assert.equal(cols.filter((name) => name === 'last_submitted_at').length, 1);
    assertAmendEventsSchema(db);

    sqlite.close();
});

/** Create a fully valid investigation and submit it (lead signature + required fields). */
function createSubmittedInvestigation(t, opts = {}) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    withTempDataRoot(t);
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    const actor = opts.actor || 'Alice';
    const submittedAt = opts.submittedAt || '2026-08-04T14:00:00.000Z';
    const created = createInvestigation(db, {
        actorName: actor,
        serverTime: '2026-08-04T12:00:00.000Z',
        storeDateStamp: '2026-08-04',
        retailName: 'Test Store',
    });
    updateInvestigation(db, created.id, {
        incident_date: '2026-08-04',
        person_involved: 'unknown',
        payload: {
            ...created.payload,
            descriptionLines: ['Wet floor', ...created.payload.descriptionLines.slice(1)],
        },
    }, actor, '2026-08-04T12:30:00.000Z');
    signInvestigationRole(db, created.id, 'lead', PNG_DATA_URL, actor, {
        isManager: false,
        storeDate: '2026-08-04',
        serverTime: '2026-08-04T12:45:00.000Z',
    });
    if (typeof opts.beforeSubmit === 'function') {
        opts.beforeSubmit(db, created.id);
    }
    const submitted = submitInvestigation(db, created.id, actor, submittedAt);
    return {
        sqlite,
        db,
        id: created.id,
        submitted_by: actor,
        submitted_at: submitted.submitted_at,
        investigation: submitted,
    };
}

function createDraftInvestigation(t, opts = {}) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    withTempDataRoot(t);
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    const actor = opts.actor || 'Clerk A';
    const created = createInvestigation(db, {
        actorName: actor,
        serverTime: '2026-08-04T12:00:00.000Z',
        storeDateStamp: '2026-08-04',
        retailName: 'Test Store',
    });
    return { sqlite, db, id: created.id, actor, investigation: created };
}

test('PATCH after submit throws INVESTIGATION_LOCKED', (t) => {
    const fixture = createSubmittedInvestigation(t);
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    assert.throws(
        () => updateInvestigation(db, id, { person_involved: 'X' }, 'Clerk'),
        (err) => err.code === 'INVESTIGATION_LOCKED' && err.status === 409,
    );

    sqlite.close();
});

test('attach and delete after submit locked', (t) => {
    const fixture = createSubmittedInvestigation(t, {
        beforeSubmit(db, id) {
            addAttachment(db, id, {
                kind: 'photo',
                originalName: 'scene.jpg',
                storedName: 'scene-unique.jpg',
                mime: 'image/jpeg',
                sizeBytes: 42,
                actorName: 'Alice',
                serverTime: '2026-08-04T13:00:00.000Z',
            });
        },
    });
    if (!fixture) return;
    const { sqlite, db, id, investigation } = fixture;
    const attachmentId = investigation.attachments[0].id;

    assert.throws(
        () => addAttachment(db, id, {
            kind: 'photo',
            originalName: 'after.jpg',
            storedName: 'after.jpg',
            mime: 'image/jpeg',
            sizeBytes: 10,
            actorName: 'Clerk',
        }),
        (err) => err.code === 'INVESTIGATION_LOCKED' && err.status === 409,
    );
    assert.throws(
        () => deleteAttachment(db, id, attachmentId),
        (err) => err.code === 'INVESTIGATION_LOCKED' && err.status === 409,
    );

    sqlite.close();
});

test('second submit without reopen rejects and keeps original submitted_*', (t) => {
    const fixture = createSubmittedInvestigation(t, { actor: 'Alice' });
    if (!fixture) return;
    const { sqlite, db, id, submitted_by, submitted_at } = fixture;

    assert.throws(
        () => submitInvestigation(db, id, 'Bob'),
        (err) => err.code === 'INVESTIGATION_ALREADY_SUBMITTED' && err.status === 409,
    );
    const row = getInvestigation(db, id);
    assert.equal(row.submitted_by, 'Alice');
    assert.equal(row.submitted_by, submitted_by);
    assert.equal(row.submitted_at, submitted_at);
    assert.equal(row.last_submitted_by, null);
    assert.equal(row.last_submitted_at, null);

    sqlite.close();
});

test('post-amend re-submit sets last_submitted_* only', (t) => {
    const fixture = createSubmittedInvestigation(t, { actor: 'Alice' });
    if (!fixture) return;
    const { sqlite, db, id, submitted_at } = fixture;

    reopenInvestigation(db, id, 'Mgr', {
        isManager: true,
        serverTime: '2026-08-04T15:00:00.000Z',
    });
    const resubmitted = submitInvestigation(db, id, 'Bob', '2026-08-04T16:00:00.000Z');
    assert.equal(resubmitted.status, 'submitted');
    assert.equal(resubmitted.submitted_by, 'Alice');
    assert.equal(resubmitted.submitted_at, submitted_at);
    assert.equal(resubmitted.last_submitted_by, 'Bob');
    assert.equal(resubmitted.last_submitted_at, '2026-08-04T16:00:00.000Z');
    const submitEvents = db.all(
        `SELECT * FROM incident_investigation_amend_events
         WHERE investigation_id = ? AND action = 'submit'
         ORDER BY id ASC`,
        id,
    );
    assert.equal(submitEvents.length, 2);
    assert.equal(submitEvents[0].actor_name, 'Alice');
    assert.equal(submitEvents[1].actor_name, 'Bob');

    sqlite.close();
});

test('non-manager reopen forbidden', (t) => {
    const fixture = createSubmittedInvestigation(t, { actor: 'Alice' });
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    assert.throws(
        () => reopenInvestigation(db, id, 'Clerk', { isManager: false }),
        (err) => err.code === 'INVESTIGATION_REOPEN_FORBIDDEN' && err.status === 403,
    );
    const row = getInvestigation(db, id);
    assert.equal(row.status, 'submitted');

    sqlite.close();
});

test('manager reopen returns draft, freezes submitted_*, appends amend event', (t) => {
    const fixture = createSubmittedInvestigation(t, { actor: 'Alice' });
    if (!fixture) return;
    const { sqlite, db, id, submitted_by, submitted_at } = fixture;

    const row = reopenInvestigation(db, id, 'Mgr', {
        isManager: true,
        serverTime: '2026-08-04T15:00:00.000Z',
    });
    assert.equal(row.status, 'draft');
    assert.equal(row.submitted_by, submitted_by);
    assert.equal(row.submitted_at, submitted_at);
    assert.equal(row.updated_by, 'Mgr');
    assert.equal(row.updated_at, '2026-08-04T15:00:00.000Z');

    const events = db.all(
        `SELECT * FROM incident_investigation_amend_events WHERE investigation_id = ?`,
        id,
    );
    assert.ok(events.some((e) => e.action === 'reopen' && e.actor_name === 'Mgr'));

    sqlite.close();
});

test('after reopen, mutations work and re-submit sets last_submitted_*', (t) => {
    const fixture = createSubmittedInvestigation(t, { actor: 'Alice' });
    if (!fixture) return;
    const { sqlite, db, id, submitted_at } = fixture;

    reopenInvestigation(db, id, 'Mgr', {
        isManager: true,
        serverTime: '2026-08-04T15:00:00.000Z',
    });
    const patched = updateInvestigation(
        db,
        id,
        { person_involved: 'Amended Person' },
        'Clerk',
        '2026-08-04T15:30:00.000Z',
    );
    assert.equal(patched.status, 'draft');
    assert.equal(patched.person_involved, 'Amended Person');
    assert.equal(patched.submitted_by, 'Alice');
    assert.equal(patched.submitted_at, submitted_at);

    const resubmitted = submitInvestigation(db, id, 'Bob', '2026-08-04T16:00:00.000Z');
    assert.equal(resubmitted.status, 'submitted');
    assert.equal(resubmitted.submitted_by, 'Alice');
    assert.equal(resubmitted.submitted_at, submitted_at);
    assert.equal(resubmitted.last_submitted_by, 'Bob');
    assert.equal(resubmitted.last_submitted_at, '2026-08-04T16:00:00.000Z');

    sqlite.close();
});

test('reopen of draft investigation is rejected', (t) => {
    const fixture = createDraftInvestigation(t);
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    assert.throws(
        () => reopenInvestigation(db, id, 'Mgr', { isManager: true }),
        (err) => err.status === 409,
    );

    sqlite.close();
});

test('routes audit action strings cover update attach sign reopen submit', () => {
    const routesSource = fs.readFileSync(
        path.join(__dirname, '../src/routes/manager/incident-investigations.cjs'),
        'utf8',
    );
    for (const action of [
        'incident_investigation_updated',
        'incident_investigation_attachment_added',
        'incident_investigation_attachment_deleted',
        'incident_investigation_signed',
        'incident_investigation_reopened',
        'incident_investigation_submitted',
    ]) {
        assert.ok(
            routesSource.includes(`'${action}'`) || routesSource.includes(`"${action}"`),
            `routes must audit ${action}`,
        );
    }
    assert.ok(
        routesSource.includes('/reopen'),
        'routes must expose POST reopen',
    );
    assert.ok(
        routesSource.includes('reopenInvestigation'),
        'routes must call reopenInvestigation',
    );
    assert.ok(
        /metadata:\s*\{[^}]*role/.test(routesSource)
            || routesSource.includes("metadata: { role"),
        'sign audit must include role metadata',
    );
    assert.ok(
        routesSource.includes('postAmend')
            || routesSource.includes('post_amend')
            || routesSource.includes('isFirst')
            || routesSource.includes('firstSubmit')
            || routesSource.includes('is_first'),
        'submit audit should distinguish first vs post-amend',
    );
});

test('clerk/non-manager cannot sign senior_management or safety_committee', (t) => {
    const fixture = createDraftInvestigation(t, { actor: 'Clerk A' });
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    for (const role of ['senior_management', 'safety_committee']) {
        assert.throws(
            () => signInvestigationRole(db, id, role, PNG_DATA_URL, 'Clerk A', { isManager: false }),
            (err) => err.code === 'SIGNATURE_ROLE_FORBIDDEN' && err.status === 403,
        );
    }

    sqlite.close();
});

test('manager can sign senior_management and stamps session actor name', (t) => {
    const fixture = createDraftInvestigation(t, { actor: 'Clerk A' });
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    const signed = signInvestigationRole(
        db,
        id,
        'senior_management',
        PNG_DATA_URL,
        'Mgr',
        { isManager: true, storeDate: '2026-08-04', serverTime: '2026-08-04T13:00:00.000Z' },
    );
    assert.equal(signed.signoffs.senior_management.name, 'Mgr');
    assert.equal(signed.signoffs.senior_management.date, '2026-08-04');
    assert.equal(signed.signoffs.senior_management.signatureFile, 'sig-senior_management.png');
    assert.ok(
        fs.existsSync(path.join(getAttachmentsDir(id), 'sig-senior_management.png')),
        'signature PNG must be written under attachments dir',
    );

    const committee = signInvestigationRole(
        db,
        id,
        'safety_committee',
        PNG_DATA_URL,
        'Mgr',
        { isManager: true, storeDate: '2026-08-04' },
    );
    assert.equal(committee.signoffs.safety_committee.name, 'Mgr');
    assert.equal(committee.signoffs.safety_committee.signatureFile, 'sig-safety_committee.png');

    sqlite.close();
});

test('lead can be signed by non-manager', (t) => {
    const fixture = createDraftInvestigation(t, { actor: 'Clerk A' });
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    const signed = signInvestigationRole(
        db,
        id,
        'lead',
        PNG_DATA_URL,
        'Clerk A',
        { isManager: false, storeDate: '2026-08-04', serverTime: '2026-08-04T12:30:00.000Z' },
    );
    assert.equal(signed.signoffs.lead.name, 'Clerk A');
    assert.equal(signed.signoffs.lead.date, '2026-08-04');
    assert.equal(signed.signoffs.lead.signatureFile, 'sig-lead.png');

    sqlite.close();
});

test('signInvestigationRole is draft-locked when submitted', (t) => {
    const fixture = createSubmittedInvestigation(t);
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    assert.throws(
        () => signInvestigationRole(db, id, 'lead', PNG_DATA_URL, 'Clerk', { isManager: false }),
        (err) => err.code === 'INVESTIGATION_LOCKED' && err.status === 409,
    );
    assert.throws(
        () => signInvestigationRole(
            db,
            id,
            'senior_management',
            PNG_DATA_URL,
            'Mgr',
            { isManager: true },
        ),
        (err) => err.code === 'INVESTIGATION_LOCKED' && err.status === 409,
    );

    sqlite.close();
});

test('PATCH rejects signoffs mutations', (t) => {
    const fixture = createDraftInvestigation(t);
    if (!fixture) return;
    const { sqlite, db, id } = fixture;

    assert.throws(
        () => updateInvestigation(db, id, {
            signoffs: {
                lead: { name: 'Forged', date: '2026-01-01', signatureFile: 'forged.png' },
            },
        }, 'Clerk A'),
        (err) => err.status === 400,
    );
    const row = getInvestigation(db, id);
    assert.equal(row.signoffs.lead.name, '');
    assert.equal(row.signoffs.lead.signatureFile, '');

    sqlite.close();
});
