'use strict';

const crypto = require('crypto');
const { computeArchivedOrderMetrics, computeStandardOrderHours } = require('../../lib/shift-metrics.cjs');
const { executeOrderFinish } = require('../../lib/order-finish.cjs');
const { computeOrderClockMetrics } = require('../../lib/order-history-archive.cjs');
const { parseStaffRoster } = require('../../lib/reports-order-analytics.cjs');
const { normalizeDate, extractShiftsFromUpload } = require('../../lib/staff-schedule-import.cjs');
const { analyzeScheduleShifts, buildStoredScheduleHealth } = require('../../lib/staff-schedule-health.cjs');
const { parseMarkdownOcrText } = require('../../lib/markdown-ocr.cjs');
const { extractMarkdownScanText } = require('../../lib/markdown-ocr-router.cjs');
const { parseMarkdownExcelUpload, rowsToKillDateCandidates } = require('../../lib/markdown-excel-import.cjs');
const { detectExcelImportFormat, rowsToFifoAuditCandidates } = require('../../lib/fifo-audit-excel-import.cjs');
const { ensureKillDatePullTasks, broadcastPullTaskEvents } = require('../../lib/kill-date-pull.cjs');
const { isManagerRole, hasStaffPermission } = require('../../lib/staff-permissions.cjs');
const {
    learnFromEntry, lookupItem, searchItems, upsertItem, linkAlias,
    importItemUpload, catalogStats, backfillFromHistory, purgeCatalogJunk,
    normalizeCode,
} = require('../../lib/item-catalog.cjs');
const {
    loadStaffNameAliases,
    upsertStaffNameAlias,
    deactivateStaffNameAlias,
    VALID_ALIAS_TYPES,
    ALIAS_TYPE_LABELS,
} = require('../../lib/staff-name-aliases.cjs');

