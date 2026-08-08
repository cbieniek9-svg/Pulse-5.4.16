'use strict';

const fs = require('fs');
const path = require('path');

let cached = null;

function templatePath() {
    return path.join(__dirname, '..', '..', 'store-templates', 'default', 'labor-minimum-baseline.json');
}

function loadLaborMinimumBaseline() {
    if (cached) return cached;
    try {
        cached = JSON.parse(fs.readFileSync(templatePath(), 'utf8'));
    } catch (_) {
        cached = {
            soft_overage_threshold_pct: 10,
            center_store_daily_equiv_hours: 0,
            by_weekday: {},
        };
    }
    return cached;
}

function resetLaborMinimumBaselineCache() {
    cached = null;
}

function minimumHoursForWeekday(weekdayName, settings = {}) {
    const data = loadLaborMinimumBaseline();
    const day = String(weekdayName || '').trim();
    const row = data.by_weekday?.[day];
    const fromFile = row?.minimum_hours ?? data.center_store_daily_equiv_hours ?? 0;
    const override = Number(settings.Labor_Minimum_Hours_Override || 0);
    return override > 0 ? override : fromFile;
}

function softOverageThresholdPct(settings = {}) {
    const setting = Number(settings.Labor_Soft_Overage_Threshold_Pct);
    if (Number.isFinite(setting) && setting > 0) return setting;
    return Number(loadLaborMinimumBaseline().soft_overage_threshold_pct || 10);
}

/**
 * Compare scheduled person-hours to archived minimum baseline (Excel Time_Budget / DailyMinimum).
 */
function buildMinimumHoursComparison(scheduledHours, weekdayName, settings = {}) {
    const minimum = minimumHoursForWeekday(weekdayName, settings);
    const threshold = softOverageThresholdPct(settings);
    if (!minimum || !Number.isFinite(scheduledHours) || scheduledHours <= 0) {
        return {
            minimum_hours: minimum || null,
            overage_hours: null,
            overage_pct: null,
            over_minimum: false,
            soft_threshold_pct: threshold,
            source: loadLaborMinimumBaseline().by_weekday?.[weekdayName]?.source || loadLaborMinimumBaseline().source,
        };
    }
    const overage = scheduledHours - minimum;
    const overagePct = (overage / minimum) * 100;
    return {
        minimum_hours: Math.round(minimum * 100) / 100,
        overage_hours: Math.round(overage * 100) / 100,
        overage_pct: Math.round(overagePct * 10) / 10,
        over_minimum: overagePct > threshold,
        soft_threshold_pct: threshold,
        source: loadLaborMinimumBaseline().by_weekday?.[weekdayName]?.source || loadLaborMinimumBaseline().source,
    };
}

module.exports = {
    loadLaborMinimumBaseline,
    resetLaborMinimumBaselineCache,
    minimumHoursForWeekday,
    softOverageThresholdPct,
    buildMinimumHoursComparison,
};
