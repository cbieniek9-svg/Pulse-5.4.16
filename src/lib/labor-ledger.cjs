'use strict';

const { buildRhythmAssignContext, shouldSkipFifoRhythm, canonicalStaffName } = require('./rhythm-schedule-assign.cjs');
const { classifyShift, bucketLabel } = require('./schedule-role-buckets.cjs');
const { getDeferredRhythmIds } = require('./reports-actions.cjs');
const { parseStaffRoster } = require('./reports-order-analytics.cjs');
const { suggestEstMinutes } = require('./task-estimates.cjs');
const { buildMinimumHoursComparison } = require('./labor-minimum-baseline.cjs');

function round1(v) {
    if (v == null || Number.isNaN(v)) return null;
    return Math.round(v * 10) / 10;
}

function parseTimeToMinutes(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function shiftDurationHours(startTime, endTime) {
    const start = parseTimeToMinutes(startTime);
    const end = parseTimeToMinutes(endTime);
    if (start == null || end == null) return 0;
    let mins = end - start;
    if (mins <= 0) mins += 24 * 60;
    if (mins > 16 * 60) return 0;
    return mins / 60;
}

function sumRhythmLoadMinutes(db, storeDate, storeWeekday) {
    const deferred = new Set(getDeferredRhythmIds(db, storeDate).map(String));
    const skipFifo = shouldSkipFifoRhythm(db, storeDate);
    const day = storeWeekday || '';
    const templates = db.all(
        "SELECT id, detail, est_mins, zone FROM rhythm_tasks WHERE day=? OR day='Everyday'",
        day,
    ) || [];

    let total = 0;
    const lines = [];
    templates.forEach((t) => {
        if (deferred.has(String(t.id))) return;
        const detail = String(t.detail || '');
        if (skipFifo && /FIFO Audit/i.test(detail)) return;
        let est = Number(t.est_mins || 0);
        if (!est) {
            try {
                est = suggestEstMinutes(db, { detail, fallback: 15 });
            } catch (_) {
                est = 15;
            }
        }
        total += est;
        lines.push({ detail, est_mins: est, zone: t.zone || 'General' });
    });

    return { total_mins: total, task_count: lines.length, lines: lines.slice(0, 8) };
}

function sumOpenTaskDrag(db) {
    const rows = db.all(`
        SELECT priority, est_mins FROM tasks
        WHERE status='Open'
          AND priority IN ('Urgent', 'High')
          AND task_id NOT LIKE 'AUTO-PULL-%'
    `) || [];
    let mins = 0;
    rows.forEach((r) => {
        mins += Math.max(5, Number(r.est_mins || 15));
    });
    return { minutes: mins, count: rows.length };
}

/**
 * @param {object} db
 * @param {object} opts
 * @param {string} opts.storeDate
 * @param {string} [opts.storeWeekday]
 * @param {object} [opts.orderDayBriefing]
 * @param {object} [opts.settings]
 * @param {object} [opts.shiftSummary]
 * @param {object} [opts.orderMetrics]
 * @param {boolean} [opts.isOrderDay]
 */
function buildLaborLedger(db, opts = {}) {
    const storeDate = opts.storeDate || new Date().toISOString().slice(0, 10);
    const storeWeekday = opts.storeWeekday || '';
    const briefing = opts.orderDayBriefing || {};
    const settings = opts.settings || {};
    const shift = opts.shiftSummary || {};
    const orderMetrics = opts.orderMetrics || {};
    const isOrderDay = opts.isOrderDay != null ? opts.isOrderDay : !!briefing.is_order_day;

    const ctx = buildRhythmAssignContext(db, storeDate);
    const roleRulesJson = ctx.roleRulesJson || settings.Schedule_Role_Buckets || '';

    const shifts = db.all(
        'SELECT staff_name, start_time, end_time, role, department FROM staff_shifts WHERE shift_date = ?',
        storeDate,
    ) || [];

    const bucketHours = {};
    let scheduledHours = 0;
    const scheduledNames = new Set();
    shifts.forEach((s) => {
        const hrs = shiftDurationHours(s.start_time, s.end_time);
        if (hrs <= 0) return;
        scheduledHours += hrs;
        const canonical = canonicalStaffName(ctx.directory, s.staff_name);
        const name = canonical || String(s.staff_name || '').trim();
        if (name) scheduledNames.add(name.toLowerCase());
        const bucket = classifyShift(s.department, s.role, roleRulesJson);
        bucketHours[bucket] = round1((bucketHours[bucket] || 0) + hrs);
    });

    const scheduleComplement = scheduledNames.size;
    const rhythm = sumRhythmLoadMinutes(db, storeDate, storeWeekday);
    const rhythmHours = rhythm.total_mins / 60;

    let orderHours = 0;
    let orderStaff = null;
    if (isOrderDay) {
        const durMins = Number(briefing.expected_duration_minutes || 0);
        orderStaff = briefing.expected_staff != null ? Number(briefing.expected_staff) : null;
        if (durMins > 0 && orderStaff > 0) {
            orderHours = (durMins / 60) * orderStaff;
        } else if (Number(orderMetrics.standard_hours || 0) > 0 && Number(orderMetrics.staff_count || 0) > 0) {
            orderHours = Number(orderMetrics.standard_hours) * Number(orderMetrics.staff_count);
            orderStaff = Number(orderMetrics.staff_count);
        }
    }

    const vendorCount = (() => {
        try {
            return db.all('SELECT vendor FROM vendor_schedule WHERE day=?', storeWeekday).length;
        } catch (_) {
            return 0;
        }
    })();
    const vendorMins = vendorCount * 20;

    const urgent = sumOpenTaskDrag(db);
    const pullsDue = Number(shift.kill_dates_due || 0);
    const pullMins = pullsDue * 12;
    const ordersOpen = Number(shift.orders_open || 0);
    const orderFollowMins = ordersOpen * 8;
    const vendorsPending = Number(shift.vendors_pending || 0);
    const receivingMins = vendorsPending * 15;
    const hardwarePieces = Number(orderMetrics.hardware_pieces || settings.Hardware_Count || 0);
    const hardwareArrived = settings.Hardware_Arrived === '1';
    const hardwareMins = (isOrderDay && hardwarePieces > 0 && !hardwareArrived) ? 30 : 0;

    const fixedDragMins = vendorMins + urgent.minutes + pullMins + orderFollowMins + receivingMins + hardwareMins;
    const fixedDragHours = fixedDragMins / 60;

    const committedHours = round1(rhythmHours + orderHours + fixedDragHours);
    const scheduledRounded = round1(scheduledHours);
    const minimumBaseline = buildMinimumHoursComparison(scheduledRounded, storeWeekday, settings);

    let verdict = 'unknown';
    let verdictDetail = 'Import schedule to compare capacity vs committed work.';
    if (scheduledRounded > 0 && committedHours != null) {
        const ratio = scheduledRounded / committedHours;
        if (ratio >= 1.08) {
            verdict = 'surplus';
            verdictDetail = 'Scheduled hours exceed committed workload — room for catch-up or training.';
        } else if (ratio >= 0.92) {
            verdict = 'tight';
            verdictDetail = 'Scheduled hours roughly match committed workload — protect order window and defer non-critical rhythm if needed.';
        } else {
            verdict = 'under';
            verdictDetail = 'Committed work exceeds scheduled hours — consider deferring rhythm, adding float, or adjusting order crew.';
        }
    } else if (!shifts.length) {
        verdict = 'no_schedule';
        verdictDetail = 'No staff schedule imported for this date.';
    }

    const finishStaff = Number(orderMetrics.staff_count || settings.Staff_Count || 0) || null;
    const archived = db.get('SELECT staff_count, staff_roster FROM shift_order_history WHERE store_date=?', storeDate);
    const finishRoster = parseStaffRoster(archived?.staff_roster);
    const finishStaffArchived = archived ? Math.max(1, Number(archived.staff_count || 1)) : null;

    const scheduleVsFinish = {
        schedule_complement: scheduleComplement,
        finish_staff_live: finishStaff,
        finish_staff_archived: finishStaffArchived,
        finish_roster: finishRoster,
        expected_staff: orderStaff,
        mismatch: isOrderDay && scheduleComplement > 0 && finishStaffArchived != null
            ? finishStaffArchived < scheduleComplement - 1
            : false,
        complement_vs_expected: isOrderDay && scheduleComplement > 0 && orderStaff != null
            ? scheduleComplement - orderStaff
            : null,
    };

    const reasons = [];
    if (scheduleVsFinish.mismatch) {
        reasons.push(`FINISH staff (${finishStaffArchived}) below schedule complement (${scheduleComplement})`);
    }
    if (scheduleVsFinish.complement_vs_expected != null && scheduleVsFinish.complement_vs_expected < -0.5) {
        reasons.push(`Schedule complement below typical order crew (${orderStaff})`);
    }
    if (minimumBaseline.over_minimum) {
        reasons.push(`Scheduled hours ${scheduledRounded}h exceed minimum baseline ${minimumBaseline.minimum_hours}h by ${minimumBaseline.overage_pct}% (threshold ${minimumBaseline.soft_threshold_pct}%)`);
    }
    if (verdict === 'under') reasons.push('Total committed hours exceed scheduled person-hours');
    if (isOrderDay && hardwareMins > 0) reasons.push('Hardware on order not yet arrived');
    if (urgent.count > 0) reasons.push(`${urgent.count} Urgent/High open task(s)`);
    if (pullsDue > 0) reasons.push(`${pullsDue} expiry pull(s) due`);

    const bucketBreakdown = Object.entries(bucketHours)
        .filter(([, hrs]) => hrs > 0)
        .map(([bucket, hours]) => ({ bucket, label: bucketLabel(bucket), hours }))
        .sort((a, b) => b.hours - a.hours);

    return {
        store_date: storeDate,
        weekday: storeWeekday,
        is_order_day: isOrderDay,
        shift_lead: String(settings.Active_Manager || ctx.activeManager || '').trim(),
        scheduled: {
            complement: scheduleComplement,
            person_hours: scheduledRounded,
            shift_rows: shifts.length,
            by_bucket: bucketBreakdown,
        },
        committed: {
            rhythm_hours: round1(rhythmHours),
            rhythm_tasks: rhythm.task_count,
            order_hours: round1(orderHours),
            order_staff_expected: orderStaff,
            fixed_drag_hours: round1(fixedDragHours),
            person_hours: committedHours,
        },
        fixed_drag: {
            vendor_rhythm_mins: vendorMins,
            vendor_count: vendorCount,
            urgent_open_mins: urgent.minutes,
            urgent_open_count: urgent.count,
            pulls_due_mins: pullMins,
            pulls_due_count: pullsDue,
            customer_orders_mins: orderFollowMins,
            customer_orders_open: ordersOpen,
            receiving_pending_mins: receivingMins,
            vendors_pending: vendorsPending,
            hardware_mins: hardwareMins,
        },
        schedule_vs_finish: scheduleVsFinish,
        minimum_baseline: minimumBaseline,
        verdict,
        verdict_detail: verdictDetail,
        reasons: reasons.slice(0, 6),
        rhythm_preview: rhythm.lines,
    };
}

module.exports = { buildLaborLedger, shiftDurationHours, parseTimeToMinutes };
