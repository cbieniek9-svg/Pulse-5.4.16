'use strict';

/**
 * Normalize heat-map zone values from sync payload ({ last_audit, status }) or legacy ISO strings.
 * @param {string|{ last_audit?: string, status?: string }|null|undefined} entry
 * @returns {string} ISO timestamp or empty string
 */
function heatMapLastAuditIso(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object' && entry.last_audit) return String(entry.last_audit);
    return '';
}

/**
 * @param {string|{ last_audit?: string }|null|undefined} entry
 * @param {number} [nowMs]
 * @param {number} [thresholdMs]
 */
function isHeatMapZoneCold(entry, nowMs = Date.now(), thresholdMs = 4 * 60 * 60 * 1000) {
    const iso = heatMapLastAuditIso(entry);
    if (!iso) return true;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return true;
    return (nowMs - t) > thresholdMs;
}

module.exports = { heatMapLastAuditIso, isHeatMapZoneCold };
