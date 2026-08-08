'use strict';

const { ensurePeriodFreightAllocSchema } = require('../lib/receiving-period-freight-alloc.cjs');

/**
 * 5.4.16 — Workbook-equivalent period department freight allocation.
 *
 * Authoritative: Daily Freight Allocation Total (N3) × Period Department Allocation %.
 * Preserves 5.4.15 receiving_period_freight_rates (single-rate) for audit; marks it superseded.
 * Does NOT convert a single purchase rate (e.g. 1.5207%) into department percentages.
 * Does NOT rewrite locked historical periods without a recoverable profile.
 */
module.exports = {
    name: 'period_department_freight_alloc',
    up(db) {
        ensurePeriodFreightAllocSchema(db);

        try {
            db.exec(`
                INSERT OR REPLACE INTO settings (setting_name, setting_value)
                VALUES (
                    'Receiving_Costing_Method_Notes',
                    'Authoritative method is period_department_allocation (Daily Freight Allocation Total N3 × period department allocation %). Invoice freight_* is reference-only. Actual freight bills validate variance only. The 5.4.15 period_rate (purchases × single rate) is superseded and must not be confirmed for open periods. Historical locked periods are left unchanged until a confirmed allocation profile exists.'
                )
            `);
        } catch (_) { /* settings optional */ }

        try {
            db.exec(`
                INSERT OR IGNORE INTO settings (setting_name, setting_value)
                VALUES (
                    'Receiving_Period_Freight_Rates_Superseded',
                    'receiving_period_freight_rates (single store-wide rate_percent) was created under the mistaken 5.4.15 purchases×rate model. Preserved for audit. Not an authoritative department allocation profile. Do not convert rate_percent into a department percentage.'
                )
            `);
        } catch (_) { /* optional */ }

        // Open periods that were set to period_rate without a confirmed dept profile:
        // leave costing_method as-is for audit, but clear "confirmed" markers that would
        // incorrectly treat purchases×rate as authoritative going forward.
        try {
            const openPeriodRate = db.all(`
                SELECT period_start FROM receiving_report_period_status
                 WHERE LOWER(COALESCE(status,'')) IN ('','open')
                   AND LOWER(COALESCE(costing_method,'')) = 'period_rate'
                   AND costing_method_selected_at IS NOT NULL
            `) || [];
            const now = new Date().toISOString();
            openPeriodRate.forEach((row) => {
                db.run(
                    `UPDATE receiving_report_period_status
                        SET costing_method_reason = COALESCE(costing_method_reason,'') || ' [5.4.16: period_rate confirmation superseded — confirm period_department_allocation profile]',
                            freight_calc_source = 'superseded_period_rate',
                            updated_at = ?,
                            updated_by = 'migration_064'
                      WHERE period_start = ?`,
                    now,
                    row.period_start,
                );
            });
        } catch (_) { /* best-effort */ }
    },
};
