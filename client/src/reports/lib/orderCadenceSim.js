const WEEK_DAYS = 7;

function breakDeductionPerPerson(hours) {
    const t = Number(hours);
    if (!Number.isFinite(t) || t <= 0) return 0;
    if (t < 2) return 0;
    if (t < 4) return 0.25;
    if (t < 6) return 0.75;
    return 1.0;
}

function solveClockHours(productiveHoursPerPerson) {
    const p = Math.max(0, Number(productiveHoursPerPerson) || 0);
    let t = p;
    for (let i = 0; i < 8; i += 1) {
        const next = p + breakDeductionPerPerson(t);
        if (Math.abs(next - t) < 1e-6) {
            t = next;
            break;
        }
        t = next;
    }
    return t;
}

function deriveCadenceBaseline(ows) {
    if (!ows || !ows.overall) return null;
    const o = ows.overall;
    const avgPieces = Number(o.avg_pieces) || 0;
    const avgStaff = Math.max(1, Number(o.avg_staff) || 1);

    let rate = Number(o.avg_adj_pph) || 0;
    if (!(rate > 0)) {
        const team = Number(o.avg_team_pph) || 0;
        rate = team > 0 ? team / avgStaff : 0;
    }

    const byDay = Array.isArray(ows.by_weekday)
        ? ows.by_weekday.filter((r) => Number(r.order_days) > 0)
        : [];
    let daysPerWeek = byDay.length;
    if (!(daysPerWeek > 0)) {
        const weeks = (Number(ows.window_days) || 90) / WEEK_DAYS;
        daysPerWeek = weeks > 0 ? (Number(ows.order_days) || 0) / weeks : 0;
    }
    daysPerWeek = Math.max(1, Math.round(daysPerWeek));

    return {
        avg_pieces: Math.round(avgPieces),
        avg_staff: Number(avgStaff.toFixed(1)),
        rate_pp_hour: Number(rate.toFixed(2)),
        days_per_week: daysPerWeek,
        weekly_pieces: Math.round(avgPieces * daysPerWeek),
        sample_days: Number(ows.order_days) || 0,
        window_days: Number(ows.window_days) || 90,
    };
}

function simulateCadence(base, days, opts) {
    if (!base) return null;
    const o = opts || {};
    const staff = Math.max(1, Number(o.staff) || base.avg_staff);
    const overheadPerDay = Math.max(0, Number(o.overhead_hours_per_order_day) || 0);
    const M = Math.max(1, Math.round(Number(days) || 0));
    const rate = base.rate_pp_hour;
    const W = base.weekly_pieces;
    if (!(rate > 0) || !(W > 0)) return null;

    const piecesPerDay = W / M;
    const prodPersonHoursPerDay = piecesPerDay / rate;
    const prodHoursPerPerson = prodPersonHoursPerDay / staff;
    const clockHoursPerPerson = solveClockHours(prodHoursPerPerson);
    const breakPerPerson = Math.max(0, clockHoursPerPerson - prodHoursPerPerson);

    const weeklyProductiveHours = M * staff * prodHoursPerPerson;
    const weeklyClockHours = (M * staff * clockHoursPerPerson) + (M * overheadPerDay);
    const effectivePph = weeklyClockHours > 0 ? W / weeklyClockHours : 0;

    return {
        days_per_week: M,
        staff: Number(staff.toFixed(1)),
        pieces_per_day: Math.round(piecesPerDay),
        day_length_hours: Number(clockHoursPerPerson.toFixed(2)),
        day_length_mins: Math.round(clockHoursPerPerson * 60),
        break_per_person_hours: Number(breakPerPerson.toFixed(2)),
        weekly_clock_person_hours: Number(weeklyClockHours.toFixed(1)),
        weekly_productive_person_hours: Number(weeklyProductiveHours.toFixed(1)),
        effective_pph: Number(effectivePph.toFixed(1)),
    };
}

function pickBestCadence(scenarios) {
    if (!Array.isArray(scenarios) || !scenarios.length) return null;
    return scenarios.reduce((best, s) => {
        if (!best) return s;
        if (s.effective_pph > best.effective_pph + 1e-9) return s;
        if (Math.abs(s.effective_pph - best.effective_pph) <= 1e-9 && s.days_per_week < best.days_per_week) return s;
        return best;
    }, null);
}

export function simulateOrderCadence(ows, opts) {
    const base = deriveCadenceBaseline(ows);
    if (!base || !(base.rate_pp_hour > 0) || !(base.weekly_pieces > 0)) {
        return { ok: false, reason: 'insufficient_data', baseline: base || null };
    }
    const o = opts || {};
    const minDays = Math.max(1, Math.round(o.min_days || Math.max(1, base.days_per_week - 1)));
    const maxDays = Math.max(minDays, Math.round(o.max_days || (base.days_per_week + 3)));
    const current = simulateCadence(base, base.days_per_week, o);

    const scenarios = [];
    for (let m = minDays; m <= maxDays; m += 1) {
        const sim = simulateCadence(base, m, o);
        if (!sim) continue;
        const deltaPph = current ? Number((sim.effective_pph - current.effective_pph).toFixed(1)) : 0;
        scenarios.push({
            ...sim,
            is_current: m === base.days_per_week,
            delta_pph: deltaPph,
            delta_pph_pct: current && current.effective_pph > 0
                ? Number(((deltaPph / current.effective_pph) * 100).toFixed(1))
                : 0,
            delta_labor_hours: current
                ? Number((sim.weekly_clock_person_hours - current.weekly_clock_person_hours).toFixed(1))
                : 0,
        });
    }
    return { ok: true, baseline: base, current, scenarios, best: pickBestCadence(scenarios) };
}
