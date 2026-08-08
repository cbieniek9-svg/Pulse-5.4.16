'use strict';

const crypto = require('crypto');
const { roundEstMinutes, MIN_SAMPLES } = require('./task-estimates.cjs');
const { WEEKDAY_NAMES } = require('./order-weekly-scorecard.cjs');
const {
    loadActionAcks,
    saveActionAcks,
    loadRhythmDeferrals,
    getDeferredRhythmIds,
    setRhythmDeferrals,
    appendRhythmDeferLog,
} = require('./reports-action-store.cjs');
const { sqliteTzOffsetModifier, DEFAULT_TZ } = require('./store-time.cjs');

function readStoreTimezone(db) {
    try {
        if (typeof db.getSettings === 'function') {
            const tz = db.getSettings()?.Store_Timezone;
            if (tz) return String(tz);
        }
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name = ?', 'Store_Timezone');
        return row?.setting_value || DEFAULT_TZ;
    } catch (_) {
        return DEFAULT_TZ;
    }
}

const NON_DISMISSABLE = new Set(['missing_finish']);
const NON_ADDABLE_TASK_TYPES = new Set(['PULL:*']);
const VALID_RHYTHM_PRIORITIES = ['Routine', 'High', 'Urgent'];

function actionId(kind, title, reportDate, itemKey) {
    const slug = String(itemKey || title || kind || 'action').slice(0, 64);
    return `${kind || 'action'}:${reportDate || 'live'}:${slug}`;
}

function ackAction(db, { action_id, reportDate, actorName }) {
    if (!action_id) throw Object.assign(new Error('action_id required'), { status: 400 });
    const kind = String(action_id).split(':')[0];
    if (NON_DISMISSABLE.has(kind)) {
        throw Object.assign(new Error('This action must be resolved on the floor, not dismissed.'), { status: 400 });
    }
    const acks = loadActionAcks(db);
    if (acks.some((a) => a.action_id === action_id)) {
        return { action_id, already: true };
    }
    acks.push({
        action_id,
        report_date: reportDate || '',
        acked_at: new Date().toISOString(),
        acked_by: actorName || '',
    });
    saveActionAcks(db, acks);
    return { action_id, acked_at: acks[acks.length - 1].acked_at };
}

function filterAckedReportActions(actions, acks, reportDate) {
    const ids = new Set((acks || []).map((a) => a.action_id));
    return (actions || []).filter((a) => {
        const id = a.action_id || actionId(a.kind, a.title, reportDate, a.item_key);
        if (NON_DISMISSABLE.has(a.kind)) return true;
        return !ids.has(id);
    }).map((a) => ({
        ...a,
        action_id: a.action_id || actionId(a.kind, a.title, reportDate, a.item_key),
        dismissible: !NON_DISMISSABLE.has(a.kind),
    }));
}

/**
 * Defer rhythm templates for a store date and close matching open Routine board tasks.
 */
