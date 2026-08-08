'use strict';

const {
    ensureKillDatePullTasks, broadcastPullTaskEvents, closeKillDatePullTask,
} = require('../../lib/kill-date-pull.cjs');
const { learnFromEntry } = require('../../lib/item-catalog.cjs');

/**
 * kill-dates action handlers for POST /api/action.
 * @param {object} deps
 */
function createKillDatesHandlers({ db, broadcastUpdate, getStoreDateStamp, actionHandlers }) {
    return {
        kill_dates_insert(ctx) {
            actionHandlers.generic_insert(ctx);
            try {
                learnFromEntry(db, {
                    code: ctx.workingData?.item_code,
                    description: ctx.workingData?.item,
                    zone: ctx.workingData?.zone,
                    actor: ctx.actorName,
                    now: ctx.serverTime,
                });
            } catch (e) {
                // The catalog is a convenience — never block logging an expiry row.
                console.error('[ITEM-CATALOG] learn from kill_date failed:', e.message);
            }
            const today = getStoreDateStamp();
            const pullEvents = ensureKillDatePullTasks(db, today);
            broadcastPullTaskEvents(db, pullEvents, broadcastUpdate);
        },

        kill_dates_update(ctx) {
            actionHandlers.generic_update(ctx);
            const status = ctx.workingData?.status;
            if (status === 'Closed' || status === 'Archived' || status === 'Deleted') {
                closeKillDatePullTask(db, ctx.id_val, ctx.actorName, ctx.serverTime);
            } else if (status === 'Active') {
                const pullEvents = ensureKillDatePullTasks(db, getStoreDateStamp());
                broadcastPullTaskEvents(db, pullEvents, broadcastUpdate);
            }
        },
    };
}

module.exports = { createKillDatesHandlers };