function registerOpsRoutes(server, ctx) {
    const {
        wrap, fail, requireSession, requireShiftLead, isRhythmScheduleEditEnabled,
        db, auth, broadcastUpdate, getStoreDateStamp,
    } = ctx;
    const { reapplyRhythmAssignments } = require('../../lib/rhythm-schedule-assign.cjs');

    server.post('/api/order-finish', wrap(async (req, res) => {
        const session = requireShiftLead(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const staffCount = parseInt(b.staff_count, 10);
        if (Number.isNaN(staffCount) || staffCount < 1 || staffCount > 99) {
            return fail(res, 400, 'staff_count must be 1-99.');
        }
        let staffRoster = b.staff_roster;
        if (staffRoster != null) {
            if (!Array.isArray(staffRoster)) return fail(res, 400, 'staff_roster must be an array of names.');
            staffRoster = staffRoster.map((n) => String(n).trim()).filter(Boolean).slice(0, 99);
        }
        const hardwareArrived = b.hardware_arrived === true || b.hardware_arrived === '1' || b.hardware_arrived === 1;
        const clockKind = String(b.clock_kind || b.clockKind || 'dry').toLowerCase() === 'frozen' ? 'frozen' : 'dry';
        let exceptionReason = null;
        if (b.exception_reason != null) {
            if (typeof b.exception_reason !== 'string') return fail(res, 400, 'exception_reason must be a string.');
            exceptionReason = b.exception_reason.trim().slice(0, 200);
        }
        let orderEnd = new Date().toISOString();
        if (typeof b.order_end === 'string' && b.order_end.trim()) {
            const parsedOrderEnd = Date.parse(b.order_end);
            if (Number.isNaN(parsedOrderEnd)) return fail(res, 400, 'Invalid order_end.');
            orderEnd = new Date(parsedOrderEnd).toISOString();
        }

        let result;
        try {
            result = executeOrderFinish(db, {
                staffCount,
                hardwareArrived,
                orderEnd,
                serverTime: new Date().toISOString(),
                getStoreDateStamp: getStoreDateStamp || ((date = new Date()) => date.toISOString().slice(0, 10)),
                staffRoster,
                exceptionReason,
                clockKind,
            });
        } catch (e) {
            return fail(res, e.status || 500, e.message || 'Order finish failed.');
        }

        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'order_finish',
            'shift_order_history',
            JSON.stringify({
                store_date: result.storeDate,
                clock_kind: result.clockKind,
                staff_count: result.staffCount,
                hardware_arrived: result.hardwareArrived,
                team_pph: result.teamPph,
                exception_reason: result.exceptionReason,
            }),
        );
        broadcastUpdate();
        res.json({ success: true, ...result });
    }));

    /** Atomic stuck-clock clear — clears Order_Start and Order_End in one transaction (no archive). */
    server.post('/api/order-clock-reset', wrap(async (req, res) => {
        const session = requireShiftLead(req, res);
        if (!session) return;
        const { logInfo, recordAppError } = require('../../lib/app-log.cjs');
        try {
            const before = db.getSettings ? db.getSettings() : {};
            db.transaction(() => {
                db.run("UPDATE settings SET setting_value='' WHERE setting_name IN ('Order_Start','Order_End','Frozen_Order_Start','Frozen_Order_End')");
            })();
            db.upsertAudit(
                crypto.randomUUID(),
                new Date().toISOString(),
                session.name,
                'order_clock_reset',
                'settings',
                JSON.stringify({
                    had_start: !!before.Order_Start,
                    had_end: !!before.Order_End,
                    had_frozen_start: !!before.Frozen_Order_Start,
                    had_frozen_end: !!before.Frozen_Order_End,
                }),
            );
            logInfo('order-clock/reset', 'Stuck order clock cleared', {
                actor: session.name,
                had_start: !!before.Order_Start,
                had_end: !!before.Order_End,
            }, db);
            broadcastUpdate();
            res.json({ success: true });
        } catch (e) {
            recordAppError('order-clock/reset', 'Failed to clear stuck order clock', e, { actor: session.name }, db);
            return fail(res, 500, e.message || 'Could not reset order clock.');
        }
    }));

    /** Atomic multi-setting update — avoids partial saves across paired keys. */
    server.post('/api/settings-batch', wrap(async (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return;
        const { applySettingsBatch } = require('../../lib/settings-batch.cjs');
        const { isManagerRole } = require('../../lib/staff-permissions.cjs');
        const updates = req.body?.settings ?? req.body?.updates;
        try {
            const result = applySettingsBatch(db, updates, {
                isManager: isManagerRole(session.role),
            });
            db.upsertAudit(
                crypto.randomUUID(),
                new Date().toISOString(),
                session.name,
                'settings_batch',
                'settings',
                JSON.stringify({ keys: result.applied }),
            );
            broadcastUpdate();
            res.json({ success: true, ...result });
        } catch (e) {
            return fail(res, e.status || 500, e.message || 'Settings batch failed.');
        }
    }));

    server.post('/api/analytics', wrap(async (req, res) => {
        if (!requireSession(req, res)) return;
        res.json({
            total_completed: db.get("SELECT COUNT(*) as c FROM tasks WHERE status='Closed'").c,
            leaderboard: db.all("SELECT closed_by as user, COUNT(*) as count FROM tasks WHERE status='Closed' GROUP BY closed_by ORDER BY count DESC LIMIT 5"),
            hotspots: db.all("SELECT zone, SUM(hole_count) as count FROM oos WHERE status='Closed' GROUP BY zone ORDER BY count DESC LIMIT 5"),
        });
    }));

    server.post('/api/manager-task-times', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        const taskId = b.task_id;
        if (!taskId || typeof taskId !== 'string') return fail(res, 400, 'task_id is required.');
        const row = db.get('SELECT task_id FROM tasks WHERE task_id = ?', taskId);
        if (!row) return fail(res, 404, 'Task not found.');

        const parseTimeCol = (key) => {
            if (!(key in b)) return null;
            const v = b[key];
            if (v === null || v === undefined || v === '') return { key, val: null };
            if (typeof v !== 'string') return { err: `${key} must be an ISO string or empty.` };
            const t = Date.parse(v);
            if (Number.isNaN(t)) return { err: `Invalid datetime for ${key}.` };
            return { key, val: new Date(t).toISOString() };
        };

        const updates = {};
        for (const col of ['time_submitted', 'start_time', 'time_closed']) {
            const r = parseTimeCol(col);
            if (r?.err) return fail(res, 400, r.err);
            if (r && 'val' in r) updates[r.key] = r.val;
        }
        if ('est_mins' in b) {
            const n = parseInt(b.est_mins, 10);
            if (Number.isNaN(n) || n < 0 || n > 9999) return fail(res, 400, 'est_mins must be an integer from 0 to 9999.');
            updates.est_mins = n;
        }
        if (!Object.keys(updates).length) return fail(res, 400, 'No valid fields to update.');

        const cols = Object.keys(updates);
        const sets = cols.map((k) => `${k} = ?`).join(', ');
        const serverTime = new Date().toISOString();
        db.run(`UPDATE tasks SET ${sets} WHERE task_id = ?`, ...cols.map((k) => updates[k]), taskId);
        db.upsertAudit(crypto.randomUUID(), serverTime, session.name, 'manager_task_times', 'tasks', JSON.stringify({ task_id: taskId, ...updates }));
        broadcastUpdate({ table: 'tasks', action: 'update', id_col: 'task_id', id_val: taskId, data: updates });
        res.json({ success: true });
    }));

    server.post('/api/order-history-correction', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        const storeDate = String(b.store_date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(storeDate)) return fail(res, 400, 'Valid store_date is required.');
        const totalPieces = parseInt(b.total_pieces, 10);
        const staffCount = parseInt(b.staff_count, 10);
        if (Number.isNaN(totalPieces) || totalPieces < 0 || totalPieces > 99999) return fail(res, 400, 'total_pieces must be 0-99999.');
        if (Number.isNaN(staffCount) || staffCount < 1 || staffCount > 99) return fail(res, 400, 'staff_count must be 1-99.');
        const row = db.get('SELECT * FROM shift_order_history WHERE store_date = ?', storeDate);
        if (!row) return fail(res, 404, 'Order history row not found.');
        const parseOptionalIso = (key, fallback) => {
            if (!(key in b) || b[key] === null || b[key] === undefined || b[key] === '') return fallback || '';
            if (typeof b[key] !== 'string') {
                const err = new Error(`${key} must be a date/time string.`);
                err.status = 400;
                throw err;
            }
            const t = Date.parse(b[key]);
            if (Number.isNaN(t)) {
                const err = new Error(`Invalid ${key}.`);
                err.status = 400;
                throw err;
            }
            return new Date(t).toISOString();
        };
        let orderStart, orderEnd;
        try {
            orderStart = parseOptionalIso('order_start', row.order_start);
            orderEnd = parseOptionalIso('order_end', row.order_end);
        } catch (e) {
            return fail(res, e.status || 400, e.message);
        }
        const settings = db.getSettings ? db.getSettings() : {};
        const { rawClockMinutes, actualOrderMinutes, spansCalendarDay } = computeOrderClockMetrics(
            orderStart, orderEnd, settings,
        );
        const cph = parseFloat(settings.Cases_Per_Hour) || 55;
        const hardwareCph = parseFloat(settings.Hardware_CPH) || 50;
        const groceryPieces = Number(row.grocery_pieces || 0);
        const frozenPieces = Number(row.frozen_pieces || 0);
        const hardwarePieces = Number(row.hardware_pieces || 0);
        const hardwareArrived = hardwarePieces > 0;
        const standardHours = computeStandardOrderHours(
            groceryPieces, frozenPieces, hardwarePieces, cph, hardwareCph, hardwareArrived,
        );
        let resolvedStaffCount = staffCount;
        let rosterJson = row.staff_roster || '';
        if ('staff_roster' in b) {
            let roster = b.staff_roster;
            if (roster == null || roster === '') {
                roster = [];
            } else if (typeof roster === 'string') {
                roster = parseStaffRoster(roster);
            } else if (!Array.isArray(roster)) {
                return fail(res, 400, 'staff_roster must be an array of names or a comma-separated string.');
            } else {
                roster = roster.map((n) => String(n).trim()).filter(Boolean).slice(0, 99);
            }
            rosterJson = roster.length ? JSON.stringify(roster) : '';
            if (roster.length) resolvedStaffCount = roster.length;
        }
        const metrics = computeArchivedOrderMetrics(totalPieces, actualOrderMinutes, resolvedStaffCount);
        const now = new Date().toISOString();
        let exceptionReason = null;
        if ('exception_reason' in b) {
            if (b.exception_reason != null && typeof b.exception_reason !== 'string') {
                return fail(res, 400, 'exception_reason must be a string.');
            }
            exceptionReason = b.exception_reason == null ? '' : b.exception_reason.trim().slice(0, 200);
        }
        const write = () => {
            if (exceptionReason != null) {
                db.run(
                    `UPDATE shift_order_history
                     SET order_start=?, order_end=?, total_pieces=?, staff_count=?, standard_hours=?, actual_order_minutes=?, actual_pieces_per_hour=?,
                         break_deduction_hours_per_person=?, adjusted_labor_hours=?, adjusted_per_person_pph=?,
                         raw_clock_minutes=?, spans_calendar_day=?, staff_roster=?, exception_reason=?
                     WHERE store_date=?`,
                    orderStart, orderEnd, totalPieces, resolvedStaffCount, Number(standardHours.toFixed(2)), actualOrderMinutes, metrics.team_pph,
                    metrics.break_deduction_hours_per_person, metrics.adjusted_labor_hours, metrics.adjusted_per_person_pph,
                    rawClockMinutes, spansCalendarDay, rosterJson, exceptionReason,
                    storeDate,
                );
            } else {
                db.run(
                    `UPDATE shift_order_history
                     SET order_start=?, order_end=?, total_pieces=?, staff_count=?, standard_hours=?, actual_order_minutes=?, actual_pieces_per_hour=?,
                         break_deduction_hours_per_person=?, adjusted_labor_hours=?, adjusted_per_person_pph=?,
                         raw_clock_minutes=?, spans_calendar_day=?, staff_roster=?
                     WHERE store_date=?`,
                    orderStart, orderEnd, totalPieces, resolvedStaffCount, Number(standardHours.toFixed(2)), actualOrderMinutes, metrics.team_pph,
                    metrics.break_deduction_hours_per_person, metrics.adjusted_labor_hours, metrics.adjusted_per_person_pph,
                    rawClockMinutes, spansCalendarDay, rosterJson,
                    storeDate,
                );
            }
            db.upsertAudit(crypto.randomUUID(), now, session.name, 'correct_order_history', 'shift_order_history', JSON.stringify({
                store_date: storeDate,
                order_start: orderStart,
                order_end: orderEnd,
                total_pieces: totalPieces,
                staff_count: resolvedStaffCount,
                staff_roster: parseStaffRoster(rosterJson),
                actual_order_minutes: actualOrderMinutes,
                raw_clock_minutes: rawClockMinutes,
                spans_calendar_day: spansCalendarDay,
                // Persist what landed on the row: request value when provided, else existing DB value.
                exception_reason: exceptionReason != null ? exceptionReason : (row.exception_reason ?? null),
            }));
        };
        if (typeof db.transaction === 'function') db.transaction(write)();
        else write();
        broadcastUpdate();
        res.json({
            success: true,
            actual_order_minutes: actualOrderMinutes,
            raw_clock_minutes: rawClockMinutes,
            spans_calendar_day: spansCalendarDay,
            actual_pieces_per_hour: metrics.team_pph,
            adjusted_per_person_pph: metrics.adjusted_per_person_pph,
            standard_hours: Number(standardHours.toFixed(2)),
            staff_count: resolvedStaffCount,
            staff_roster: parseStaffRoster(rosterJson),
        });
    }));

    server.post('/api/order-history-attach-live-clock', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const storeDate = String(req.body?.store_date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(storeDate)) return fail(res, 400, 'Valid store_date is required.');
        const row = db.get('SELECT * FROM shift_order_history WHERE store_date = ?', storeDate);
        if (!row) return fail(res, 404, 'Order history row not found.');

        const settings = db.getSettings ? db.getSettings() : {};
        const orderStart = settings.Order_Start || '';
        const orderEnd = settings.Order_End || '';
        if (!orderStart || !orderEnd) return fail(res, 400, 'Live order clock does not have both start and end times.');
        if (Date.parse(orderEnd) < Date.parse(orderStart)) return fail(res, 400, 'Live order end is before start.');

        const { rawClockMinutes, actualOrderMinutes, spansCalendarDay } = computeOrderClockMetrics(
            orderStart, orderEnd, settings,
        );
        const totalPieces = Number(row.total_pieces || 0);
        const staffCount = Math.max(1, Number(row.staff_count || 1));
        const cph = parseFloat(settings.Cases_Per_Hour) || 55;
        const standardHours = cph > 0 ? totalPieces / cph : 0;
        const metrics = computeArchivedOrderMetrics(totalPieces, actualOrderMinutes, staffCount);
        const now = new Date().toISOString();

        db.transaction(() => {
            db.run(
                `UPDATE shift_order_history
                 SET order_start=?, order_end=?, standard_hours=?, actual_order_minutes=?, actual_pieces_per_hour=?,
                     break_deduction_hours_per_person=?, adjusted_labor_hours=?, adjusted_per_person_pph=?,
                     raw_clock_minutes=?, spans_calendar_day=?
                 WHERE store_date=?`,
                orderStart, orderEnd, Number(standardHours.toFixed(2)), actualOrderMinutes, metrics.team_pph,
                metrics.break_deduction_hours_per_person, metrics.adjusted_labor_hours, metrics.adjusted_per_person_pph,
                rawClockMinutes, spansCalendarDay,
                storeDate
            );
            db.run("UPDATE settings SET setting_value='' WHERE setting_name IN ('Order_Start','Order_End')");
            db.upsertAudit(crypto.randomUUID(), now, session.name, 'attach_live_clock_to_order_history', 'shift_order_history', JSON.stringify({ store_date: storeDate, order_start: orderStart, order_end: orderEnd }));
        })();
        broadcastUpdate();
        res.json({
            success: true,
            actual_order_minutes: actualOrderMinutes,
            raw_clock_minutes: rawClockMinutes,
            spans_calendar_day: spansCalendarDay,
            actual_pieces_per_hour: metrics.team_pph,
            adjusted_per_person_pph: metrics.adjusted_per_person_pph,
        });
    }));

    server.post('/api/order-history-delete', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const storeDate = String(req.body?.store_date || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(storeDate)) return fail(res, 400, 'Valid store_date is required.');
        const row = db.get('SELECT * FROM shift_order_history WHERE store_date = ?', storeDate);
        if (!row) return fail(res, 404, 'Order history row not found.');
        const now = new Date().toISOString();
        db.run('DELETE FROM shift_order_history WHERE store_date = ?', storeDate);
        db.upsertAudit(crypto.randomUUID(), now, session.name, 'delete_order_history', 'shift_order_history', JSON.stringify({ store_date: storeDate, order_start: row.order_start, order_end: row.order_end }));
        broadcastUpdate();
        res.json({ success: true, deleted: storeDate });
    }));

    server.get('/api/staff-shifts/health', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const storeDate = getStoreDateStamp();
        const health = buildStoredScheduleHealth(db, storeDate);
        res.json({ success: true, ...health });
    }));

    server.post('/api/staff-shifts/preview', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const { filename, contentBase64 } = req.body ?? {};
        const extracted = await extractShiftsFromUpload(db, filename, contentBase64, session.name);
        if (extracted.errors?.length && !extracted.shifts?.length) {
            return fail(res, 400, extracted.errors.join(' '));
        }
        const today = getStoreDateStamp();
        const analysis = analyzeScheduleShifts(db, extracted.shifts, {
            focusDate: today,
            parseErrors: extracted.errors || [],
        });
        res.json({
            success: true,
            filename: extracted.filename,
            replace_from: extracted.date_from,
            replace_to: extracted.date_to,
            skipped: extracted.skipped || [],
            ...analysis,
        });
    }));

    server.post('/api/staff-shifts/import', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const { filename, contentBase64, replaceFromDate, replaceToDate } = req.body ?? {};
        const extracted = await extractShiftsFromUpload(db, filename, contentBase64, session.name);
        if (extracted.errors?.length && !extracted.shifts?.length) {
            return fail(res, 400, extracted.errors.join(' '));
        }
        const { shifts, errors } = extracted;
        if (!shifts.length) return fail(res, 400, errors.join(' ') || 'No valid shifts found.');

        const dates = shifts.map((s) => s.shift_date).sort();
        const from = normalizeDate(replaceFromDate) || dates[0];
        const to = normalizeDate(replaceToDate) || dates[dates.length - 1];
        const importedAt = new Date().toISOString();

        db.transaction(() => {
            db.run('DELETE FROM staff_shifts WHERE shift_date BETWEEN ? AND ?', from, to);
            shifts.forEach((s) => db.run(
                `INSERT INTO staff_shifts (
                    id, staff_name, shift_date, start_time, end_time, role,
                    department, notes, source_file, imported_at, imported_by
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
                s.id, s.staff_name, s.shift_date, s.start_time, s.end_time,
                s.role, s.department, s.notes, s.source_file, s.imported_at, s.imported_by,
            ));
            // Names flagged file maintenance / departed are dropped at parse time; clear any
            // rows a previous import left behind so the roster and labor hours agree.
            (extracted.skipped || []).forEach((s) => {
                db.run('DELETE FROM staff_shifts WHERE staff_name = ?', s.staff_name);
            });
            db.upsertAudit(
                crypto.randomUUID(), importedAt, session.name, 'import_staff_shifts', 'staff_shifts',
                JSON.stringify({
                    file: extracted.safeName,
                    rows: shifts.length,
                    errors: errors.length,
                    from,
                    to,
                    skipped: extracted.skipped || [],
                }),
            );
        })();
        const today = getStoreDateStamp();
        const reassign = (from <= today && today <= to) ? reapplyRhythmAssignments(db, today) : null;
        const health = buildStoredScheduleHealth(db, today);
        broadcastUpdate();
        res.json({
            success: true,
            imported: shifts.length,
            errors,
            skipped: extracted.skipped || [],
            filename: extracted.safeName,
            replace_from: from,
            replace_to: to,
            reassign,
            health,
        });
    }));

    server.get('/api/staff-name-aliases', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const aliases = loadStaffNameAliases(db);
        res.json({
            success: true,
            aliases,
            alias_types: VALID_ALIAS_TYPES.map((id) => ({ id, label: ALIAS_TYPE_LABELS[id] || id })),
        });
    }));

    server.post('/api/staff-name-aliases/save', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const body = req.body ?? {};
        let saved;
        try {
            saved = upsertStaffNameAlias(db, body, session.name);
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Invalid alias.');
        }
        const now = new Date().toISOString();
        db.upsertAudit(
            crypto.randomUUID(), now, session.name, 'upsert_staff_name_alias', 'staff_name_aliases',
            JSON.stringify(saved),
        );
        broadcastUpdate();
        res.json({ success: true, alias: saved, aliases: loadStaffNameAliases(db) });
    }));

    server.post('/api/staff-name-aliases/remove', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const sourceName = String(req.body?.source_name || '').trim();
        let removed;
        try {
            removed = deactivateStaffNameAlias(db, sourceName, session.name);
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Remove failed.');
        }
        const now = new Date().toISOString();
        db.upsertAudit(
            crypto.randomUUID(), now, session.name, 'deactivate_staff_name_alias', 'staff_name_aliases',
            JSON.stringify(removed),
        );
        broadcastUpdate();
        res.json({ success: true, ...removed, aliases: loadStaffNameAliases(db) });
    }));

    server.post('/api/staff-shifts/update', wrap(async (req, res) => {
        const session = requireShiftLead(req, res);
        if (!session) return;
        if (!isManagerRole(session.role) && !isRhythmScheduleEditEnabled()) {
            return fail(res, 403, 'Schedule assignment edit is disabled in Settings → Staff.');
        }
        const id = String(req.body?.id || '').trim();
        const department = String(req.body?.department ?? '').trim();
        const role = String(req.body?.role ?? '').trim();
        // An explicitly sent empty role means "clear it" — the imported job title
        // ("...Clerk/Cashier") otherwise keeps out-voting the manager's department pick.
        const roleProvided = req.body?.role !== undefined;
        if (!id) return fail(res, 400, 'Shift id is required.');
        if (!department && !role) return fail(res, 400, 'department or role is required.');
        const row = db.get('SELECT * FROM staff_shifts WHERE id = ?', id);
        if (!row) return fail(res, 404, 'Shift not found.');
        const today = getStoreDateStamp();
        if (row.shift_date !== today) return fail(res, 400, 'Only today\'s schedule rows can be edited here.');
        const nextDept = department || row.department || '';
        const nextRole = roleProvided ? role : (row.role || '');
        const now = new Date().toISOString();
        db.run('UPDATE staff_shifts SET department = ?, role = ? WHERE id = ?', nextDept, nextRole, id);
        db.upsertAudit(
            crypto.randomUUID(), now, session.name, 'update_staff_shift', 'staff_shifts',
            JSON.stringify({ id, staff_name: row.staff_name, department: nextDept, role: nextRole }),
        );
        broadcastUpdate();
        res.json({ success: true, id, department: nextDept, role: nextRole });
    }));

    server.post('/api/rhythm/reapply-assignments', wrap(async (req, res) => {
        const session = requireShiftLead(req, res);
        if (!session) return;
        if (!isManagerRole(session.role) && !isRhythmScheduleEditEnabled()) {
            return fail(res, 403, 'Schedule assignment edit is disabled in Settings → Staff.');
        }
        const storeDate = getStoreDateStamp();
        const result = reapplyRhythmAssignments(db, storeDate);
        const now = new Date().toISOString();
        db.upsertAudit(
            crypto.randomUUID(), now, session.name, 'reapply_rhythm_assignments', 'tasks',
            JSON.stringify(result),
        );
        broadcastUpdate();
        res.json({ success: true, ...result });
    }));

    server.post('/api/markdown/import-scan', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        if (!isManagerRole(session.role) && !hasStaffPermission(db, session, 'markdown')) {
            return fail(res, 403, 'Markdown permission required.');
        }
        const { filename, contentBase64 } = req.body ?? {};
        const text = await extractMarkdownScanText(filename, contentBase64);
        const parsed = parseMarkdownOcrText(text);
        db.upsertAudit(crypto.randomUUID(), new Date().toISOString(), session.name, 'ocr_markdown_scan', 'kill_dates', JSON.stringify({ filename, candidates: parsed.candidates.length, errors: parsed.errors.length }));
        res.json({ success: true, ...parsed, ocrText: text, stats: parsed.stats || {} });
    }));

    server.post('/api/markdown/import-excel', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        if (!isManagerRole(session.role) && !hasStaffPermission(db, session, 'markdown')) {
            return fail(res, 403, 'Markdown permission required.');
        }
        const { filename, contentBase64, dry_run: dryRun } = req.body ?? {};
        const parsed = await parseMarkdownExcelUpload(filename, contentBase64);
        if (parsed.errors.length) return fail(res, 400, parsed.errors.join(' '));

        const refYear = new Date().getFullYear();
        const format = detectExcelImportFormat(parsed.rows);
        const parsedRows = format === 'fifo'
            ? rowsToFifoAuditCandidates(parsed.rows, refYear)
            : rowsToKillDateCandidates(parsed.rows, refYear);
        const { candidates, errors } = parsedRows;
        if (!candidates.length) return fail(res, 400, errors.join(' ') || 'No valid rows to import.');

        if (dryRun === true || dryRun === 'true') {
            return res.json({
                success: true,
                dry_run: true,
                filename: parsed.safeName,
                format,
                candidates,
                errors,
                import_count: candidates.length,
            });
        }

        const now = new Date().toISOString();
        let imported = 0;
        const pullEvents = [];
        db.transaction(() => {
            for (const row of candidates) {
                const id = `K-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
                let quantity = parseInt(String(row.quantity ?? ''), 10);
                if (!Number.isFinite(quantity) || quantity < 1) quantity = 1;
                db.run(
                    `INSERT INTO kill_dates (id, item, item_code, kill_date, zone, status, logged_by, quantity)
                     VALUES (?,?,?,?,?,?,?,?)`,
                    id, row.item, row.item_code || '', row.kill_date, row.zone || 'General', 'Active', session.name, quantity,
                );
                learnFromEntry(db, {
                    code: row.item_code,
                    description: row.item,
                    zone: row.zone,
                    actor: session.name,
                    now,
                });
                imported++;
            }
            const today = typeof ctx.getStoreDateStamp === 'function' ? ctx.getStoreDateStamp() : now.slice(0, 10);
            pullEvents.push(...ensureKillDatePullTasks(db, today));
            db.upsertAudit(crypto.randomUUID(), now, session.name, format === 'fifo' ? 'import_fifo_excel' : 'import_markdown_excel', 'kill_dates', JSON.stringify({ file: parsed.safeName, imported, errors: errors.length, format }));
        })();
        broadcastPullTaskEvents(db, pullEvents, broadcastUpdate);
        broadcastUpdate();
        res.json({ success: true, imported, errors, filename: parsed.safeName, format, candidates });
    }));

    const requireShrinkAccess = (req, res) => {
        const session = requireSession(req, res);
        if (!session) return null;
        if (!isManagerRole(session.role) && !hasStaffPermission(db, session, 'markdown')) {
            fail(res, 403, 'Markdown permission required.');
            return null;
        }
        return session;
    };

    const shrinkStoreDate = (raw) => String(raw || '').trim()
        || (typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : new Date().toISOString().slice(0, 10));

    server.get('/api/markdown/shrink', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const {
            enrichShrinkRows, normalizeShrinkStatus, SHRINK_REASONS,
            listShrinkSessions, listRecentShrinkSessions, getShrinkSession,
        } = require('../../lib/floor-shrink.cjs');
        const sessionId = String(req.query?.session_id || '').trim();
        const activeSession = sessionId ? getShrinkSession(db, sessionId) : null;
        // Viewing a past import must use that walk's store_date, not "today".
        const storeDate = activeSession?.store_date
            || shrinkStoreDate(req.query?.store_date);
        const statusFilter = String(req.query?.status || 'active').trim().toLowerCase();
        const sessions = listShrinkSessions(db, storeDate);
        const recentSessions = listRecentShrinkSessions(db, { limit: 40 });

        let all;
        if (activeSession) {
            all = db.all(
                `SELECT * FROM floor_shrink_sku WHERE session_id = ? ORDER BY time_logged DESC LIMIT 500`,
                activeSession.id,
            );
        } else {
            all = db.all(
                `SELECT * FROM floor_shrink_sku WHERE store_date = ? ORDER BY time_logged DESC LIMIT 500`,
                storeDate,
            );
        }
        let rows = all;
        if (statusFilter === 'open') {
            rows = all.filter((r) => normalizeShrinkStatus(r.status) === 'Open');
        } else if (statusFilter === 'closed') {
            rows = all.filter((r) => normalizeShrinkStatus(r.status) === 'Closed');
        } else if (statusFilter === 'voided') {
            rows = all.filter((r) => normalizeShrinkStatus(r.status) === 'Voided');
        } else if (statusFilter !== 'all') {
            rows = all.filter((r) => normalizeShrinkStatus(r.status) !== 'Voided');
        }
        const report = enrichShrinkRows(db, rows);
        const openCount = all.filter((r) => normalizeShrinkStatus(r.status) === 'Open').length;
        const closedCount = all.filter((r) => normalizeShrinkStatus(r.status) === 'Closed').length;
        const voidedCount = all.filter((r) => normalizeShrinkStatus(r.status) === 'Voided').length;
        const openSessions = sessions.filter((s) => s.status === 'open');
        // Legacy flag: no open walks left for the day (still used by older UI).
        const dayClosed = openSessions.length === 0 && sessions.some((s) => s.status === 'closed');
        res.json({
            success: true,
            store_date: storeDate,
            session_id: activeSession?.id || '',
            session: activeSession ? (sessions.find((s) => s.id === activeSession.id) || activeSession) : null,
            sessions,
            recent_sessions: recentSessions,
            rows: report.rows,
            departments: report.departments,
            totals: report.totals,
            reasons: SHRINK_REASONS,
            day_closed: dayClosed,
            counts: { open: openCount, closed: closedCount, voided: voidedCount, all: all.length },
        });
    }));

    /** Start a new concurrent shrink walk (does not require other walks to be open/closed). */
    server.post('/api/markdown/shrink/sessions', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const { createShrinkSession, listShrinkSessions } = require('../../lib/floor-shrink.cjs');
        const storeDate = shrinkStoreDate(req.body?.store_date);
        const label = String(req.body?.label || '').trim();
        const openN = (listShrinkSessions(db, storeDate).filter((s) => s.status === 'open').length) + 1;
        const created = createShrinkSession(db, {
            storeDate,
            label: label || `Walk ${openN}`,
            createdBy: session.name,
            source: 'manual',
            status: 'open',
        });
        broadcastUpdate();
        res.json({ success: true, session: created, sessions: listShrinkSessions(db, storeDate) });
    }));

    server.post('/api/markdown/shrink/sessions/:id/close', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const { closeShrinkSession, enrichShrinkRows, normalizeShrinkStatus } = require('../../lib/floor-shrink.cjs');
        const result = closeShrinkSession(db, {
            sessionId: req.params?.id,
            closedBy: session.name,
        });
        if (!result.ok) return fail(res, 400, result.error);
        db.upsertAudit(
            crypto.randomUUID(), new Date().toISOString(), session.name, 'close_floor_shrink_session',
            'floor_shrink_sessions',
            JSON.stringify({ session_id: result.session.id, closed: result.closed }),
        );
        broadcastUpdate();
        const rows = db.all(
            `SELECT * FROM floor_shrink_sku WHERE session_id = ? ORDER BY time_logged ASC`,
            result.session.id,
        ).filter((r) => normalizeShrinkStatus(r.status) !== 'Voided');
        const report = enrichShrinkRows(db, rows);
        res.json({
            success: true,
            session: result.session,
            closed: result.closed,
            totals: report.totals,
        });
    }));

    server.post('/api/markdown/shrink/sessions/:id/reopen', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const { reopenShrinkSession } = require('../../lib/floor-shrink.cjs');
        const result = reopenShrinkSession(db, {
            sessionId: req.params?.id,
            reopenedBy: session.name,
        });
        if (!result.ok) return fail(res, 400, result.error);
        db.upsertAudit(
            crypto.randomUUID(), new Date().toISOString(), session.name, 'reopen_floor_shrink_session',
            'floor_shrink_sessions',
            JSON.stringify({ session_id: result.session.id, reopened: result.reopened }),
        );
        broadcastUpdate();
        res.json({ success: true, session: result.session, reopened: result.reopened });
    }));

    server.get('/api/markdown/shrink/export', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const {
            enrichShrinkRows, shrinkReportCsv, shrinkReportHtml, normalizeShrinkStatus,
        } = require('../../lib/floor-shrink.cjs');
        const storeDate = shrinkStoreDate(req.query?.store_date);
        const format = String(req.query?.format || 'csv').toLowerCase() === 'print' ? 'print' : 'csv';
        const includeVoided = String(req.query?.include_voided || '') === '1';
        const rows = db.all(
            `SELECT * FROM floor_shrink_sku WHERE store_date = ? ORDER BY time_logged ASC LIMIT 2000`,
            storeDate,
        ).filter((r) => includeVoided || normalizeShrinkStatus(r.status) !== 'Voided');
        const report = enrichShrinkRows(db, rows);
        if (format === 'print') {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            return res.send(shrinkReportHtml(storeDate, report));
        }
        const stamp = storeDate.replace(/[^\d-]/g, '') || 'day';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="TGP_Floor_Shrink_${stamp}.csv"`);
        res.send(shrinkReportCsv(storeDate, report));
    }));

    server.patch('/api/markdown/shrink/:id', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const { enrichShrinkRow, normalizeShrinkStatus, SHRINK_STATUSES } = require('../../lib/floor-shrink.cjs');
        const id = String(req.params?.id || '').trim();
        if (!id) return fail(res, 400, 'Shrink line id required.');
        const existing = db.get('SELECT * FROM floor_shrink_sku WHERE id = ?', id);
        if (!existing) return fail(res, 404, 'Shrink line not found.');
        const currentStatus = normalizeShrinkStatus(existing.status);
        const b = req.body ?? {};
        const updates = {};

        if (b.status != null) {
            const next = String(b.status).trim();
            if (!SHRINK_STATUSES.has(next)) return fail(res, 400, 'Status must be Open, Closed, or Voided.');
            updates.status = next;
            if (next === 'Closed' || next === 'Voided') {
                updates.closed_at = new Date().toISOString();
                updates.closed_by = session.name;
            } else {
                updates.closed_at = '';
                updates.closed_by = '';
            }
        }

        // Closed / voided lines stay locked unless the caller is reopening or voiding.
        const unlocking = updates.status === 'Open' || updates.status === 'Voided';
        if (currentStatus !== 'Open' && !unlocking && (b.sku != null || b.item != null || b.quantity != null || b.reason != null)) {
            return fail(res, 409, 'This shrink line is closed. Reopen its count (or this line) before editing.');
        }

        if (b.quantity != null) {
            const qty = Number(b.quantity);
            if (!Number.isFinite(qty) || qty <= 0) return fail(res, 400, 'Quantity must be a positive number.');
            updates.quantity = qty;
        }
        if (b.reason != null) updates.reason = String(b.reason).trim().slice(0, 200);
        if (b.item != null) updates.item = String(b.item).trim();
        if (b.sku != null) {
            const sku = normalizeCode(b.sku) || String(b.sku || '').trim();
            if (!sku) return fail(res, 400, 'SKU required.');
            updates.sku = sku;
            // Wrong-scan fix: if they change the code and leave the name alone, pull the catalog name.
            if (b.item == null) {
                const hit = lookupItem(db, sku);
                if (hit?.description) updates.item = hit.description;
            }
        }
        if (!Object.keys(updates).length) return fail(res, 400, 'Nothing to update.');

        const fields = Object.keys(updates);
        db.run(
            `UPDATE floor_shrink_sku SET ${fields.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`,
            ...fields.map((f) => updates[f]),
            id,
        );
        if (updates.sku || updates.item) {
            learnFromEntry(db, {
                code: updates.sku || existing.sku,
                description: updates.item != null ? updates.item : existing.item,
                zone: existing.zone,
                actor: session.name,
            });
        }
        broadcastUpdate();
        const row = enrichShrinkRow(db, db.get('SELECT * FROM floor_shrink_sku WHERE id = ?', id));
        res.json({ success: true, row });
    }));

    /**
     * Close one session (preferred: body.session_id) or every open session for the store date.
     * Closing walk A does not block opening walk B the same day.
     */
    server.post('/api/markdown/shrink/close', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const {
            closeShrinkSession, listShrinkSessions, enrichShrinkRows, normalizeShrinkStatus,
        } = require('../../lib/floor-shrink.cjs');
        const storeDate = shrinkStoreDate(req.body?.store_date);
        const sessionId = String(req.body?.session_id || '').trim();
        if (sessionId) {
            const result = closeShrinkSession(db, { sessionId, closedBy: session.name });
            if (!result.ok) return fail(res, 400, result.error);
            db.upsertAudit(
                crypto.randomUUID(), new Date().toISOString(), session.name, 'close_floor_shrink',
                'floor_shrink_sessions',
                JSON.stringify({ session_id: sessionId, closed: result.closed }),
            );
            broadcastUpdate();
            return res.json({
                success: true,
                store_date: storeDate,
                session: result.session,
                closed: result.closed,
                day_closed: listShrinkSessions(db, storeDate).every((s) => s.status !== 'open'),
            });
        }
        const openSessions = listShrinkSessions(db, storeDate).filter((s) => s.status === 'open');
        if (!openSessions.length) return fail(res, 400, 'No open shrink counts to close.');
        let closed = 0;
        for (const s of openSessions) {
            const result = closeShrinkSession(db, { sessionId: s.id, closedBy: session.name });
            if (result.ok) closed += result.closed;
        }
        db.upsertAudit(
            crypto.randomUUID(), new Date().toISOString(), session.name, 'close_floor_shrink',
            'floor_shrink_sessions',
            JSON.stringify({ store_date: storeDate, sessions: openSessions.length, closed }),
        );
        broadcastUpdate();
        const rows = db.all(
            `SELECT * FROM floor_shrink_sku WHERE store_date = ? ORDER BY time_logged ASC`,
            storeDate,
        ).filter((r) => normalizeShrinkStatus(r.status) !== 'Voided');
        const report = enrichShrinkRows(db, rows);
        res.json({
            success: true,
            store_date: storeDate,
            closed,
            day_closed: true,
            totals: report.totals,
        });
    }));

    /** Reopen one session (body.session_id) or every closed session for the store date. */
    server.post('/api/markdown/shrink/reopen', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const { reopenShrinkSession, listShrinkSessions } = require('../../lib/floor-shrink.cjs');
        const storeDate = shrinkStoreDate(req.body?.store_date);
        const sessionId = String(req.body?.session_id || '').trim();
        if (sessionId) {
            const result = reopenShrinkSession(db, { sessionId, reopenedBy: session.name });
            if (!result.ok) return fail(res, 400, result.error);
            broadcastUpdate();
            return res.json({
                success: true,
                store_date: storeDate,
                session: result.session,
                reopened: result.reopened,
                day_closed: false,
            });
        }
        const closedSessions = listShrinkSessions(db, storeDate).filter((s) => s.status === 'closed');
        if (!closedSessions.length) return fail(res, 400, 'No closed shrink counts to reopen.');
        let reopened = 0;
        for (const s of closedSessions) {
            const result = reopenShrinkSession(db, { sessionId: s.id, reopenedBy: session.name });
            if (result.ok) reopened += result.reopened;
        }
        broadcastUpdate();
        res.json({ success: true, store_date: storeDate, reopened, day_closed: false });
    }));

    server.get('/api/markdown/archive', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        if (!isManagerRole(session.role) && !hasStaffPermission(db, session, 'markdown')) {
            return fail(res, 403, 'Markdown permission required.');
        }
        const { listMarkdownArchive } = require('../../lib/markdown-archive.cjs');
        const result = listMarkdownArchive(db, {
            q: req.query?.q,
            zone: req.query?.zone,
            status: req.query?.status,
            limit: req.query?.limit,
            offset: req.query?.offset,
        });
        res.json({ success: true, ...result });
    }));

    /** Shared gate for the item catalog: managers, or staff with markdown access. */
    const requireItemAccess = (req, res) => {
        const session = requireSession(req, res);
        if (!session) return null;
        if (!isManagerRole(session.role) && !hasStaffPermission(db, session, 'markdown')) {
            fail(res, 403, 'Markdown permission required.');
            return null;
        }
        return session;
    };

    server.get('/api/items/lookup', wrap(async (req, res) => {
        const session = requireItemAccess(req, res);
        if (!session) return;
        const item = lookupItem(db, req.query?.code);
        res.json({ success: true, found: !!item, item: item || null });
    }));

    server.get('/api/items/search', wrap(async (req, res) => {
        const session = requireItemAccess(req, res);
        if (!session) return;
        res.json({
            success: true,
            rows: searchItems(db, { q: req.query?.q, limit: req.query?.limit }),
            stats: catalogStats(db),
        });
    }));

    server.post('/api/items/upsert', wrap(async (req, res) => {
        const session = requireItemAccess(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const result = upsertItem(db, {
            code: b.code,
            description: b.description,
            zone: b.zone,
            department: b.department,
            size: b.size,
            source: 'manual',
            actor: session.name,
        });
        if (!result) return fail(res, 400, 'A usable item code is required.');
        res.json({ success: true, ...result, item: lookupItem(db, b.code) });
    }));

    server.post('/api/items/link-alias', wrap(async (req, res) => {
        const session = requireItemAccess(req, res);
        if (!session) return;
        const b = req.body ?? {};
        // Picking the product by hand is a deliberate correction, so let it collapse a
        // stray row that the same barcode had been learned under.
        const ok = linkAlias(db, b.alias_code, b.code, { source: 'manual', actor: session.name, merge: true });
        if (!ok) return fail(res, 400, 'Could not link that code — the target item must exist and the two codes must differ.');
        res.json({ success: true, item: lookupItem(db, b.alias_code) });
    }));

    server.post('/api/items/import-csv', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        if (!isManagerRole(session.role)) return fail(res, 403, 'Manager role required to import an item file.');
        const {
            filename, contentBase64, dry_run: dryRun, skip_known: skipKnown,
        } = req.body ?? {};
        let result;
        try {
            result = await importItemUpload(db, filename, contentBase64, {
                dryRun: dryRun === true || dryRun === 'true',
                skipKnown: skipKnown === true || skipKnown === 'true',
                actor: session.name,
            });
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Item import failed.');
        }
        if (!result.dry_run) {
            db.upsertAudit(
                crypto.randomUUID(), new Date().toISOString(), session.name,
                'import_item_catalog', 'item_catalog',
                JSON.stringify({
                    file: String(filename || '').slice(0, 200),
                    format: result.format,
                    imported: result.imported,
                    aliases: result.aliases,
                    already_known: result.already_known,
                    // Kept so "why is this product missing?" can be answered from the
                    // ledger later, without the original file.
                    rows_read: result.rows_read,
                    sheets: result.sheets,
                    skipped: result.skipped,
                    errors: result.errors,
                }),
            );
        }
        res.json({ success: true, filename: String(filename || '').slice(0, 200), ...result, stats: catalogStats(db) });
    }));

    server.post('/api/items/rebuild', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        if (!isManagerRole(session.role)) return fail(res, 403, 'Manager role required.');
        const result = backfillFromHistory(db);
        res.json({ success: true, ...result, stats: catalogStats(db) });
    }));

    server.post('/api/items/cleanup', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        if (!isManagerRole(session.role)) return fail(res, 403, 'Manager role required.');
        const result = purgeCatalogJunk(db);
        if (result.removed) {
            db.upsertAudit(
                crypto.randomUUID(), new Date().toISOString(), session.name,
                'cleanup_item_catalog', 'item_catalog',
                JSON.stringify(result),
            );
        }
        res.json({ success: true, ...result, stats: catalogStats(db) });
    }));

    server.get('/api/markdown/archive/lookup', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;
        if (!isManagerRole(session.role) && !hasStaffPermission(db, session, 'markdown')) {
            return fail(res, 403, 'Markdown permission required.');
        }
        const { findMarkdownDuplicates } = require('../../lib/markdown-archive.cjs');
        const result = findMarkdownDuplicates(db, {
            item_code: req.query?.item_code,
            item: req.query?.item,
            zone: req.query?.zone,
            kill_date: req.query?.kill_date,
        });
        res.json({ success: true, ...result });
    }));

    server.post('/api/markdown/shrink', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const {
            getShrinkSession, createShrinkSession, listShrinkSessions,
        } = require('../../lib/floor-shrink.cjs');
        const b = req.body ?? {};
        const sku = normalizeCode(b.sku) || String(b.sku || '').trim();
        if (!sku) return fail(res, 400, 'SKU required.');
        const qty = Number(b.quantity);
        const quantity = Number.isFinite(qty) && qty > 0 ? qty : 1;
        const now = new Date().toISOString();
        const storeDate = shrinkStoreDate(b.store_date);

        let shrinkSession = getShrinkSession(db, b.session_id);
        if (shrinkSession && shrinkSession.store_date !== storeDate) {
            return fail(res, 400, 'That shrink count belongs to a different store date.');
        }
        if (shrinkSession && shrinkSession.status !== 'open') {
            return fail(res, 409, 'That shrink count is closed. Open a new count or reopen this one.');
        }
        if (!shrinkSession) {
            // Prefer an existing open walk; otherwise start one so concurrent close doesn't block.
            const open = listShrinkSessions(db, storeDate).filter((s) => s.status === 'open');
            shrinkSession = open[0] || createShrinkSession(db, {
                storeDate,
                label: `Walk ${open.length + 1}`,
                createdBy: session.name,
                source: 'manual',
            });
        }

        const id = `FS-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        db.run(
            `INSERT INTO floor_shrink_sku
                (id, store_date, sku, item, quantity, reason, zone, source, logged_by, time_logged, notes, status, closed_at, closed_by, session_id)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            id,
            storeDate,
            sku,
            String(b.item || '').trim(),
            quantity,
            String(b.reason || '').trim().slice(0, 200),
            String(b.zone || '').trim(),
            'manual',
            session.name,
            now,
            String(b.notes || '').trim().slice(0, 500),
            'Open',
            '',
            '',
            shrinkSession.id,
        );
        learnFromEntry(db, {
            code: sku,
            description: b.item,
            zone: b.zone,
            actor: session.name,
            now,
        });
        broadcastUpdate();
        res.json({
            success: true,
            id,
            store_date: storeDate,
            session_id: shrinkSession.id,
            session: shrinkSession,
        });
    }));

    /**
     * Import shrink CSV (old-way sheets or TGP export).
     * - historical:true → create closed count(s) using store_date from file/body (past counts)
     * - else → append into an open session_id (or create one for today)
     */
    server.post('/api/markdown/shrink/import-csv', wrap(async (req, res) => {
        const session = requireShrinkAccess(req, res);
        if (!session) return;
        const {
            parseShrinkImportUpload, getShrinkSession, createShrinkSession, listShrinkSessions,
        } = require('../../lib/floor-shrink.cjs');
        const {
            filename, contentBase64, dry_run: dryRun, historical, session_id: bodySessionId, store_date: bodyDate,
        } = req.body ?? {};
        if (!String(contentBase64 || '').trim()) return fail(res, 400, 'Empty upload.');

        const parsed = await parseShrinkImportUpload(filename, contentBase64);
        if (!parsed.ok) return fail(res, 400, parsed.error);
        const { candidates, errors, has_store_date_column: hasDateCol } = parsed;
        const today = shrinkStoreDate(bodyDate);
        const asHistorical = historical === true || historical === 'true' || historical === 1;

        // Fill missing dates: historical uses body date or today; live import uses session/today.
        const dated = candidates.map((c) => ({
            ...c,
            store_date: c.store_date || (asHistorical ? shrinkStoreDate(bodyDate) : today),
            sku: normalizeCode(c.sku) || c.sku,
        }));

        const byDate = new Map();
        for (const row of dated) {
            if (!byDate.has(row.store_date)) byDate.set(row.store_date, []);
            byDate.get(row.store_date).push(row);
        }
        const dateList = [...byDate.keys()].sort();

        if (dryRun === true || dryRun === 'true') {
            return res.json({
                success: true,
                dry_run: true,
                filename: String(filename || parsed.filename || '').slice(0, 200),
                format: parsed.format || '',
                historical: asHistorical,
                has_store_date_column: !!hasDateCol,
                store_dates: dateList,
                report_store_date: parsed.store_date || '',
                candidates: dated.slice(0, 40),
                errors,
                import_count: dated.length,
                sample_count: Math.min(40, dated.length),
            });
        }

        const now = new Date().toISOString();
        let liveSession = null;
        if (!asHistorical) {
            liveSession = getShrinkSession(db, bodySessionId);
            if (liveSession && liveSession.status !== 'open') {
                return fail(res, 409, 'That shrink count is closed. Open a new count or import as historical.');
            }
        }

        let imported = 0;
        const createdSessions = [];

        db.transaction(() => {
            if (asHistorical) {
                for (const storeDate of dateList) {
                    const rows = byDate.get(storeDate);
                    const labelBase = String(filename || 'CSV import').replace(/\.[^.]+$/, '').slice(0, 60);
                    const shrinkSession = createShrinkSession(db, {
                        storeDate,
                        label: `${labelBase || 'Imported count'}`.slice(0, 80),
                        createdBy: session.name,
                        source: 'csv',
                        status: 'closed',
                        notes: 'Imported historical shrink CSV',
                        now,
                    });
                    createdSessions.push(shrinkSession);
                    for (const row of rows) {
                        const id = `FS-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
                        db.run(
                            `INSERT INTO floor_shrink_sku
                                (id, store_date, sku, item, quantity, reason, zone, source, logged_by, time_logged, notes, status, closed_at, closed_by, session_id)
                             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                            id, storeDate, row.sku, row.item, row.quantity, row.reason, row.zone,
                            'csv', session.name, now, '', 'Closed', now, session.name, shrinkSession.id,
                        );
                        learnFromEntry(db, {
                            code: row.sku,
                            description: row.item,
                            zone: row.zone,
                            actor: session.name,
                            now,
                        });
                        imported += 1;
                    }
                }
            } else {
                let shrinkSession = liveSession;
                if (!shrinkSession) {
                    const open = listShrinkSessions(db, today).filter((s) => s.status === 'open');
                    shrinkSession = open[0] || createShrinkSession(db, {
                        storeDate: today,
                        label: `CSV import ${open.length + 1}`,
                        createdBy: session.name,
                        source: 'csv',
                        now,
                    });
                }
                createdSessions.push(shrinkSession);
                for (const row of dated) {
                    const id = `FS-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
                    db.run(
                        `INSERT INTO floor_shrink_sku
                            (id, store_date, sku, item, quantity, reason, zone, source, logged_by, time_logged, notes, status, closed_at, closed_by, session_id)
                         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                        id, shrinkSession.store_date, row.sku, row.item, row.quantity, row.reason, row.zone,
                        'csv', session.name, now, '', 'Open', '', '', shrinkSession.id,
                    );
                    learnFromEntry(db, {
                        code: row.sku,
                        description: row.item,
                        zone: row.zone,
                        actor: session.name,
                        now,
                    });
                    imported += 1;
                }
            }
            db.upsertAudit(
                crypto.randomUUID(), now, session.name, 'import_floor_shrink_csv', 'floor_shrink_sku',
                JSON.stringify({
                    file: String(filename || '').slice(0, 200),
                    imported,
                    historical: asHistorical,
                    sessions: createdSessions.map((s) => s.id),
                    errors: errors.length,
                }),
            );
        })();
        broadcastUpdate();
        res.json({
            success: true,
            imported,
            errors,
            historical: asHistorical,
            store_dates: dateList,
            sessions: createdSessions,
            filename: String(filename || '').slice(0, 200),
        });
    }));
}

module.exports = { registerOpsRoutes };
