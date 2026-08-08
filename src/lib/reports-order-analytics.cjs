'use strict';

const { WEEKDAY_NAMES, weekdayFromStoreDate } = require('./order-weekly-scorecard.cjs');

function round1(v) {
    if (v == null || Number.isNaN(v)) return null;
    return Math.round(v * 10) / 10;
}

function parseStaffRoster(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((n) => String(n).trim()).filter(Boolean);
    const s = String(raw).trim();
    if (!s) return [];
    try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed.map((n) => String(n).trim()).filter(Boolean);
    } catch (_) { /* fall through */ }
    return s.split(/[,;|]/).map((n) => n.trim()).filter(Boolean);
}

function normalizeExceptionReason(raw) {
    const s = String(raw || '').trim();
    if (!s || s === '—' || s === '-') return '';
    return s.slice(0, 200);
}

/**
 * Roll up non-empty exception_reason values from order archive rows.
 */
function buildExceptionReasonRollup(historyRows, { windowDays = 90, limit = 12 } = {}) {
    const rows = (historyRows || []).slice(0, windowDays);
    const groups = {};
    rows.forEach((r) => {
        const reason = normalizeExceptionReason(r.exception_reason);
        if (!reason) return;
        const key = reason.toLowerCase();
        if (!groups[key]) {
            groups[key] = { reason, count: 0, dates: [], total_pieces: 0, staff_counts: [] };
        }
        groups[key].count += 1;
        groups[key].dates.push(r.store_date);
        groups[key].total_pieces += Number(r.total_pieces || 0);
        groups[key].staff_counts.push(Math.max(1, Number(r.staff_count || 1)));
    });

    const rollup = Object.values(groups)
        .map((g) => ({
            reason: g.reason,
            count: g.count,
            recent_dates: g.dates.slice(0, 5),
            avg_pieces: round1(g.total_pieces / g.count),
            avg_staff: round1(g.staff_counts.reduce((a, b) => a + b, 0) / g.staff_counts.length),
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

    const taggedDays = rows.filter((r) => normalizeExceptionReason(r.exception_reason)).length;

    return {
        window_days: windowDays,
        tagged_order_days: taggedDays,
        total_order_days: rows.length,
        reasons: rollup,
    };
}

/**
 * Average adjusted PPH by FINISH staff count (all archived order days).
 */
function buildStaffCountCurve(historyRows, { weekdayName = null } = {}) {
    let rows = (historyRows || []).filter((r) => Number(r.actual_order_minutes || 0) > 0);
    if (weekdayName) {
        const target = String(weekdayName).trim();
        rows = rows.filter((r) => {
            const idx = weekdayFromStoreDate(r.store_date);
            return WEEKDAY_NAMES[idx] === target;
        });
    }

    const buckets = {};
    rows.forEach((r) => {
        const staff = Math.max(1, Math.min(99, Number(r.staff_count || 1)));
        const adj = Number(r.adjusted_per_person_pph ?? r.actual_pieces_per_hour ?? 0);
        if (!buckets[staff]) buckets[staff] = { staff_count: staff, samples: 0, adj_pph: [], minutes: [] };
        buckets[staff].samples += 1;
        if (adj > 0) buckets[staff].adj_pph.push(adj);
        buckets[staff].minutes.push(Number(r.actual_order_minutes || 0));
    });

    return Object.values(buckets)
        .map((b) => ({
            staff_count: b.staff_count,
            samples: b.samples,
            avg_adj_pph: round1(b.adj_pph.length
                ? b.adj_pph.reduce((a, c) => a + c, 0) / b.adj_pph.length
                : null),
            avg_minutes: round1(b.minutes.length
                ? b.minutes.reduce((a, c) => a + c, 0) / b.minutes.length
                : null),
        }))
        .sort((a, b) => a.staff_count - b.staff_count);
}

function rosterKey(names) {
    return [...names]
        .map((n) => String(n).trim().toLowerCase())
        .filter(Boolean)
        .sort()
        .join('|');
}

const TGP_ORDER_WEEKDAYS = Object.freeze(['Sunday', 'Tuesday', 'Thursday']);

function accumulateRosterGroups(rows) {
    const groups = {};
    (rows || []).forEach((r) => {
        const roster = parseStaffRoster(r.staff_roster);
        if (!roster.length) return;
        const key = rosterKey(roster);
        if (!groups[key]) {
            groups[key] = {
                roster: roster.slice().sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
                samples: 0,
                team_pph: [],
                adj_pph: [],
                pieces: [],
                minutes: [],
                dates: [],
            };
        }
        const g = groups[key];
        g.samples += 1;
        g.dates.push(r.store_date);
        g.pieces.push(Number(r.total_pieces || 0));
        g.minutes.push(Number(r.actual_order_minutes || 0));
        const team = Number(r.team_pph ?? r.actual_pieces_per_hour ?? 0);
        const adj = Number(r.adjusted_per_person_pph ?? 0);
        if (team > 0) g.team_pph.push(team);
        if (adj > 0) g.adj_pph.push(adj);
    });
    return groups;
}

function summarizeRosterGroup(g) {
    return {
        roster: g.roster,
        roster_label: g.roster.join(' · '),
        staff_count: g.roster.length,
        samples: g.samples,
        avg_team_pph: round1(g.team_pph.length
            ? g.team_pph.reduce((a, c) => a + c, 0) / g.team_pph.length
            : null),
        avg_adj_pph: round1(g.adj_pph.length
            ? g.adj_pph.reduce((a, c) => a + c, 0) / g.adj_pph.length
            : null),
        avg_pieces: round1(g.pieces.length
            ? g.pieces.reduce((a, c) => a + c, 0) / g.pieces.length
            : null),
        avg_minutes: round1(g.minutes.length
            ? g.minutes.reduce((a, c) => a + c, 0) / g.minutes.length
            : null),
        recent_dates: g.dates.slice(0, 5),
    };
}

function rankRosterGroups(groups, { limit = 12, minSamples = 1, withRank = false } = {}) {
    return Object.values(groups)
        .filter((g) => g.samples >= minSamples)
        .map(summarizeRosterGroup)
        .sort((a, b) => (b.avg_adj_pph || 0) - (a.avg_adj_pph || 0))
        .slice(0, limit)
        .map((entry, index) => {
            if (!withRank) return entry;
            return {
                ...entry,
                rank: index + 1,
                confidence: entry.samples >= 3 ? 'strong' : entry.samples >= 2 ? 'solid' : 'early',
            };
        });
}

/**
 * Roll up archived order days by FINISH crew roster (sorted name set).
 */
function buildRosterPerformanceRollup(historyRows, { limit = 12, minSamples = 1 } = {}) {
    const rows = (historyRows || []).filter((r) => Number(r.actual_order_minutes || 0) > 0);
    return rankRosterGroups(accumulateRosterGroups(rows), { limit, minSamples });
}

/**
 * Best roster suggestions per TGP order weekday (Sun/Tue/Thu), ranked by avg adj/person PPH.
 */
function buildRosterSuggestionsByWeekday(historyRows, {
    orderWeekdays = TGP_ORDER_WEEKDAYS,
    limitPerDay = 3,
    minSamples = 1,
    windowDays = 90,
} = {}) {
    const rows = (historyRows || [])
        .filter((r) => Number(r.actual_order_minutes || 0) > 0)
        .slice(0, windowDays);

    const byWeekday = orderWeekdays.map((weekday) => {
        const weekdayRows = rows.filter((r) => {
            const idx = weekdayFromStoreDate(r.store_date);
            return WEEKDAY_NAMES[idx] === weekday;
        });
        const rosterTaggedDays = weekdayRows.filter((r) => parseStaffRoster(r.staff_roster).length).length;
        const suggestions = rankRosterGroups(
            accumulateRosterGroups(weekdayRows),
            { limit: limitPerDay, minSamples, withRank: true },
        );
        return {
            weekday,
            sample_order_days: weekdayRows.length,
            roster_tagged_days: rosterTaggedDays,
            suggestions,
            needs_more_data: suggestions.length === 0,
        };
    });

    const rosterTaggedTotal = rows.filter((r) => parseStaffRoster(r.staff_roster).length).length;

    return {
        window_days: windowDays,
        order_weekdays: [...orderWeekdays],
        roster_tagged_days: rosterTaggedTotal,
        total_order_days: rows.length,
        by_weekday: byWeekday,
        overall: rankRosterGroups(accumulateRosterGroups(rows), {
            limit: limitPerDay,
            minSamples,
            withRank: true,
        }),
    };
}

module.exports = {
    parseStaffRoster,
    normalizeExceptionReason,
    buildExceptionReasonRollup,
    buildStaffCountCurve,
    buildRosterPerformanceRollup,
    buildRosterSuggestionsByWeekday,
    rosterKey,
    TGP_ORDER_WEEKDAYS,
};
