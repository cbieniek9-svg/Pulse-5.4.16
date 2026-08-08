'use strict';

const { buildOrderDayBriefing } = require('./order-day-briefing.cjs');
const { suggestEstMinutes } = require('./task-estimates.cjs');
const { vendorScheduleWeekday } = require('./store-time.cjs');

const PIECE_BANDS = [
    { key: 'light', max: 400, label: 'Light order day' },
    { key: 'medium', max: 650, label: 'Typical order day' },
    { key: 'heavy', max: Infinity, label: 'Heavy order day' },
];

function resolvePieceBand(avgPieces) {
    const n = Number(avgPieces);
    if (!Number.isFinite(n) || n <= 0) return { key: 'unknown', label: 'Unknown order size' };
    return PIECE_BANDS.find((b) => n <= b.max) || PIECE_BANDS[PIECE_BANDS.length - 1];
}

/**
 * Suggest rhythm load adjustments based on expected order size.
 * Never auto-deletes work — hints only.
 */
function buildRhythmLoadAdvisor(db, { storeDate, storeWeekday } = {}) {
    const briefing = buildOrderDayBriefing(db, { storeDate, storeWeekday });
    const avgPieces = briefing.expected_pieces?.avg;
    const band = resolvePieceBand(avgPieces);

    const scheduleWeekday = vendorScheduleWeekday(storeWeekday || briefing.weekday, storeDate);
    const dayTasks = db.all(
        "SELECT * FROM rhythm_tasks WHERE day=? OR day='Everyday'",
        scheduleWeekday || '',
    );

    const deferCandidates = dayTasks
        .filter((t) => t.priority === 'Routine' && t.zone === 'General')
        .filter((t) => !/FIFO Audit|Daily direction huddle|TGP Order/i.test(String(t.detail)))
        .map((t) => ({
            id: t.id,
            detail: t.detail,
            est_mins: (() => {
                try {
                    return suggestEstMinutes(db, { detail: t.detail, fallback: t.est_mins || 15 });
                } catch (_) {
                    return Number(t.est_mins || 15) || 15;
                }
            })(),
        }));

    let message = 'Load full rhythm schedule.';
    let deferSuggested = false;
    if (band.key === 'heavy') {
        message = 'Heavy order expected — keep critical zone tasks; consider deferring non-critical General routines after FINISH.';
        deferSuggested = deferCandidates.length > 0;
    } else if (band.key === 'light') {
        message = 'Light order expected — good day to catch up on General routines and zone audits.';
    }

    return {
        store_date: briefing.store_date,
        weekday: briefing.weekday,
        piece_band: band,
        expected_pieces_avg: avgPieces,
        message,
        defer_non_critical_suggested: deferSuggested,
        defer_candidates: deferSuggested ? deferCandidates.slice(0, 6) : [],
        manual_confirm_required: true,
    };
}

module.exports = { buildRhythmLoadAdvisor, resolvePieceBand };
