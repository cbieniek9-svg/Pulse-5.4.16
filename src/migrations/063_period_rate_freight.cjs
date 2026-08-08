'use strict';

const { ensurePeriodFreightRatesSchema } = require('../lib/receiving-period-freight-rates.cjs');

/**
 * Period-rate freight as authoritative landed-cost method.
 * Does NOT invent rate values. Does NOT wipe invoice freight_* estimate columns.
 * Historical periods keep their existing costing_method (invoice_freight / legacy).
 */
module.exports = {
    name: 'period_rate_freight',
    up(db) {
        ensurePeriodFreightRatesSchema(db);

        // Optional note only — do not mass-update historical methods to period_rate without a rate.
        try {
            db.exec(`
                INSERT OR IGNORE INTO settings (setting_name, setting_value)
                VALUES (
                    'Receiving_Costing_Method_Notes',
                    'Authoritative method is period_rate (eligible net merchandise × period freight rate%). Invoice freight_* columns are reference-only. Historical invoice_freight / legacy_fixed_allocation periods are left unchanged.'
                )
            `);
        } catch (_) { /* settings optional */ }
    },
};
