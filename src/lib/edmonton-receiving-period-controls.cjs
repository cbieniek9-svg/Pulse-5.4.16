'use strict';

const { normalizeStoreDate, resolvePeriodStart, addDays } = require('./edmonton-receiving-report.cjs');

const PERIOD_STATUSES = ['open', 'submitted', 'approved', 'locked'];
const READ_ONLY_STATUSES = new Set(['submitted', 'approved', 'locked']);

function defaultStatus(periodStart) {
    return {
        period_start: periodStart,
        status: 'open',
        submitted_at: null,
        submitted_by: '',
        approved_at: null,
        approved_by: '',
        locked_at: null,
        locked_by: '',
        reopen_note: '',
        updated_at: null,
        updated_by: '',
    };
}

function getPeriodStatus(db, periodStart) {
    const start = normalizeStoreDate(periodStart);
    const row = db.get('SELECT * FROM receiving_report_period_status WHERE period_start=?', start);
    if (!row) return defaultStatus(start);
    return {
        period_start: start,
        status: PERIOD_STATUSES.includes(row.status) ? row.status : 'open',
        submitted_at: row.submitted_at || null,
        submitted_by: row.submitted_by || '',
        submitted_by_staff_id: row.submitted_by_staff_id ?? null,
        approved_at: row.approved_at || null,
        approved_by: row.approved_by || '',
        approved_by_staff_id: row.approved_by_staff_id ?? null,
        locked_at: row.locked_at || null,
        locked_by: row.locked_by || '',
        locked_by_staff_id: row.locked_by_staff_id ?? null,
        reopen_note: row.reopen_note || '',
        reopened_at: row.reopened_at || null,
        reopened_by: row.reopened_by || '',
        reopened_by_staff_id: row.reopened_by_staff_id ?? null,
        reopen_reason: row.reopen_reason || row.reopen_note || '',
        costing_method: row.costing_method || '',
        costing_method_reason: row.costing_method_reason || '',
        costing_method_selected_at: row.costing_method_selected_at || null,
        costing_method_selected_by: row.costing_method_selected_by || '',
        updated_at: row.updated_at || null,
        updated_by: row.updated_by || '',
    };
}

function isPeriodReadOnly(status) {
    return READ_ONLY_STATUSES.has(String(status?.status || status || '').toLowerCase());
}

function assertPeriodEditable(db, anchorDateOrPeriodStart) {
    const start = resolvePeriodStart(db, anchorDateOrPeriodStart);
    const status = getPeriodStatus(db, start);
    if (isPeriodReadOnly(status)) {
        const err = new Error(
            `Period ${start} is ${status.status} and cannot be edited. Reopen the period to make changes.`,
        );
        err.status = 423;
        err.period_status = status;
        throw err;
    }
    return status;
}

