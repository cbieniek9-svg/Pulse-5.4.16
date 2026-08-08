'use strict';

const fs = require('fs');
const path = require('path');

let cached = null;

function taskDetailKey(detail) {
    const d = String(detail || '').trim();
    if (!d) return '';
    if (d.startsWith('PULL:')) return 'PULL:*';
    if (d.startsWith('FIFO Audit')) return 'FIFO Audit';
    return d;
}

function templatePath() {
    return path.join(__dirname, '..', '..', 'store-templates', 'default', 'task-estimate-baselines.json');
}

function loadTaskEstimateBaselines() {
    if (cached) return cached;
    try {
        cached = JSON.parse(fs.readFileSync(templatePath(), 'utf8'));
    } catch (_) {
        cached = { baselines: [], rhythm_est_mins: {}, quick_miss_checks: [] };
    }
    return cached;
}

function resetTaskEstimateBaselinesCache() {
    cached = null;
}

function normalizeDetail(s) {
    return String(s || '').trim().toLowerCase();
}

/**
 * Baseline est_mins from archived Excel Task_Library (before rhythm_tasks row lookup).
 */
function baselineEstMinutes(detail) {
    const data = loadTaskEstimateBaselines();
    const key = taskDetailKey(detail);
    const raw = normalizeDetail(detail);

    if (data.rhythm_est_mins && data.rhythm_est_mins[key]) {
        return Number(data.rhythm_est_mins[key]);
    }

    for (const row of data.baselines || []) {
        const name = normalizeDetail(row.detail);
        if (!name) continue;
        if (name === raw || raw.includes(name) || name.includes(raw)) {
            return Number(row.est_mins) || null;
        }
    }

    for (const [rhythmDetail, mins] of Object.entries(data.rhythm_est_mins || {})) {
        if (normalizeDetail(rhythmDetail) === normalizeDetail(key)) return Number(mins);
    }

    return null;
}

function listQuickMissChecks() {
    return (loadTaskEstimateBaselines().quick_miss_checks || []).filter((r) => r.check);
}

module.exports = {
    loadTaskEstimateBaselines,
    resetTaskEstimateBaselinesCache,
    baselineEstMinutes,
    listQuickMissChecks,
};
