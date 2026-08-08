'use strict';

const {
    loadActionAcks,
    loadRhythmDeferrals,
    loadRhythmDeferLog,
    DEFER_LOG_SETTING,
} = require('./reports-action-store.cjs');

function backfillDeferLogFromMap(db, existingLog) {
    const map = loadRhythmDeferrals(db);
    const seen = new Set((existingLog || []).map((e) => `${e.store_date}:${(e.rhythm_ids || []).join(',')}`));
    const out = [...(existingLog || [])];
    Object.entries(map).forEach(([storeDate, ids]) => {
        if (!storeDate || !Array.isArray(ids) || !ids.length) return;
        const key = `${storeDate}:${ids.join(',')}`;
        if (seen.has(key)) return;
        let templates = [];
        try {
            templates = db.all(
                `SELECT detail FROM rhythm_tasks WHERE id IN (${ids.map(() => '?').join(',')})`,
                ...ids,
            ).map((r) => r.detail).filter(Boolean);
        } catch (_) { /* ignore */ }
        out.push({
            store_date: storeDate,
            deferred_at: '',
            deferred_by: '',
            rhythm_ids: ids.map(String),
            templates,
            closed_board_tasks: 0,
            backfilled: true,
        });
    });
    return out.sort((a, b) => String(b.store_date).localeCompare(String(a.store_date)));
}

function buildActionAckLog(db, { limit = 40 } = {}) {
    const acks = loadActionAcks(db) || [];
    return acks.slice(-limit).reverse().map((a) => ({
        action_id: a.action_id || '',
        report_date: a.report_date || '',
        acked_at: a.acked_at || '',
        acked_by: a.acked_by || '',
        kind: String(a.action_id || '').split(':')[0] || '',
    }));
}

function buildRhythmDeferLogForReports(db, { limit = 40 } = {}) {
    const raw = backfillDeferLogFromMap(db, loadRhythmDeferLog(db));
    return raw.slice(0, limit).map((e) => ({
        store_date: e.store_date,
        deferred_at: e.deferred_at || '',
        deferred_by: e.deferred_by || '',
        templates: e.templates || [],
        rhythm_ids: e.rhythm_ids || [],
        closed_board_tasks: Number(e.closed_board_tasks || 0),
        backfilled: !!e.backfilled,
    }));
}

module.exports = {
    DEFER_LOG_SETTING,
    loadRhythmDeferLog,
    buildActionAckLog,
    buildRhythmDeferLogForReports,
};
