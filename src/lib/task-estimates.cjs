'use strict';

const { HUMAN_CLOSED_TASK_FILTER, isAutoClosedTask } = require('./rhythm-task-expand.cjs');
const { baselineEstMinutes } = require('./task-estimate-baselines.cjs');

const DEFAULT_EST_MINS = 15;
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 25;
const LOOKBACK_DAYS = 90;
const MIN_ACTUAL_MINS = 1;
const MAX_ACTUAL_MINS = 480;
const MIN_EST_MINS = 5;
const MAX_EST_MINS = 240;

/** Group variable pull lines; otherwise match exact task_detail. */
function taskDetailKey(detail) {
    const d = String(detail || '').trim();
    if (!d) return '';
    if (d.startsWith('PULL:')) return 'PULL:*';
    if (d.startsWith('FIFO Audit')) return 'FIFO Audit';
    return d;
}

/**
 * Real work duration for a task — measured from when work actually STARTED
 * (start_time) to time_closed.
 *
 * We deliberately do NOT fall back to time_submitted: rhythm tasks are created
 * at load (e.g. 06:00) but may not be worked until hours later, so
 * time_closed - time_submitted massively overstates the real effort and would
 * poison the learned estimates. A task with no genuine start signal yields no
 * sample.
 */
function computeActualMinutes({ start_time, time_closed }) {
    if (!start_time || !time_closed) return null;
    const startMs = Date.parse(start_time);
    const endMs = Date.parse(time_closed);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
    const mins = Math.round((endMs - startMs) / 60000);
    if (mins < MIN_ACTUAL_MINS || mins > MAX_ACTUAL_MINS) return null;
    return mins;
}

/** Round to nearest 5 minutes within sane bounds. */
function roundEstMinutes(avg) {
    const n = Number(avg);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_EST_MINS;
    const rounded = Math.round(n / 5) * 5;
    return Math.max(MIN_EST_MINS, Math.min(MAX_EST_MINS, Math.max(5, rounded)));
}

function queryCompletionStats(db, detailKey, rawDetail) {
    const lookback = `-${LOOKBACK_DAYS} days`;
    const humanFilter = HUMAN_CLOSED_TASK_FILTER;
    if (detailKey === 'PULL:*') {
        return db.get(
            `SELECT ROUND(AVG(actual_mins), 2) AS avg_mins, COUNT(*) AS sample_count
             FROM (
                 SELECT ROUND((julianday(time_closed) - julianday(start_time)) * 24 * 60, 1) AS actual_mins
                 FROM tasks
                 WHERE (status='Closed' OR status='Archived')
                   AND ${humanFilter}
                   AND task_detail LIKE 'PULL:%'
                   AND time_closed IS NOT NULL
                   AND start_time IS NOT NULL AND start_time != ''
                   AND datetime(time_closed) >= datetime('now', ?)
                 ORDER BY datetime(time_closed) DESC
                 LIMIT ?
             ) recent
             WHERE actual_mins >= ? AND actual_mins <= ?`,
            lookback,
            MAX_SAMPLES,
            MIN_ACTUAL_MINS,
            MAX_ACTUAL_MINS,
        ) || { avg_mins: 0, sample_count: 0 };
    }

    if (detailKey === 'FIFO Audit') {
        return db.get(
            `SELECT ROUND(AVG(actual_mins), 2) AS avg_mins, COUNT(*) AS sample_count
             FROM (
                 SELECT ROUND((julianday(time_closed) - julianday(start_time)) * 24 * 60, 1) AS actual_mins
                 FROM tasks
                 WHERE (status='Closed' OR status='Archived')
                   AND ${humanFilter}
                   AND task_detail LIKE 'FIFO Audit%'
                   AND time_closed IS NOT NULL
                   AND start_time IS NOT NULL AND start_time != ''
                   AND datetime(time_closed) >= datetime('now', ?)
                 ORDER BY datetime(time_closed) DESC
                 LIMIT ?
             ) recent
             WHERE actual_mins >= ? AND actual_mins <= ?`,
            lookback,
            MAX_SAMPLES,
            MIN_ACTUAL_MINS,
            MAX_ACTUAL_MINS,
        ) || { avg_mins: 0, sample_count: 0 };
    }

    const detail = String(rawDetail || detailKey || '').trim();
    if (!detail) return { avg_mins: 0, sample_count: 0 };

    return db.get(
        `SELECT ROUND(AVG(actual_mins), 2) AS avg_mins, COUNT(*) AS sample_count
         FROM (
             SELECT ROUND((julianday(time_closed) - julianday(start_time)) * 24 * 60, 1) AS actual_mins
             FROM tasks
             WHERE (status='Closed' OR status='Archived')
               AND ${humanFilter}
               AND task_detail = ?
               AND time_closed IS NOT NULL
               AND start_time IS NOT NULL AND start_time != ''
               AND datetime(time_closed) >= datetime('now', ?)
             ORDER BY datetime(time_closed) DESC
             LIMIT ?
         ) recent
         WHERE actual_mins >= ? AND actual_mins <= ?`,
        detail,
        lookback,
        MAX_SAMPLES,
        MIN_ACTUAL_MINS,
        MAX_ACTUAL_MINS,
    ) || { avg_mins: 0, sample_count: 0 };
}

/**
 * Suggested est_mins for a new task — learned average when enough samples exist.
 */
function suggestEstMinutes(db, { detail, fallback = DEFAULT_EST_MINS } = {}) {
    const settings = db.getSettings ? db.getSettings() : {};
    const { isTaskWorkTimingEnabled } = require('./task-work-timing.cjs');
    if (!isTaskWorkTimingEnabled(settings)) return fallback;

    const key = taskDetailKey(detail);
    if (!key) return fallback;

    const stats = queryCompletionStats(db, key, detail);
    if (Number(stats.sample_count) >= MIN_SAMPLES) {
        return roundEstMinutes(stats.avg_mins);
    }

    if (key !== 'PULL:*') {
        const row = db.get('SELECT est_mins FROM rhythm_tasks WHERE detail = ? LIMIT 1', String(detail).trim());
        if (row?.est_mins > 0) return Number(row.est_mins);
    }

    const baseline = baselineEstMinutes(detail);
    if (baseline > 0) return baseline;

    return fallback;
}

/**
 * After a task closes, refresh rhythm_templates est_mins from recent completion history.
 * @returns {{ est_mins: number, sample_count: number } | null}
 */
function refreshLearnedEstimate(db, task) {
    const settings = db.getSettings ? db.getSettings() : {};
    const { isTaskWorkTimingEnabled } = require('./task-work-timing.cjs');
    if (!isTaskWorkTimingEnabled(settings)) return null;

    if (!task || isAutoClosedTask(task)) return null;
    const key = taskDetailKey(task.task_detail);
    if (!key || key === 'PULL:*') return null;

    const actual = computeActualMinutes(task);
    if (actual == null) return null;

    const stats = queryCompletionStats(db, key, task.task_detail);
    if (Number(stats.sample_count) < MIN_SAMPLES) return null;

    const newEst = roundEstMinutes(stats.avg_mins);
    db.run('UPDATE rhythm_tasks SET est_mins = ? WHERE detail = ?', newEst, String(task.task_detail).trim());
    return { est_mins: newEst, sample_count: Number(stats.sample_count) };
}

module.exports = {
    DEFAULT_EST_MINS,
    MIN_SAMPLES,
    MIN_EST_MINS,
    taskDetailKey,
    computeActualMinutes,
    roundEstMinutes,
    suggestEstMinutes,
    refreshLearnedEstimate,
    queryCompletionStats,
};
