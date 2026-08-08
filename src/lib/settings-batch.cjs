'use strict';

const { upsertSetting } = require('./settings-store.cjs');
const { CLERK_WRITABLE_SETTINGS, MANAGER_WRITABLE_SETTINGS } = require('../constants/api-settings.cjs');
const { normalizeStoreTimezone } = require('./store-timezone.cjs');
const { ensureTrainingStaff } = require('./training-staff.cjs');

/** Settings that need dedicated action handlers — not allowed in batch. */
const BATCH_BLOCKED = new Set(['Order_Start', 'Order_End', 'Active_Manager']);

const JSON_SETTINGS = new Set([
    'Zone_Mapping', 'Zone_Ownership', 'Zone_Names', 'Zone_Section_Labels',
    'FIFO_Aisle_Assignments', 'Schedule_Role_Buckets',
]);

/**
 * Apply many settings in one SQLite transaction.
 * @param {object} db
 * @param {Array<{ setting_name: string, setting_value: string }>} updates
 * @param {{ isManager?: boolean }} [opts]
 * @returns {{ applied: string[], count: number }}
 */
function applySettingsBatch(db, updates, opts = {}) {
    if (!Array.isArray(updates) || !updates.length) {
        const err = new Error('settings array is required.');
        err.status = 400;
        throw err;
    }
    if (updates.length > 40) {
        const err = new Error('Too many settings in one batch (max 40).');
        err.status = 400;
        throw err;
    }

    const isManager = opts.isManager === true;
    const normalized = [];
    for (const row of updates) {
        const name = String(row?.setting_name || row?.key || '').trim();
        if (!name) {
            const err = new Error('Each setting needs setting_name.');
            err.status = 400;
            throw err;
        }
        if (BATCH_BLOCKED.has(name)) {
            const err = new Error(`${name} cannot be updated via settings batch.`);
            err.status = 400;
            throw err;
        }
        const allowed = CLERK_WRITABLE_SETTINGS.has(name)
            || (isManager && MANAGER_WRITABLE_SETTINGS.has(name));
        if (!allowed) {
            const err = new Error(`Not allowed to update ${name}.`);
            err.status = 403;
            throw err;
        }
        let value = row?.setting_value ?? row?.value ?? '';
        if (value == null) value = '';
        value = String(value);
        if (name === 'Store_Timezone') {
            value = normalizeStoreTimezone(value).timezone;
        }
        if (JSON_SETTINGS.has(name)) {
            try {
                JSON.parse(value);
            } catch {
                const err = new Error(`Invalid JSON for ${name}`);
                err.status = 400;
                throw err;
            }
        }
        normalized.push({ name, value });
    }

    const apply = () => {
        normalized.forEach(({ name, value }) => upsertSetting(db, name, value));
        if (normalized.some((u) => u.name === 'Training_Mode_Enabled')) {
            ensureTrainingStaff(db);
        }
    };
    if (typeof db.transaction === 'function') db.transaction(apply)();
    else apply();

    return { applied: normalized.map((u) => u.name), count: normalized.length };
}

module.exports = { applySettingsBatch, BATCH_BLOCKED, JSON_SETTINGS };
