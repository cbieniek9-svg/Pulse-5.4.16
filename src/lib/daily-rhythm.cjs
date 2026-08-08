'use strict';

const fs = require('fs');
const { getLogPath } = require('../paths.cjs');
const { suggestEstMinutes } = require('./task-estimates.cjs');
const { expandRhythmTaskForBoard } = require('./rhythm-task-expand.cjs');
const {
    sqliteTzOffsetModifier,
    DEFAULT_TZ,
    rhythmSubmittedAtIso,
} = require('./store-time.cjs');

let rhythmRunning = false;

function rhythmLog(line) {
    const msg = `[RHYTHM] ${line}`;
    try {
        fs.appendFileSync(getLogPath(), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (_) { /* ignore */ }
    console.log(msg);
}

function resolveTzMod(deps, ref = new Date()) {
    const tz = typeof deps.getTimezone === 'function' ? deps.getTimezone() : DEFAULT_TZ;
    return sqliteTzOffsetModifier(tz || DEFAULT_TZ, ref);
}

function countOpenTasks(db) {
    return Number(db.get("SELECT COUNT(*) as c FROM tasks WHERE status='Open'")?.c || 0);
}

function countOpenTasksForStoreDate(db, storeDate, tzMod) {
    if (!storeDate) return 0;
    return Number(db.get(`
        SELECT COUNT(*) as c FROM tasks
        WHERE status='Open'
          AND date(time_submitted, ?) = date(?)
          AND task_id NOT LIKE 'AUTO-PULL-%'
    `, tzMod, storeDate)?.c || 0);
}

function countTasksSubmittedForDate(db, storeDate, tzMod) {
    if (!storeDate) return 0;
    return Number(db.get(`
        SELECT COUNT(*) as c FROM tasks
        WHERE date(time_submitted, ?) = date(?)
          AND task_id NOT LIKE 'AUTO-PULL-%'
    `, tzMod, storeDate)?.c || 0);
}

function openTaskDetailsForStoreDate(db, storeDate, tzMod) {
    if (!storeDate) return new Set();
    const rows = db.all(`
        SELECT task_detail FROM tasks
        WHERE status='Open'
          AND date(time_submitted, ?) = date(?)
    `, tzMod, storeDate) || [];
    return new Set(rows.map((r) => String(r.task_detail || '').trim()).filter(Boolean));
}

/** Open + closed (any status) details submitted on the store date — excludes AUTO-PULL. */
function boardedTaskDetailsForStoreDate(db, storeDate, tzMod) {
    if (!storeDate) return new Set();
    const rows = db.all(`
        SELECT task_detail FROM tasks
        WHERE date(time_submitted, ?) = date(?)
          AND task_id NOT LIKE 'AUTO-PULL-%'
    `, tzMod, storeDate) || [];
    return new Set(rows.map((r) => String(r.task_detail || '').trim()).filter(Boolean));
}

/**
 * Load rhythm_tasks + vendor_schedule for today onto the board.
 * @param {object} db
 * @param {{ getStoreDateStamp: function, getStoreDayName: function, broadcastUpdate?: function }} deps
 * @param {{ force?: boolean, reason?: string }} [opts]
 */
function executeDailyRhythm(db, deps, opts = {}) {
    if (rhythmRunning) {
        rhythmLog(`${String(opts.reason || 'manual')}: skipped — rhythm already running`);
        return { alreadyLoaded: true, busy: true, storeDate: deps.getStoreDateStamp(), openTasks: countOpenTasks(db) };
    }
    rhythmRunning = true;
    try {
        return executeDailyRhythmInner(db, deps, opts);
    } finally {
        rhythmRunning = false;
    }
}

function executeDailyRhythmInner(db, deps, opts = {}) {
    const { getStoreDateStamp, getStoreDayName, broadcastUpdate } = deps;
    let force = opts.force === true;
    const reason = String(opts.reason || 'manual').trim() || 'manual';
    const day = getStoreDayName();
    const stamp = getStoreDateStamp();
    const tzMod = resolveTzMod(deps);
    const last = db.get("SELECT setting_value FROM settings WHERE setting_name='Daily_Rhythm_Last_Loaded'");
    const openTasks = countOpenTasks(db);
    const openToday = countOpenTasksForStoreDate(db, stamp, tzMod);
    const submittedToday = countTasksSubmittedForDate(db, stamp, tzMod);
    // Stamp unset for today but board already has opens (often midnight AUTO-PULL):
    // top-up missing rhythm instead of "repair stamp and skip" (that blocked 06:00 seed).
    const stampUnsetTopUp = !force && openToday > 0 && last?.setting_value !== stamp;
    // Force top-up: stamp says loaded but board is incomplete — add missing details only.
    let forceTopUp = (force && last?.setting_value === stamp && openToday > 0) || stampUnsetTopUp;

    // Today's open tasks often mean "already loaded" — but if templates are still missing,
    // fall through into top-up instead of pretending the schedule is complete.
    if (!force && openToday > 0 && !stampUnsetTopUp) {
        const missingEarly = listMissingRhythmDetails(db, deps);
        if (missingEarly.deferralLookupFailed) {
            rhythmLog(`${reason}: ABORT — deferral lookup failed while board has ${openToday} open today`);
            return {
                error: 'Deferral lookup failed — seed aborted',
                deferral_lookup_failed: true,
                storeDate: stamp,
                openTasks: openToday,
                openToday,
                submittedToday,
            };
        }
        if (!(missingEarly.missing || []).length) {
            rhythmLog(`${reason}: alreadyLoaded for ${stamp} (${openToday} open tasks today)`);
            return { alreadyLoaded: true, storeDate: stamp, openTasks: openToday, openToday, submittedToday, repaired: false };
        }
        rhythmLog(`${reason}: stamp/board present but ${missingEarly.missing.length} rhythm item(s) missing — top-up`);
        force = true;
        forceTopUp = last?.setting_value === stamp && openToday > 0;
    }
    if (stampUnsetTopUp) {
        rhythmLog(`${reason}: stamp unset for ${stamp} but ${openToday} open today — seeding missing rhythm (top-up)`);
    }

    // Stamp set: only treat as done if something was actually submitted today.
    // EOD often leaves Urgent/High carryover with stamp set and openToday=0 — that must not block Routine seed.
    if (!force && !stampUnsetTopUp && last?.setting_value === stamp) {
        if (submittedToday > 0) {
            rhythmLog(`${reason}: alreadyLoaded for ${stamp} (submittedToday=${submittedToday}, openToday=0, open=${openTasks})`);
            return {
                alreadyLoaded: true,
                storeDate: stamp,
                openTasks,
                openToday: 0,
                submittedToday,
                carryoverOpen: openTasks,
            };
        }
        rhythmLog(`${reason}: stamp set for ${stamp} but nothing submitted today (open=${openTasks}) — seeding routine rhythm`);
    }

    if (force && last?.setting_value === stamp) {
        if (forceTopUp && !stampUnsetTopUp) {
            rhythmLog(`${reason}: force top-up for ${stamp} (${openToday} open today) — seeding missing only`);
        } else if (!forceTopUp) {
            rhythmLog(`${reason}: force reload for ${stamp} (openToday=0, openTasks=${openTasks}, submittedToday=${submittedToday})`);
            db.run("UPDATE settings SET setting_value='' WHERE setting_name='Daily_Rhythm_Last_Loaded'");
        }
    }

    const existingBoardedDetails = forceTopUp ? boardedTaskDetailsForStoreDate(db, stamp, tzMod) : null;

    const tasks = db.all("SELECT * FROM rhythm_tasks WHERE day=? OR day='Everyday'", day);
    const deferredResult = (() => {
        try {
            const { getDeferredRhythmIds } = require('./reports-actions.cjs');
            return { ok: true, ids: getDeferredRhythmIds(db, stamp) };
        } catch (e) {
            return { ok: false, error: e };
        }
    })();
    if (!deferredResult.ok) {
        const msg = deferredResult.error?.message || 'Could not read deferred rhythm list';
        rhythmLog(`${reason}: ABORT — deferral lookup failed; refusing to seed without deferrals (${msg})`);
        try {
            const { recordAppError } = require('./app-log.cjs');
            recordAppError('rhythm/deferrals', 'Deferred rhythm lookup failed — seed aborted', deferredResult.error, { reason, storeDate: stamp }, db);
        } catch (_) { /* ignore */ }
        return {
            error: `Deferral lookup failed — seed aborted (${msg})`,
            deferral_lookup_failed: true,
            storeDate: stamp,
            openTasks,
        };
    }
    const deferredIds = new Set(deferredResult.ids || []);
    const activeTasks = tasks.filter((t) => !deferredIds.has(String(t.id)));
    const vendors = db.all('SELECT * FROM vendor_schedule WHERE day=?', day);
    if (!activeTasks.length && !vendors.length) {
        rhythmLog(`${reason}: nothing scheduled for ${day} (${stamp})${deferredIds.size ? ` — ${deferredIds.size} deferred` : ''}`);
        return { success: true, inserted: false, reason: `Nothing scheduled for ${day}`, storeDate: stamp, openTasks };
    }

    const assignCtx = (() => {
        try {
            return require('./rhythm-schedule-assign.cjs').buildRhythmAssignContext(db, stamp);
        } catch (e) {
            rhythmLog(`${reason}: assign context failed — ${e.message}`);
            return { hasSchedule: false, storeDate: stamp };
        }
    })();

    let boardTaskCount = 0;
    let assignedCount = 0;
    let skippedExisting = 0;
    let vendorInsertCount = 0;
    try {
        db.transaction(() => {
            const now = rhythmSubmittedAtIso(deps, stamp);
            const base = Date.now();
            let idx = 0;
            tasks.forEach((t) => {
                if (deferredIds.has(String(t.id))) return;
                const boardTasks = expandRhythmTaskForBoard(db, t, assignCtx);
                boardTasks.forEach((bt) => {
                    const detail = String(bt.task_detail || '').trim();
                    if (existingBoardedDetails && existingBoardedDetails.has(detail)) {
                        skippedExisting += 1;
                        return;
                    }
                    const estMins = suggestEstMinutes(db, { detail: bt.task_detail, fallback: bt.est_mins ?? t.est_mins ?? 15 });
                    const assignee = bt.assigned_to || 'Unassigned';
                    if (assignee !== 'Unassigned') assignedCount += 1;
                    db.run(
                        "INSERT INTO tasks (task_id,task_detail,status,priority,zone,assigned_to,est_mins,time_submitted) VALUES (?,?,'Open',?,?,?,?,?)",
                        `T-${base}-${idx}`, bt.task_detail, bt.priority, bt.zone, assignee, estMins, now,
                    );
                    if (existingBoardedDetails && detail) existingBoardedDetails.add(detail);
                    idx += 1;
                    boardTaskCount += 1;
                });
            });
            vendors.forEach((v, i) => {
                const dup = db.get(
                    "SELECT exp_id FROM expected_orders WHERE status='Pending' AND vendor=? AND expected_day=? LIMIT 1",
                    v.vendor,
                    stamp,
                );
                if (dup) return;
                db.run(
                    "INSERT INTO expected_orders (exp_id,vendor,expected_day,status,logged_by) VALUES (?,?,?,'Pending','AUTO')",
                    `E-${base}-${i}`, v.vendor, stamp,
                );
                vendorInsertCount += 1;
            });
            // Only stamp when something landed — empty defer-all days must stay reloadable.
            if (boardTaskCount > 0 || vendorInsertCount > 0) {
                db.run("INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Daily_Rhythm_Last_Loaded',?)", stamp);
            }
        })();
    } catch (e) {
        rhythmLog(`${reason}: ERROR ${e.message}`);
        console.error('[RHYTHM] Transaction failed:', e);
        try {
            const { recordAppError } = require('./app-log.cjs');
            recordAppError('rhythm/execute', 'Daily rhythm transaction failed', e, { reason, storeDate: stamp, day }, db);
        } catch (_) { /* ignore */ }
        return { error: e.message, storeDate: stamp, openTasks };
    }

    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* non-fatal */ }
    if (typeof broadcastUpdate === 'function') broadcastUpdate();

    const openAfter = countOpenTasks(db);
    rhythmLog(`${reason}: loaded ${boardTaskCount} board tasks (${activeTasks.length} rhythm templates), ${vendors.length} vendors for ${day} (${stamp}); ${openAfter} open tasks; schedule assign ${assignedCount}/${boardTaskCount}${assignCtx.hasSchedule ? '' : ' (no imported schedule)'}${skippedExisting ? `; skipped ${skippedExisting} already open` : ''}`);
    return {
        success: true,
        day,
        storeDate: stamp,
        tasks: boardTaskCount,
        rhythmTemplates: tasks.length,
        vendors: vendors.length,
        openTasks: openAfter,
        openToday: countOpenTasksForStoreDate(db, stamp, tzMod),
        assignedTasks: assignedCount,
        scheduleLoaded: !!assignCtx.hasSchedule,
        forced: force,
        toppedUp: forceTopUp,
        skippedExisting,
        seededWithCarryover: openTasks > 0 && openToday === 0,
    };
}

/** Boot catch-up: reload when stamp is set but nothing from *today* is on the board. */
function ensureDailyRhythmOnBoot(db, deps, executeFn) {
    const stamp = deps.getStoreDateStamp();
    const tzMod = resolveTzMod(deps);
    const last = db.get("SELECT setting_value FROM settings WHERE setting_name='Daily_Rhythm_Last_Loaded'");
    const open = countOpenTasks(db);
    const openToday = countOpenTasksForStoreDate(db, stamp, tzMod);
    const submittedToday = countTasksSubmittedForDate(db, stamp, tzMod);
    if (last?.setting_value === stamp && open === 0 && submittedToday === 0) {
        return executeFn({ force: true, reason: 'boot-recover' });
    }
    // Urgent/High carryover alone must not block morning Routine seed.
    if (last?.setting_value === stamp && openToday === 0 && submittedToday === 0) {
        return executeFn({ force: true, reason: 'boot-recover-carryover' });
    }
    const result = executeFn({ reason: 'boot' });
    return result;
}

function parseStoreTimeMinutes(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function isRhythmLoadedToday(db, storeDate) {
    const row = db.get("SELECT setting_value FROM settings WHERE setting_name='Daily_Rhythm_Last_Loaded'");
    return row?.setting_value === storeDate;
}

function buildMorningRhythmStatus(db, deps = {}) {
    const stamp = deps.getStoreDateStamp ? deps.getStoreDateStamp() : '';
    const storeTime = deps.storeTime
        || (typeof deps.getStoreClockPayload === 'function' ? deps.getStoreClockPayload()?.storeTime : '')
        || '';
    const mins = parseStoreTimeMinutes(storeTime);
    const tzMod = resolveTzMod(deps);
    const last = db.get("SELECT setting_value FROM settings WHERE setting_name='Daily_Rhythm_Last_Loaded'")?.setting_value || '';
    const loaded = last === stamp;
    const openToday = countOpenTasksForStoreDate(db, stamp, tzMod);
    const missingReport = loaded ? listMissingRhythmDetails(db, deps) : { missing: [], deferralLookupFailed: false };
    const missing = missingReport.missing || [];
    const deferralLookupFailed = !!missingReport.deferralLookupFailed;
    const incomplete = missing.length > 0;
    const huddle = db.get(`
        SELECT task_id, status, assigned_to FROM tasks
        WHERE status='Open' AND task_detail LIKE '%Daily direction huddle%'
        ORDER BY time_submitted DESC LIMIT 1
    `) || null;
    const inWindow = mins != null && mins >= 6 * 60 && mins < 11 * 60;
    const pastDeadline = mins != null && mins >= 6 * 60 + 30;
    return {
        store_date: stamp,
        store_time: storeTime,
        stamp: last,
        loaded,
        incomplete,
        missing_rhythm_count: missing.length,
        deferral_lookup_failed: deferralLookupFailed,
        open_today: openToday,
        huddle_open: !!huddle,
        huddle_task_id: huddle?.task_id || null,
        huddle_assignee: huddle?.assigned_to || null,
        in_morning_window: inWindow,
        needs_attention: pastDeadline && (!loaded || incomplete || deferralLookupFailed),
        past_deadline: pastDeadline,
    };
}

function openDetailCoversTemplate(templateDetail, openDetails) {
    const detail = String(templateDetail || '').trim();
    if (!detail) return true;
    if (openDetails.has(detail)) return true;
    // Expanded board forms (FIFO Audit — A1, A2) — same rule as deferRhythmTasks LIKE.
    for (const open of openDetails) {
        const o = String(open || '').trim();
        if (!o) continue;
        if (o.startsWith(`${detail} — `) || o.startsWith(`${detail} – `) || o.startsWith(`${detail} - `)) {
            return true;
        }
    }
    return false;
}

function listMissingRhythmDetails(db, deps = {}) {
    const stamp = deps.getStoreDateStamp ? deps.getStoreDateStamp() : '';
    if (!stamp) return { missing: [], deferralLookupFailed: false };
    const day = typeof deps.getStoreDayName === 'function'
        ? deps.getStoreDayName()
        : (typeof deps.getStoreClockPayload === 'function' ? deps.getStoreClockPayload()?.storeWeekday : '');
    if (!day) return { missing: [], deferralLookupFailed: false };
    const tzMod = resolveTzMod(deps);
    const boardedDetails = boardedTaskDetailsForStoreDate(db, stamp, tzMod);
    let deferredIds = new Set();
    let deferralLookupFailed = false;
    try {
        const { getDeferredRhythmIds } = require('./reports-actions.cjs');
        deferredIds = new Set(getDeferredRhythmIds(db, stamp) || []);
    } catch (_) {
        // Fail closed for completeness: do not invent "missing" while deferrals are unknown.
        deferralLookupFailed = true;
        return { missing: [], deferralLookupFailed: true };
    }

    let skipFifo = false;
    let expandRhythmTaskForBoard = null;
    let buildRhythmAssignContext = null;
    try {
        const sched = require('./rhythm-schedule-assign.cjs');
        skipFifo = !!sched.shouldSkipFifoRhythm(db, stamp);
        expandRhythmTaskForBoard = sched.expandRhythmTaskForBoard;
        buildRhythmAssignContext = sched.buildRhythmAssignContext;
    } catch (_) { /* ignore */ }

    let assignCtx = null;
    if (typeof buildRhythmAssignContext === 'function') {
        try { assignCtx = buildRhythmAssignContext(db, stamp); } catch (_) { assignCtx = null; }
    }

    const templates = db.all("SELECT id, detail FROM rhythm_tasks WHERE day=? OR day='Everyday'", day) || [];
    const missing = [];
    templates.forEach((t) => {
        if (deferredIds.has(String(t.id))) return;
        const detail = String(t.detail || '').trim();
        if (!detail) return;
        // Intentionally not boarded today (e.g. FIFO already logged in Excel).
        if (skipFifo && /^FIFO Audit$/i.test(detail)) return;

        // FIFO expands into per-aisle rows — one boarded aisle must not mark the template done.
        if (/^FIFO Audit$/i.test(detail) && typeof expandRhythmTaskForBoard === 'function' && assignCtx) {
            try {
                const expected = expandRhythmTaskForBoard(db, t, assignCtx) || [];
                const expectedDetails = expected
                    .map((bt) => String(bt.task_detail || '').trim())
                    .filter(Boolean);
                if (expectedDetails.length) {
                    const allPresent = expectedDetails.every((d) => boardedDetails.has(d));
                    if (!allPresent) missing.push(detail);
                    return;
                }
            } catch (_) { /* fall through to prefix coverage */ }
        }

        if (!openDetailCoversTemplate(detail, boardedDetails)) missing.push(detail);
    });
    return { missing, deferralLookupFailed };
}

let lastMorningEnsureAt = 0;
const MORNING_ENSURE_COOLDOWN_MS = 90 * 1000;

/**
 * Heal a missed 06:00 cron: run ensure when store local time is in the morning window
 * and the day is not already loaded (or board needs boot-recover / top-up).
 * Called from sync + scheduler watchdog.
 */
function maybeEnsureMorningRhythm(db, deps, executeFn, opts = {}) {
    const reason = String(opts.reason || 'morning-heal').trim() || 'morning-heal';
    const forceCheck = opts.force === true;
    const now = Date.now();
    if (!forceCheck && now - lastMorningEnsureAt < MORNING_ENSURE_COOLDOWN_MS) {
        return { skipped: true, reason: 'rate_limited' };
    }

    const status = buildMorningRhythmStatus(db, deps);
    if (!status.store_date) return { skipped: true, reason: 'no_store_date', status };
    if (!status.in_morning_window && !forceCheck) {
        return { skipped: true, reason: 'outside_window', status };
    }

    // Healthy when stamp is set, templates are covered (open OR closed same-day),
    // and deferrals are readable. A finished board (open_today=0) must NOT reseed.
    if (status.loaded && !status.incomplete && !status.deferral_lookup_failed) {
        return { skipped: true, reason: 'already_healthy', status };
    }

    lastMorningEnsureAt = now;
    rhythmLog(`${reason}: morning ensure (loaded=${status.loaded}, incomplete=${status.incomplete}, openToday=${status.open_today}, missing=${status.missing_rhythm_count}, time=${status.store_time})`);

    let result;
    if (status.loaded && status.incomplete) {
        // Top-up missing templates (force bypasses stamp-only skip inside execute).
        result = executeFn({ force: true, reason: `${reason}:top-up` });
    } else {
        result = ensureDailyRhythmOnBoot(db, deps, (o) => executeFn({
            ...o,
            reason: o.reason === 'boot' ? reason : `${reason}:${o.reason}`,
        }));
    }
    const after = buildMorningRhythmStatus(db, deps);
    return {
        ...result,
        healed: after.loaded && !after.incomplete,
        status: after,
    };
}

module.exports = {
    executeDailyRhythm,
    ensureDailyRhythmOnBoot,
    maybeEnsureMorningRhythm,
    buildMorningRhythmStatus,
    listMissingRhythmDetails,
    openDetailCoversTemplate,
    boardedTaskDetailsForStoreDate,
    openTaskDetailsForStoreDate,
    isRhythmLoadedToday,
    parseStoreTimeMinutes,
    countOpenTasks,
    countOpenTasksForStoreDate,
    countTasksSubmittedForDate,
    rhythmLog,
};
