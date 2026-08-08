'use strict';

const { upsertSetting } = require('../../lib/settings-store.cjs');
const { ensureTrainingStaff } = require('../../lib/training-staff.cjs');
const { normalizeStoreTimezone } = require('../../lib/store-timezone.cjs');
const { canBeActiveShiftLead } = require('../../lib/shift-lead.cjs');
const { logInfo } = require('../../lib/app-log.cjs');

/**
 * settings action handlers for POST /api/action.
 * @param {object} deps
 */
function createSettingsHandlers({ db, broadcastUpdate, getStoreDateStamp, actionHandlers, archiveCompletedOrderClock }) {
    return {
        settings_update(ctx) {
            if (ctx.id_val && ['Zone_Mapping', 'Zone_Ownership', 'Zone_Names', 'Zone_Section_Labels'].includes(ctx.id_val)) {
                try {
                    JSON.parse(ctx.workingData.setting_value);
                } catch {
                    const err = new Error(`Invalid JSON format for ${ctx.id_val}`);
                    err.status = 400;
                    throw err;
                }
            }
            if (ctx.id_val === 'Training_Mode_Enabled') {
                upsertSetting(db, ctx.id_val, ctx.workingData.setting_value);
                broadcastUpdate({ table: ctx.table, action: 'update', id_col: ctx.id_col, id_val: ctx.id_val, data: ctx.workingData });
                ensureTrainingStaff(db);
                return;
            }
            if (ctx.id_val === 'Store_Timezone') {
                const normalized = normalizeStoreTimezone(ctx.workingData.setting_value);
                ctx.workingData.setting_value = normalized.timezone;
            }
            if (ctx.id_val === 'Active_Manager') {
                const name = String(ctx.workingData.setting_value || '').trim();
                if (name && !canBeActiveShiftLead(db, name, getStoreDateStamp())) {
                    const err = new Error('That person cannot be set as shift lead.');
                    err.status = 400;
                    throw err;
                }
            }
            if (ctx.id_val === 'Order_Start' && ctx.workingData.setting_value) {
                // Always stamp the clock start with SERVER time. Trusting the client's
                // timestamp let a skewed device clock set a future start, which then made
                // the order clock impossible to stop (FINISH rejected as "end before start").
                const orderEnd = db.get("SELECT setting_value FROM settings WHERE setting_name='Order_End'")?.setting_value;
                if (orderEnd) {
                    const err = new Error('Order clock is stuck (FINISH already set). Clear the stuck clock before starting a new one.');
                    err.status = 409;
                    throw err;
                }
                const storeDate = typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : '';
                const finishedToday = storeDate
                    ? db.get(
                        "SELECT store_date FROM shift_order_history WHERE store_date = ? AND order_end IS NOT NULL AND order_end != '' LIMIT 1",
                        storeDate,
                    )
                    : null;
                if (finishedToday) {
                    const err = new Error('An order was already finished today. Clear history attachment or wait for the next store day before starting the clock again.');
                    err.status = 409;
                    throw err;
                }
                const existingStart = db.get("SELECT setting_value FROM settings WHERE setting_name='Order_Start'")?.setting_value;
                if (existingStart) {
                    logInfo('order-clock/start', 'Order_Start already set — left unchanged', {
                        actor: ctx.actorName,
                        storeDate,
                    }, db);
                    broadcastUpdate({
                        table: ctx.table,
                        action: 'update',
                        id_col: ctx.id_col,
                        id_val: ctx.id_val,
                        data: { setting_value: existingStart },
                    });
                    return;
                }
                ctx.workingData.setting_value = ctx.serverTime || new Date().toISOString();
                logInfo('order-clock/start', 'Order clock started via settings update', {
                    actor: ctx.actorName,
                    storeDate,
                    at: ctx.workingData.setting_value,
                }, db);
            }
            if (ctx.id_val === 'Frozen_Order_Start' && ctx.workingData.setting_value) {
                const frozenEnd = db.get("SELECT setting_value FROM settings WHERE setting_name='Frozen_Order_End'")?.setting_value;
                if (frozenEnd) {
                    const err = new Error('Frozen clock is stuck (FINISH already set). Clear stuck clocks before starting again.');
                    err.status = 409;
                    throw err;
                }
                const storeDate = typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : '';
                const finishedFrozen = storeDate
                    ? db.get(
                        "SELECT store_date FROM shift_order_history WHERE store_date = ? AND frozen_order_end IS NOT NULL AND frozen_order_end != '' LIMIT 1",
                        storeDate,
                    )
                    : null;
                if (finishedFrozen) {
                    const err = new Error('Frozen order was already finished today.');
                    err.status = 409;
                    throw err;
                }
                const existingFrozen = db.get("SELECT setting_value FROM settings WHERE setting_name='Frozen_Order_Start'")?.setting_value;
                if (existingFrozen) {
                    broadcastUpdate({
                        table: ctx.table,
                        action: 'update',
                        id_col: ctx.id_col,
                        id_val: ctx.id_val,
                        data: { setting_value: existingFrozen },
                    });
                    return;
                }
                ctx.workingData.setting_value = ctx.serverTime || new Date().toISOString();
                logInfo('order-clock/frozen-start', 'Frozen order clock started', {
                    actor: ctx.actorName,
                    storeDate,
                    at: ctx.workingData.setting_value,
                }, db);
            }
            if (ctx.id_val === 'Order_End' && ctx.workingData.setting_value) {
                const applyUpdate = () => {
                    upsertSetting(db, ctx.id_val, ctx.workingData.setting_value);
                    archiveCompletedOrderClock(ctx.workingData.setting_value, ctx.serverTime);
                };
                if (db.transaction) db.transaction(applyUpdate)();
                else applyUpdate();
                broadcastUpdate({ table: ctx.table, action: 'update', id_col: ctx.id_col, id_val: ctx.id_val, data: ctx.workingData });
                return;
            }
            upsertSetting(db, ctx.id_val, ctx.workingData.setting_value);
            broadcastUpdate({ table: ctx.table, action: 'update', id_col: ctx.id_col, id_val: ctx.id_val, data: ctx.workingData });
        },
    };
}

module.exports = { createSettingsHandlers };
