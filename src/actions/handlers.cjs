'use strict';

const { executeOrderFinish } = require('../lib/order-finish.cjs');
const { resolveOrderStaffCount, parseHardwareArrived } = require('../lib/shift-metrics.cjs');
const { createGenericHandlers } = require('./handlers/generic.cjs');
const { createTasksHandlers } = require('./handlers/tasks.cjs');
const { createExpectedOrdersHandlers } = require('./handlers/expected-orders.cjs');
const { createKillDatesHandlers } = require('./handlers/kill-dates.cjs');
const { createStaffHandlers } = require('./handlers/staff.cjs');
const { createSettingsHandlers } = require('./handlers/settings.cjs');
const { createSpecialOrdersHandlers } = require('./handlers/special-orders.cjs');

/**
 * Table/action handlers for `POST /api/action`.
 * Facade only — implementations live under ./handlers/*.
 * @param {object} p
 * @param {object} p.db
 * @param {function} p.broadcastUpdate
 * @param {function} [p.getStoreDateStamp]
 */
function createActionHandlers({
    db,
    broadcastUpdate: broadcastNow,
    getStoreDateStamp = (date = new Date()) => date.toISOString().slice(0, 10),
}) {
    let deferredBroadcasts = null;
    const broadcastUpdate = (...args) => {
        if (deferredBroadcasts) {
            deferredBroadcasts.push(args);
            return undefined;
        }
        return broadcastNow(...args);
    };
    const archiveCompletedOrderClock = (orderEnd, recordedAt) => {
        const settings = db.getSettings ? db.getSettings() : {};
        const counts = db.getCounts ? (db.getCounts() || {}) : {};
        executeOrderFinish(db, {
            staffCount: resolveOrderStaffCount(counts, db),
            hardwareArrived: parseHardwareArrived(settings.Hardware_Arrived),
            orderEnd,
            serverTime: recordedAt,
            getStoreDateStamp,
        });
    };

    const actionHandlers = {};
    const deps = { db, broadcastUpdate, getStoreDateStamp, actionHandlers, archiveCompletedOrderClock };

    Object.assign(
        actionHandlers,
        createGenericHandlers(deps),
        createTasksHandlers(deps),
        createExpectedOrdersHandlers(deps),
        createKillDatesHandlers(deps),
        createStaffHandlers(deps),
        createSettingsHandlers(deps),
        createSpecialOrdersHandlers(deps),
    );
    Object.defineProperties(actionHandlers, {
        beginDeferredBroadcasts: {
            value() {
                if (deferredBroadcasts) throw new Error('Action broadcast deferral is already active.');
                deferredBroadcasts = [];
            },
        },
        flushDeferredBroadcasts: {
            value() {
                const pending = deferredBroadcasts || [];
                deferredBroadcasts = null;
                for (const args of pending) {
                    try {
                        broadcastNow(...args);
                    } catch (error) {
                        console.error(`[ACTION] Post-commit broadcast failed: ${error.message}`);
                    }
                }
            },
        },
        discardDeferredBroadcasts: {
            value() {
                deferredBroadcasts = null;
            },
        },
    });

    return actionHandlers;
}

module.exports = { createActionHandlers };
