'use strict';

const { sqliteTzOffsetModifier, DEFAULT_TZ } = require('../store-time.cjs');
const {
    parseJson,
    loadDailyDirectionRow,
    emptyWalkNotes,
    normalizeStatusOverride,
    normalizeMustWin,
    normalizeDailyDirectionFloorMessage,
    nowIso,
} = require('./helpers.cjs');
const { AMENDMENT_SNOOZE_MINUTES, fingerprintTriggers } = require('./amendments.cjs');
const {
    buildDailyDirectionDraft,
    nextShiftUpdateSequence,
    updatePostedSnapshotMessage,
} = require('./views.cjs');

function saveDailyDirectionEdits(db, storeDate, edits, actorName) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (row?.posted_at) {
        throw Object.assign(new Error('Daily Direction already posted for today.'), { status: 409 });
    }

    const walkNotes = edits.walk_notes != null
        ? { ...emptyWalkNotes(), ...edits.walk_notes, flags: { ...emptyWalkNotes().flags, ...(edits.walk_notes?.flags || {}) } }
        : parseJson(row?.walk_notes_json, emptyWalkNotes());

    const mustWins = edits.must_wins != null
        ? (edits.must_wins || []).slice(0, 3).map((w) => ({
            text: String(w.text || '').slice(0, 200),
            owner: String(w.owner || '').slice(0, 40),
            source_risk_id: w.source_risk_id || '',
            task_id: w.task_id || '',
        }))
        : parseJson(row?.must_wins_json, []);

    const statusOverride = edits.status_override != null
        ? normalizeStatusOverride(edits.status_override)
        : normalizeStatusOverride(row?.status_override);

    const hiddenRiskIds = edits.hidden_risk_ids != null
        ? (edits.hidden_risk_ids || []).map(String)
        : parseJson(row?.hidden_risk_ids_json, []);

    const riskOrder = edits.risk_order != null
        ? (edits.risk_order || []).map(String)
        : parseJson(row?.risk_order_json, []);

    const floorMessageRaw = edits.floor_message != null
        ? String(edits.floor_message || '').slice(0, 500)
        : String(row?.floor_message || '');
    const floorMessage = normalizeDailyDirectionFloorMessage(
        floorMessageRaw,
        statusOverride || normalizeStatusOverride(row?.status_override) || 'yellow',
    );

    const floorMessageEdited = edits.floor_message != null
        ? true
        : !!row?.floor_message_edited;

    const managerOnlyNotes = edits.manager_only_notes != null
        ? String(edits.manager_only_notes || '').slice(0, 1000)
        : String(row?.manager_only_notes || '');

    const updatedAt = nowIso();

    if (row) {
        const result = db.run(`
            UPDATE daily_direction SET
                walk_notes_json = ?,
                must_wins_json = ?,
                status_override = ?,
                hidden_risk_ids_json = ?,
                risk_order_json = ?,
                floor_message = ?,
                floor_message_edited = ?,
                manager_only_notes = ?,
                updated_at = ?,
                updated_by = ?
            WHERE store_date = ? AND posted_at IS NULL
        `,
        JSON.stringify(walkNotes),
        JSON.stringify(mustWins),
        statusOverride,
        JSON.stringify(hiddenRiskIds),
        JSON.stringify(riskOrder),
        floorMessage,
        floorMessageEdited ? 1 : 0,
        managerOnlyNotes,
        updatedAt,
        actorName,
        storeDate);
        if (!result?.changes) {
            throw Object.assign(new Error('Daily Direction already posted for today.'), { status: 409 });
        }
    } else {
        db.run(`
            INSERT INTO daily_direction (
                store_date, walk_notes_json, must_wins_json, status_override,
                hidden_risk_ids_json, risk_order_json, floor_message, floor_message_edited,
                manager_only_notes, updated_at, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        storeDate,
        JSON.stringify(walkNotes),
        JSON.stringify(mustWins),
        statusOverride,
        JSON.stringify(hiddenRiskIds),
        JSON.stringify(riskOrder),
        floorMessage,
        floorMessageEdited ? 1 : 0,
        managerOnlyNotes,
        updatedAt,
        actorName);
    }

    return { store_date: storeDate, updated_at: updatedAt };
}

function closeDailyDirectionHuddleTask(db, actorName, storeDate) {
    let tz = DEFAULT_TZ;
    try {
        if (typeof db.getSettings === 'function') {
            tz = db.getSettings()?.Store_Timezone || tz;
        } else {
            const row = db.get('SELECT setting_value FROM settings WHERE setting_name = ?', 'Store_Timezone');
            if (row?.setting_value) tz = row.setting_value;
        }
    } catch (_) { /* use default */ }
    const tzMod = sqliteTzOffsetModifier(tz);
    const row = db.get(`
        SELECT task_id FROM tasks
        WHERE status='Open' AND task_detail LIKE '%Daily direction huddle%'
          AND date(time_submitted, ?) = date(?)
        ORDER BY time_submitted ASC LIMIT 1
    `, tzMod, storeDate);
    if (!row) return false;
    const ts = nowIso();
    db.run(
        `UPDATE tasks SET status='Closed', closed_by=?, time_closed=? WHERE task_id=?`,
        actorName,
        ts,
        row.task_id,
    );
    return true;
}

function approveDailyDirection(db, deps, {
    storeDate,
    actorName,
    floorMessage,
    managerOnlyNotes,
    mustWins,
    statusOverride,
    walkNotes,
}) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (row?.posted_at) {
        throw Object.assign(new Error('Daily Direction already posted for today.'), { status: 409 });
    }

    saveDailyDirectionEdits(db, storeDate, {
        floor_message: floorMessage,
        manager_only_notes: managerOnlyNotes,
        must_wins: mustWins,
        status_override: statusOverride,
        walk_notes: walkNotes,
    }, actorName);

    const draft = buildDailyDirectionDraft(db, deps);
    const chosenStatus = normalizeStatusOverride(statusOverride) || draft.status;
    const message = normalizeDailyDirectionFloorMessage(floorMessage || draft.floor_message || '', chosenStatus);
    if (!message) {
        throw Object.assign(new Error('Floor message is required.'), { status: 400 });
    }

    const snapshot = {
        status: chosenStatus,
        floor_message: message,
        must_wins: draft.must_wins,
        system_risks: draft.system_risks,
        walk_notes: draft.walk_notes,
        manager_only_notes: draft.manager_only_notes,
        day_context: draft.day_context,
    };

    const postedAt = nowIso();
    snapshot.last_updated_at = postedAt;
    snapshot.last_updated_by = actorName;
    snapshot.update_sequence = 0;

    // Daily Direction is rendered from daily_direction_floor on TV.
    // Do not create pinned/ticker comms rows for this workflow.
    const postedMsgId = null;

    const postResult = db.run(`
        UPDATE daily_direction SET
            posted_at = ?,
            posted_by = ?,
            posted_msg_id = ?,
            posted_snapshot_json = ?,
            checkpoint_dismissed_at = NULL,
            amendment_snoozed_until = NULL,
            amendment_dismissed_fingerprint = '',
            shift_update_draft_json = '',
            updated_at = ?,
            updated_by = ?
        WHERE store_date = ? AND posted_at IS NULL
    `,
    postedAt,
    actorName,
    postedMsgId,
    JSON.stringify(snapshot),
    postedAt,
    actorName,
    storeDate);
    if (Number(postResult?.changes) === 0) {
        throw Object.assign(new Error('Daily Direction already posted for today.'), { status: 409 });
    }

    const huddleClosed = closeDailyDirectionHuddleTask(db, actorName, storeDate);

    if (typeof deps.broadcastUpdate === 'function') {
        deps.broadcastUpdate({ table: 'daily_direction', action: 'posted' });
    }

    return {
        success: true,
        store_date: storeDate,
        posted_at: postedAt,
        posted_msg_id: postedMsgId,
        huddle_task_closed: huddleClosed,
        snapshot,
    };
}

function dismissDailyDirectionCheckpoint(db, storeDate, actorName, fingerprint) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) {
        throw Object.assign(new Error('No posted Daily Direction for today.'), { status: 404 });
    }
    const fp = String(fingerprint || row.amendment_dismissed_fingerprint || '').trim();
    db.run(
        `UPDATE daily_direction SET
            amendment_dismissed_fingerprint = ?,
            checkpoint_dismissed_at = ?,
            updated_at = ?,
            updated_by = ?
         WHERE store_date = ?`,
        fp || 'legacy-dismiss',
        nowIso(),
        nowIso(),
        actorName,
        storeDate,
    );
    return { success: true };
}

function ignoreAmendmentSuggestion(db, storeDate, actorName, minutes = AMENDMENT_SNOOZE_MINUTES) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) {
        throw Object.assign(new Error('No posted Daily Direction for today.'), { status: 404 });
    }
    const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    db.run(
        `UPDATE daily_direction SET amendment_snoozed_until = ?, updated_at = ?, updated_by = ? WHERE store_date = ?`,
        until,
        nowIso(),
        actorName,
        storeDate,
    );
    return { success: true, snoozed_until: until };
}

function dismissAmendmentSuggestion(db, storeDate, actorName, fingerprint) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) {
        throw Object.assign(new Error('No posted Daily Direction for today.'), { status: 404 });
    }
    if (!fingerprint) {
        throw Object.assign(new Error('Amendment fingerprint is required.'), { status: 400 });
    }
    db.run(
        `UPDATE daily_direction SET
            amendment_dismissed_fingerprint = ?,
            amendment_snoozed_until = NULL,
            updated_at = ?,
            updated_by = ?
         WHERE store_date = ?`,
        String(fingerprint),
        nowIso(),
        actorName,
        storeDate,
    );
    return { success: true };
}

function saveShiftUpdateDraft(db, storeDate, message, actorName) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) {
        throw Object.assign(new Error('Post Daily Direction before drafting a Shift Update.'), { status: 409 });
    }
    const trimmed = String(message || '').trim().slice(0, 500);
    if (!trimmed) {
        throw Object.assign(new Error('Shift Update message is required.'), { status: 400 });
    }
    db.run(
        `UPDATE daily_direction SET shift_update_draft_json = ?, updated_at = ?, updated_by = ? WHERE store_date = ?`,
        JSON.stringify({ message: trimmed, saved_at: nowIso() }),
        nowIso(),
        actorName,
        storeDate,
    );
    return { success: true };
}

function postShiftUpdate(db, deps, {
    storeDate,
    actorName,
    message,
    fingerprint,
    triggers,
}) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) {
        throw Object.assign(new Error('Post Daily Direction before posting a Shift Update.'), { status: 409 });
    }

    const trimmed = String(message || '').trim().slice(0, 500);
    if (!trimmed) {
        throw Object.assign(new Error('Shift Update message is required.'), { status: 400 });
    }

    const postedAt = nowIso();
    const triggerList = (triggers || []).slice(0, 8);
    let seq = 0;
    let snapshot = null;

    // Shift Updates live under daily_direction_floor on TV.
    // Do not create ticker/feed comms rows for Daily Direction amendments.
    const postedMsgId = null;

    const write = () => {
        seq = nextShiftUpdateSequence(db, storeDate);
        snapshot = {
            message: trimmed,
            triggers: triggerList,
            sequence: seq,
            fingerprint: fingerprint || fingerprintTriggers(triggerList),
        };
        const updatedPostedSnapshot = updatePostedSnapshotMessage(row, trimmed, postedAt, actorName, seq);
        const dismissFp = fingerprint || snapshot.fingerprint;

        db.run(`
            INSERT INTO shift_updates (
                store_date, sequence_num, message, triggers_json,
                posted_at, posted_by, posted_msg_id, snapshot_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        storeDate,
        seq,
        trimmed,
        JSON.stringify(triggerList),
        postedAt,
        actorName,
        postedMsgId,
        JSON.stringify(snapshot),
        postedAt);

        db.run(`
            UPDATE daily_direction SET
                floor_message = ?,
                floor_message_edited = ?,
                posted_snapshot_json = ?,
                shift_update_draft_json = '',
                amendment_dismissed_fingerprint = ?,
                amendment_snoozed_until = NULL,
                updated_at = ?,
                updated_by = ?
            WHERE store_date = ?
        `,
        trimmed,
        1,
        JSON.stringify(updatedPostedSnapshot),
        dismissFp,
        postedAt,
        actorName,
        storeDate);
    };
    if (typeof db.transaction === 'function') db.transaction(write)();
    else write();

    if (typeof deps.broadcastUpdate === 'function') {
        deps.broadcastUpdate({ table: 'shift_updates', action: 'posted' });
    }

    return {
        success: true,
        store_date: storeDate,
        sequence: seq,
        posted_at: postedAt,
        posted_msg_id: postedMsgId,
        snapshot,
    };
}