function upsertPeriodStatus(db, periodStart, patch, actorName = '') {
    const start = normalizeStoreDate(periodStart);
    const now = new Date().toISOString();
    const existing = db.get('SELECT period_start FROM receiving_report_period_status WHERE period_start=?', start);
    const fields = {
        status: patch.status,
        submitted_at: patch.submitted_at,
        submitted_by: patch.submitted_by,
        submitted_by_staff_id: patch.submitted_by_staff_id,
        approved_at: patch.approved_at,
        approved_by: patch.approved_by,
        approved_by_staff_id: patch.approved_by_staff_id,
        locked_at: patch.locked_at,
        locked_by: patch.locked_by,
        locked_by_staff_id: patch.locked_by_staff_id,
        reopen_note: patch.reopen_note,
        reopened_at: patch.reopened_at,
        reopened_by: patch.reopened_by,
        reopened_by_staff_id: patch.reopened_by_staff_id,
        reopen_reason: patch.reopen_reason,
        updated_at: now,
        updated_by: actorName || '',
    };

    if (existing) {
        const sets = [];
        const vals = [];
        Object.entries(fields).forEach(([key, val]) => {
            if (val !== undefined) {
                sets.push(`${key}=?`);
                vals.push(val);
            }
        });
        if (sets.length) {
            db.run(
                `UPDATE receiving_report_period_status SET ${sets.join(', ')} WHERE period_start=?`,
                ...vals,
                start,
            );
        }
    } else {
        db.run(
            `INSERT INTO receiving_report_period_status (
                period_start, status, submitted_at, submitted_by, submitted_by_staff_id,
                approved_at, approved_by, approved_by_staff_id,
                locked_at, locked_by, locked_by_staff_id, reopen_note,
                reopened_at, reopened_by, reopened_by_staff_id, reopen_reason,
                updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            start,
            fields.status || 'open',
            fields.submitted_at ?? null,
            fields.submitted_by || '',
            fields.submitted_by_staff_id ?? null,
            fields.approved_at ?? null,
            fields.approved_by || '',
            fields.approved_by_staff_id ?? null,
            fields.locked_at ?? null,
            fields.locked_by || '',
            fields.locked_by_staff_id ?? null,
            fields.reopen_note || '',
            fields.reopened_at ?? null,
            fields.reopened_by || '',
            fields.reopened_by_staff_id ?? null,
            fields.reopen_reason || '',
            now,
            actorName || '',
        );
    }
    return getPeriodStatus(db, start);
}

function actorIdentity(actor) {
    const name = String(typeof actor === 'object' ? actor?.name || '' : actor || '').trim();
    const staffId = typeof actor === 'object' ? actor?.staff_id ?? actor?.id ?? null : null;
    return { name, staff_id: staffId };
}

function requireActor(actor) {
    const identity = actorIdentity(actor);
    if (!identity.name && identity.staff_id == null) {
        const err = new Error('A verified manager identity is required.');
        err.status = 403;
        err.code = 'MANAGER_IDENTITY_REQUIRED';
        throw err;
    }
    return identity;
}

function submitPeriod(db, periodStart, actor = '', helpers = {}) {
    const start = normalizeStoreDate(periodStart);
    const identity = requireActor(actor);
    const current = getPeriodStatus(db, start);
    if (current.status === 'locked') {
        const err = new Error('Locked periods cannot be submitted.');
        err.status = 423;
        throw err;
    }
    const costing = require('./edmonton-receiving-costing.cjs').resolvePeriodCostingMethod(db, start);
    if (costing.confirmed !== true) {
        const err = new Error('Confirm the period costing method before submitting.');
        err.status = 400;
        err.code = 'COSTING_METHOD_CONFIRMATION_REQUIRED';
        throw err;
    }
    if (current.status === 'submitted' || current.status === 'approved') {
        return current;
    }
    const assertReady = helpers.assertPeriodReady
        || require('./edmonton-receiving-analytics.cjs').assertPeriodCloseReady;
    assertReady(db, start);
    const now = new Date().toISOString();
    return upsertPeriodStatus(db, start, {
        status: 'submitted',
        submitted_at: now,
        submitted_by: identity.name,
        submitted_by_staff_id: identity.staff_id,
        reopen_note: '',
    }, identity.name);
}

function approvePeriod(db, periodStart, actor = '') {
    const start = normalizeStoreDate(periodStart);
    const identity = requireActor(actor);
    const current = getPeriodStatus(db, start);
    if (current.status === 'locked') {
        const err = new Error('Locked periods cannot be approved.');
        err.status = 423;
        throw err;
    }
    if (current.status === 'open') {
        const err = new Error('Submit the period before approving.');
        err.status = 400;
        throw err;
    }
    if (current.status === 'approved') return current;
    const sameStaff = current.submitted_by_staff_id != null && identity.staff_id != null
        && Number(current.submitted_by_staff_id) === Number(identity.staff_id);
    const sameName = String(current.submitted_by || '').trim().toLowerCase()
        === identity.name.toLowerCase();
    // Separation of duties: reject when either staff id or display name matches submitter.
    if (sameStaff || sameName) {
        const err = new Error('A different manager must approve the submitted period.');
        err.status = 403;
        err.code = 'SEPARATION_OF_DUTIES_REQUIRED';
        throw err;
    }
    const now = new Date().toISOString();
    return upsertPeriodStatus(db, start, {
        status: 'approved',
        approved_at: now,
        approved_by: identity.name,
        approved_by_staff_id: identity.staff_id,
    }, identity.name);
}

function lockPeriodInternal(db, periodStart, actor = '') {
    const start = normalizeStoreDate(periodStart);
    const identity = requireActor(actor);
    const current = getPeriodStatus(db, start);
    if (current.status !== 'approved') {
        const err = new Error('Approve the period before closing and locking.');
        err.status = 400;
        throw err;
    }
    const now = new Date().toISOString();
    return upsertPeriodStatus(db, start, {
        status: 'locked',
        locked_at: now,
        locked_by: identity.name,
        locked_by_staff_id: identity.staff_id,
    }, identity.name);
}

function reopenPeriod(db, periodStart, actor = '', note = '') {
    const start = normalizeStoreDate(periodStart);
    const identity = requireActor(actor);
    const reason = String(note || '').trim();
    if (!reason) {
        const err = new Error('A non-empty reopen reason is required.');
        err.status = 400;
        err.code = 'REOPEN_REASON_REQUIRED';
        throw err;
    }
    const current = getPeriodStatus(db, start);
    if (!isPeriodReadOnly(current)) return current;
    const now = new Date().toISOString();
    return upsertPeriodStatus(db, start, {
        status: 'open',
        submitted_at: null,
        submitted_by: '',
        submitted_by_staff_id: null,
        approved_at: null,
        approved_by: '',
        approved_by_staff_id: null,
        locked_at: null,
        locked_by: '',
        locked_by_staff_id: null,
        reopen_note: reason,
        reopened_at: now,
        reopened_by: identity.name,
        reopened_by_staff_id: identity.staff_id,
        reopen_reason: reason,
    }, identity.name);
}

function closeAndLockPeriod(db, periodStart, actor = '', helpers = {}) {
    const start = normalizeStoreDate(periodStart);
    const identity = requireActor(actor);
    const assertReady = helpers.assertPeriodCloseReady
        || require('./edmonton-receiving-analytics.cjs').assertPeriodCloseReady;
    const archive = helpers.archivePeriodSalesToHistory;
    const snapshot = helpers.snapshotPeriod;
    const audit = helpers.auditOutbox;
    const failAt = helpers.failAt;
    const fail = (stage) => {
        if (failAt === stage) {
            const err = new Error(`Injected close failure at ${stage}.`);
            err.code = 'CLOSE_FAILURE_INJECTED';
            throw err;
        }
    };
    const close = () => {
        const current = getPeriodStatus(db, start);
        if (current.status !== 'approved') {
            const err = new Error('Approve the period before closing and locking.');
            err.status = 400;
            throw err;
        }
        assertReady(db, start);
        fail('readiness');
        if (typeof archive === 'function') archive(db, start, identity.name);
        fail('history');
        if (typeof snapshot === 'function') snapshot(db, start, identity.name);
        fail('snapshot');
        const status = lockPeriodInternal(db, start, identity);
        fail('lock');
        if (typeof audit === 'function') audit(db, {
            event: 'receiving_period_locked', period_start: start, actor: identity.name,
            actor_staff_id: identity.staff_id,
        });
        fail('audit');
        return status;
    };
    return typeof db.transaction === 'function' ? db.transaction(close)() : close();
}

function listWorkbookVendors(db) {
    const names = new Set();
    const add = (value) => {
        const trimmed = String(value || '').trim();
        if (trimmed) names.add(trimmed);
    };
    try {
        db.all('SELECT DISTINCT vendor FROM vendor_schedule WHERE trim(vendor) != "" ORDER BY vendor COLLATE NOCASE')
            .forEach((row) => add(row.vendor));
    } catch (_) {}
    try {
        db.all(
            `SELECT DISTINCT supplier_name FROM receiving_report_lines
              WHERE trim(supplier_name) != ""
              ORDER BY supplier_name COLLATE NOCASE LIMIT 500`,
        ).forEach((row) => add(row.supplier_name));
    } catch (_) {}
    try {
        db.all(
            `SELECT DISTINCT vendor FROM expected_orders
              WHERE trim(vendor) != ""
              ORDER BY vendor COLLATE NOCASE LIMIT 500`,
        ).forEach((row) => add(row.vendor));
    } catch (_) {}
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

module.exports = {
    PERIOD_STATUSES,
    READ_ONLY_STATUSES,
    getPeriodStatus,
    isPeriodReadOnly,
    assertPeriodEditable,
    submitPeriod,
    approvePeriod,
    reopenPeriod,
    closeAndLockPeriod,
    listWorkbookVendors,
    resolvePeriodStart,
    addDays,
};
