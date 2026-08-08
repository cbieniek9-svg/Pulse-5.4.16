'use strict';

const {
    DEFAULT_SCHEDULE_ROLE_RULES,
    ensureSupervisorRule,
} = require('../lib/schedule-role-buckets.cjs');

/**
 * Supervisor schedule bucket + optional assign_bucket on rhythm_tasks.
 */
module.exports = {
    name: 'supervisor_assign_bucket',
    up(db) {
        try {
            db.exec("ALTER TABLE rhythm_tasks ADD COLUMN assign_bucket TEXT NOT NULL DEFAULT ''");
        } catch (_) { /* column exists */ }

        let raw = '';
        try {
            raw = db.get(
                "SELECT setting_value FROM settings WHERE setting_name = 'Schedule_Role_Buckets'",
            )?.setting_value || '';
        } catch (_) {
            raw = '';
        }

        let rules;
        try {
            rules = JSON.parse(raw || '[]');
        } catch (_) {
            rules = null;
        }
        if (!Array.isArray(rules) || !rules.length) {
            rules = DEFAULT_SCHEDULE_ROLE_RULES;
        }
        const next = ensureSupervisorRule(rules);
        db.run(
            "INSERT INTO settings (setting_name, setting_value) VALUES ('Schedule_Role_Buckets', ?) "
            + "ON CONFLICT(setting_name) DO UPDATE SET setting_value = excluded.setting_value",
            JSON.stringify(next),
        );
    },
};