/**
 * Replace the visible Daily Direction in place (one TV card). Records a shift_update row for reports/huddle history.
 */
function updatePostedDailyDirection(db, deps, {
    storeDate,
    actorName,
    floorMessage,
    statusOverride,
    mustWins,
    walkNotes,
    managerOnlyNotes,
}) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row?.posted_at) {
        throw Object.assign(new Error('No posted Daily Direction for today.'), { status: 404 });
    }

    const snap = parseJson(row.posted_snapshot_json, {});
    const status = normalizeStatusOverride(statusOverride) || snap.status || 'yellow';
    const trimmed = normalizeDailyDirectionFloorMessage(
        String(floorMessage || row.floor_message || snap.floor_message || '').trim().slice(0, 500),
        status,
    );
    if (!trimmed) {
        throw Object.assign(new Error('Floor message is required.'), { status: 400 });
    }

    const nextMustWins = mustWins != null
        ? (mustWins || []).slice(0, 3).map(normalizeMustWin).filter((w) => w.text)
        : (Array.isArray(snap.must_wins) ? snap.must_wins.slice(0, 3).map(normalizeMustWin).filter((w) => w.text) : parseJson(row.must_wins_json, []).slice(0, 3));
    const nextWalkNotes = walkNotes != null
        ? { ...emptyWalkNotes(), ...walkNotes, flags: { ...emptyWalkNotes().flags, ...(walkNotes?.flags || {}) } }
        : (snap.walk_notes || parseJson(row.walk_notes_json, emptyWalkNotes()));
    const nextManagerNotes = managerOnlyNotes != null
        ? String(managerOnlyNotes || '').slice(0, 1000)
        : String(snap.manager_only_notes || row.manager_only_notes || '');

    const postedAt = nowIso();
    let seq = 0;

    const write = () => {
        seq = nextShiftUpdateSequence(db, storeDate);
        const updatedPostedSnapshot = updatePostedSnapshotMessage(row, trimmed, postedAt, actorName, seq, status, {
            must_wins: nextMustWins,
            walk_notes: nextWalkNotes,
            manager_only_notes: nextManagerNotes,
        });

        db.run(`
            INSERT INTO shift_updates (
                store_date, sequence_num, message, triggers_json,
                posted_at, posted_by, posted_msg_id, snapshot_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        storeDate,
        seq,
        trimmed,
        JSON.stringify([]),
        postedAt,
        actorName,
        null,
        JSON.stringify({ message: trimmed, sequence: seq, status, must_wins: nextMustWins }),
        postedAt);

        db.run(`
            UPDATE daily_direction SET
                floor_message = ?,
                floor_message_edited = 1,
                status_override = ?,
                must_wins_json = ?,
                walk_notes_json = ?,
                manager_only_notes = ?,
                posted_snapshot_json = ?,
                shift_update_draft_json = '',
                updated_at = ?,
                updated_by = ?
            WHERE store_date = ?
        `,
        trimmed,
        status,
        JSON.stringify(nextMustWins),
        JSON.stringify(nextWalkNotes),
        nextManagerNotes,
        JSON.stringify(updatedPostedSnapshot),
        postedAt,
        actorName,
        storeDate);
    };
    if (typeof db.transaction === 'function') db.transaction(write)();
    else write();

    if (typeof deps.broadcastUpdate === 'function') {
        deps.broadcastUpdate({ table: 'daily_direction', action: 'posted_update' });
    }

    return {
        success: true,
        store_date: storeDate,
        sequence: seq,
        posted_at: postedAt,
        status,
        floor_message: trimmed,
    };
}

module.exports = {
    saveDailyDirectionEdits,
    closeDailyDirectionHuddleTask,
    approveDailyDirection,
    dismissDailyDirectionCheckpoint,
    ignoreAmendmentSuggestion,
    dismissAmendmentSuggestion,
    saveShiftUpdateDraft,
    postShiftUpdate,
    updatePostedDailyDirection,
};
