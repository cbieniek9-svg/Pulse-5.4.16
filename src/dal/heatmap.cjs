'use strict';

/**
 * Latest HomeBase audit row per zone, reduced to heat-map status for TV / mobile.
 * @param {object} db — same interface as main `db` (get/all)
 * @returns {Record<string, { last_audit: string, status: string }>}
 */
function loadHeatMap(db) {
    try {
        const rows = db.all(`
                SELECT zone_name, timestamp as last_audit, audit_data 
                FROM homebase_audits 
                WHERE id IN (SELECT MAX(id) FROM homebase_audits GROUP BY zone_name)
            `);
        return rows.reduce((acc, r) => {
            let status = 'neutral';
            try {
                const data = JSON.parse(r.audit_data || '{}');
                const passes = [data.front_edge_pass, data.tag_integrity_pass, data.hole_strategy_pass, data.clearances_pass];
                const failCount = passes.filter((p) => p === 0).length;
                if (passes.every((p) => p === 1)) status = 'pass';
                else if (failCount >= 2) status = 'critical';
                else if (failCount === 1) status = 'warning';
            } catch (_) { /* ignore malformed audit_data */ }
            return { ...acc, [r.zone_name]: { last_audit: r.last_audit, status } };
        }, {});
    } catch (e) {
        console.error('[HEATMAP] Refresh failed:', e.message);
        return {};
    }
}

module.exports = { loadHeatMap };
