'use strict';

/**
 * Live shift / order metrics for TV KPI overlay and sync.
 * Shift PPH uses grocery + frozen; hardware counts only when Hardware_Arrived is set.
 * @param {object} settings
 * @param {object} counts
 * @param {Date} [now]
 */
function formatElapsed(mins) {
    const m = Math.max(0, Math.round(mins));
    if (m < 1) return '0m';
    const h = Math.floor(m / 60);
    const r = m % 60;
    return h ? `${h}h ${r}m` : `${r}m`;
}

function computeShiftMetrics(settings = {}, counts = {}, now = new Date()) {
    const os = settings.Order_Start || '';
    const oe = settings.Order_End || '';
    const g = Number(counts.grocery || 0);
    const f = Number(counts.frozen || 0);
    const h = Number(counts.hardware || 0);
    const staff = Math.max(1, Number(counts.staff || 1));
    const { total_pieces: totalPieces } = resolveOrderPieceCounts({
        grocery: g,
        frozen: f,
        hardware: h,
        hardwareArrived: settings.Hardware_Arrived,
    });
    const cph = parseFloat(settings.Cases_Per_Hour) || 55;

    let status = 'off';
    let elapsedMins = 0;
    if (os && !oe) {
        status = 'running';
        const startMs = Date.parse(os);
        if (Number.isFinite(startMs)) {
            elapsedMins = Math.max(0, Math.round((now.getTime() - startMs) / 60000));
        }
    } else if (os && oe) {
        const startMs = Date.parse(os);
        const endMs = Date.parse(oe);
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs) {
            status = 'done';
            elapsedMins = Math.round((endMs - startMs) / 60000);
        }
    }

    const elapsedHours = elapsedMins / 60;
    const shiftPph = elapsedHours > 0 ? totalPieces / elapsedHours : null;
    const lastActual = parseFloat(settings.Last_Actual_PPH);
    const shiftPphFinal = shiftPph != null
        ? Number(shiftPph.toFixed(1))
        : (Number.isFinite(lastActual) && lastActual > 0 ? lastActual : null);

    return {
        shift_active: status === 'running',
        shift_done: status === 'done',
        shift_status: status,
        shift_elapsed_mins: elapsedMins,
        shift_elapsed: formatElapsed(elapsedMins),
        shift_total_pieces: totalPieces,
        shift_pph: shiftPph != null ? Number(shiftPph.toFixed(1)) : null,
        shift_standard_pph: cph,
        order_staff: staff,
        shift_pph_final: shiftPphFinal,
    };
}

/** Client-side live PPH between syncs (same formula as server). */
function computeLiveShiftPph(orderStartIso, totalPieces, now = new Date()) {
    const startMs = Date.parse(orderStartIso || '');
    if (!Number.isFinite(startMs)) return null;
    const pieces = Number(totalPieces) || 0;
    const elapsedMins = Math.max(0, Math.round((now.getTime() - startMs) / 60000));
    const elapsedHours = elapsedMins / 60;
    if (elapsedHours <= 0) return null;
    return Number((pieces / elapsedHours).toFixed(1));
}

/**
 * Order piece totals for reports / archive — hardware counts only when marked arrived.
 * @param {{ grocery?: number, frozen?: number, hardware?: number, hardwareArrived?: boolean|string|number }} p
 */
function resolveOrderPieceCounts({ grocery = 0, frozen = 0, hardware = 0, hardwareArrived = false } = {}) {
    const g = Number(grocery || 0);
    const f = Number(frozen || 0);
    const hRaw = Number(hardware || 0);
    const includeHardware = hardwareArrived === true || hardwareArrived === '1' || hardwareArrived === 1;
    const h = includeHardware ? hRaw : 0;
    return {
        grocery_pieces: g,
        frozen_pieces: f,
        hardware_pieces: h,
        hardware_raw: hRaw,
        hardware_included: includeHardware,
        total_pieces: g + f + h,
    };
}

function computeStandardOrderHours(grocery, frozen, hardware, cph, hardwareCph, hardwareArrived) {
    const { grocery_pieces: g, frozen_pieces: f, hardware_pieces: h } = resolveOrderPieceCounts({
        grocery, frozen, hardware, hardwareArrived,
    });
    const casesCph = parseFloat(cph) || 55;
    const hwCph = parseFloat(hardwareCph) || 50;
    return (g + f) / casesCph + (h / hwCph);
}

/** Staff on order — prefer explicit counts.staff, else active roster headcount. */
function resolveOrderStaffCount(counts = {}, db = null) {
    const fromCounts = Number(counts?.staff);
    if (Number.isFinite(fromCounts) && fromCounts > 0) return Math.min(99, Math.max(1, fromCounts));
    if (db?.get) {
        try {
            const row = db.get("SELECT COUNT(*) as c FROM staff WHERE active = 1 AND name != 'Unassigned'");
            const active = Number(row?.c || 0);
            if (active > 0) return Math.min(99, active);
        } catch (_) { /* ignore */ }
    }
    return 1;
}

function parseHardwareArrived(value) {
    return value === true || value === '1' || value === 1;
}

/** Team order throughput + per-person rate for reports / order history. */
function computeOrderPphMetrics(totalPieces, actualOrderMinutes, staffCount) {
    const staff = Math.max(1, Number(staffCount || 1));
    const pieces = Number(totalPieces || 0);
    const mins = Number(actualOrderMinutes || 0);
    if (mins <= 0) return { team_pph: 0, per_person_pph: 0 };
    const teamPph = pieces / (mins / 60);
    return {
        team_pph: Number(teamPph.toFixed(1)),
        per_person_pph: Number((teamPph / staff).toFixed(1)),
    };
}

/**
 * Tiered break deduction per person (clock hours) for archived shift reporting.
 * T under 2h: 0 · 2h–4h: 0.25 · 4h–6h: 0.75 · 6h+: 1.0
 */
function computeBreakDeductionPerPerson(elapsedHours) {
    const t = Number(elapsedHours);
    if (!Number.isFinite(t) || t <= 0) return 0;
    if (t < 2) return 0;
    if (t < 4) return 0.25;
    if (t < 6) return 0.75;
    return 1.0;
}

/** Raw clock PPH plus break-adjusted per-person rate for archived shifts / reports. */
function computeArchivedOrderMetrics(totalPieces, actualOrderMinutes, staffCount) {
    const raw = computeOrderPphMetrics(totalPieces, actualOrderMinutes, staffCount);
    const staff = Math.max(1, Number(staffCount || 1));
    const mins = Number(actualOrderMinutes || 0);
    const elapsedHours = mins / 60;
    const breakDeduction = computeBreakDeductionPerPerson(elapsedHours);
    const productiveHoursPerPerson = Math.max(0, elapsedHours - breakDeduction);
    const adjustedLaborHours = staff * productiveHoursPerPerson;
    let adjustedPerPersonPph = 0;
    if (adjustedLaborHours > 0) {
        adjustedPerPersonPph = Number((Number(totalPieces || 0) / adjustedLaborHours).toFixed(1));
    }
    return {
        ...raw,
        break_deduction_hours_per_person: breakDeduction,
        adjusted_labor_hours: Number(adjustedLaborHours.toFixed(2)),
        adjusted_per_person_pph: adjustedPerPersonPph,
    };
}

module.exports = {
    computeShiftMetrics,
    formatElapsed,
    computeLiveShiftPph,
    resolveOrderPieceCounts,
    resolveOrderStaffCount,
    parseHardwareArrived,
    computeStandardOrderHours,
    computeOrderPphMetrics,
    computeBreakDeductionPerPerson,
    computeArchivedOrderMetrics,
};