function deferRhythmTasks(db, { storeDate, rhythmIds, actorName, serverTime }) {
    if (!storeDate || !/^\d{4}-\d{2}-\d{2}$/.test(storeDate)) {
        throw Object.assign(new Error('store_date required (YYYY-MM-DD)'), { status: 400 });
    }
    const ids = [...new Set((rhythmIds || []).map(String).filter(Boolean))];
    if (!ids.length) throw Object.assign(new Error('rhythm_ids required'), { status: 400 });

    const templates = db.all(
        `SELECT id, detail FROM rhythm_tasks WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids,
    );
    if (!templates.length) throw Object.assign(new Error('No matching rhythm templates'), { status: 404 });

    const existing = getDeferredRhythmIds(db, storeDate);
    setRhythmDeferrals(db, storeDate, [...existing, ...ids]);

    const now = serverTime || new Date().toISOString();
    const tzMod = sqliteTzOffsetModifier(readStoreTimezone(db));
    let closed = 0;
    templates.forEach((t) => {
        const detail = String(t.detail || '').trim();
        if (!detail) return;
        const openRows = db.all(
            `SELECT task_id FROM tasks
             WHERE status='Open' AND priority='Routine'
               AND date(time_submitted, ?) = date(?)
               AND (
                 (zone='General' AND task_detail=?)
                 OR task_detail LIKE ?
               )`,
            tzMod,
            storeDate,
            detail,
            `${detail} — %`,
        );
        openRows.forEach((row) => {
            db.run(
                `UPDATE tasks SET status='Closed', time_closed=?, closed_by=?
                 WHERE task_id=? AND status='Open'`,
                now,
                actorName || 'Manager',
                row.task_id,
            );
            closed += 1;
        });
    });

    const templateDetails = templates.map((t) => t.detail);
    appendRhythmDeferLog(db, {
        store_date: storeDate,
        deferred_at: now,
        deferred_by: actorName || '',
        rhythm_ids: ids,
        templates: templateDetails,
        closed_board_tasks: closed,
    });

    return {
        store_date: storeDate,
        deferred_ids: getDeferredRhythmIds(db, storeDate),
        templates: templateDetails,
        closed_board_tasks: closed,
    };
}

/**
 * Apply learned est_mins to rhythm_tasks from planning summary rows.
 */
function applyRhythmEstUpdates(db, updates, { actorName } = {}) {
    const applied = [];
    (updates || []).forEach((u) => {
        const detail = String(u.detail || u.task_type || '').trim();
        const est = roundEstMinutes(Number(u.est_mins ?? u.avg_actual_mins));
        if (!detail || !est) return;
        const row = db.get('SELECT id, detail, est_mins FROM rhythm_tasks WHERE detail=? LIMIT 1', detail);
        if (row) {
            db.run('UPDATE rhythm_tasks SET est_mins=? WHERE id=?', est, row.id);
            applied.push({ id: row.id, detail: row.detail, est_mins: est, previous: Number(row.est_mins || 0) });
            return;
        }
        const likePrefix = detail === 'FIFO Audit' ? 'FIFO Audit%' : (detail === 'PULL:*' ? 'PULL:%' : null);
        if (likePrefix) {
            const rows = db.all('SELECT id, detail, est_mins FROM rhythm_tasks WHERE detail LIKE ?', likePrefix);
            rows.forEach((r) => {
                db.run('UPDATE rhythm_tasks SET est_mins=? WHERE id=?', est, r.id);
                applied.push({ id: r.id, detail: r.detail, est_mins: est, previous: Number(r.est_mins || 0) });
            });
        }
    });
    if (applied.length && typeof db.upsertAudit === 'function') {
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            actorName || 'Manager',
            'apply_rhythm_est',
            'rhythm_tasks',
            JSON.stringify({ applied }),
        );
    }
    return { applied };
}

function enrichReportActions(actions, reportDate) {
    return (actions || []).map((a) => ({
        ...a,
        action_id: a.action_id || actionId(a.kind, a.title, reportDate, a.item_key),
        dismissible: !NON_DISMISSABLE.has(a.kind),
    }));
}

function countRhythmTemplates(db, taskType) {
    const detail = String(taskType || '').trim();
    if (!detail) return 0;
    try {
        if (detail === 'FIFO Audit') {
            return db.all('SELECT id FROM rhythm_tasks WHERE detail LIKE ?', 'FIFO Audit%').length;
        }
        if (detail === 'PULL:*') {
            return db.all('SELECT id FROM rhythm_tasks WHERE detail LIKE ?', 'PULL:%').length;
        }
        return db.get('SELECT id FROM rhythm_tasks WHERE detail=? LIMIT 1', detail) ? 1 : 0;
    } catch (_) {
        return 0;
    }
}

function hasRhythmTemplate(db, taskType) {
    return countRhythmTemplates(db, taskType) > 0;
}

function canAddTaskTypeToRhythm({ task_type, sample_count, has_rhythm_template }) {
    if (has_rhythm_template) return false;
    if (NON_ADDABLE_TASK_TYPES.has(task_type)) return false;
    if (Number(sample_count) < MIN_SAMPLES) return false;
    return true;
}

function enrichTaskPlanningSummary(db, summary) {
    if (!summary || !Array.isArray(summary.by_type)) return summary;
    return {
        ...summary,
        by_type: summary.by_type.map((row) => {
            const has_rhythm_template = hasRhythmTemplate(db, row.task_type);
            return {
                ...row,
                has_rhythm_template,
                can_add_to_rhythm: canAddTaskTypeToRhythm({
                    task_type: row.task_type,
                    sample_count: row.sample_count,
                    has_rhythm_template,
                }),
            };
        }),
    };
}

function normalizeRhythmDay(raw) {
    const value = String(raw || '').trim();
    if (!value) throw Object.assign(new Error('day required (Monday–Sunday or Everyday)'), { status: 400 });
    if (value.toLowerCase() === 'everyday') return 'Everyday';
    const match = WEEKDAY_NAMES.find((day) => day.toLowerCase() === value.toLowerCase());
    if (!match) throw Object.assign(new Error('day must be Monday–Sunday or Everyday'), { status: 400 });
    return match;
}

function normalizeRhythmPriority(raw) {
    const value = String(raw || 'Routine').trim();
    const match = VALID_RHYTHM_PRIORITIES.find((p) => p.toLowerCase() === value.toLowerCase());
    if (!match) throw Object.assign(new Error('priority must be Routine, High, or Urgent'), { status: 400 });
    return match;
}

/**
 * Promote a recurring task type from planning accuracy into rhythm_tasks.
 */
function addRhythmFromPlanning(db, {
    detail, day, zone, priority, est_mins, actorName,
} = {}) {
    const taskDetail = String(detail || '').trim();
    if (!taskDetail) throw Object.assign(new Error('detail required'), { status: 400 });
    if (NON_ADDABLE_TASK_TYPES.has(taskDetail)) {
        throw Object.assign(new Error('Grouped pull tasks cannot be added to rhythm from Reports.'), { status: 400 });
    }
    if (hasRhythmTemplate(db, taskDetail)) {
        throw Object.assign(new Error('This task type is already in rhythm.'), { status: 400 });
    }

    const dayNorm = normalizeRhythmDay(day);
    const zoneNorm = String(zone || 'General').trim() || 'General';
    const priorityNorm = normalizeRhythmPriority(priority);
    const est = roundEstMinutes(Number(est_mins));
    if (!est) throw Object.assign(new Error('est_mins required'), { status: 400 });

    const dupe = db.get('SELECT id FROM rhythm_tasks WHERE day=? AND detail=? LIMIT 1', dayNorm, taskDetail);
    if (dupe) {
        throw Object.assign(new Error(`Rhythm already has "${taskDetail}" on ${dayNorm}.`), { status: 409 });
    }

    const id = `R-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    db.run(
        'INSERT INTO rhythm_tasks (id, day, detail, priority, zone, est_mins) VALUES (?, ?, ?, ?, ?, ?)',
        id,
        dayNorm,
        taskDetail,
        priorityNorm,
        zoneNorm,
        est,
    );

    const created = {
        id,
        day: dayNorm,
        detail: taskDetail,
        priority: priorityNorm,
        zone: zoneNorm,
        est_mins: est,
    };

    if (typeof db.upsertAudit === 'function') {
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            actorName || 'Manager',
            'add_rhythm_from_planning',
            'rhythm_tasks',
            JSON.stringify(created),
        );
    }

    return created;
}

module.exports = {
    actionId,
    loadActionAcks,
    ackAction,
    filterAckedReportActions,
    enrichReportActions,
    getDeferredRhythmIds,
    deferRhythmTasks,
    applyRhythmEstUpdates,
    loadRhythmDeferrals,
    countRhythmTemplates,
    hasRhythmTemplate,
    canAddTaskTypeToRhythm,
    enrichTaskPlanningSummary,
    addRhythmFromPlanning,
};
