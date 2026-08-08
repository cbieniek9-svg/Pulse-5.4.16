'use strict';

const { assembleSyncPayload } = require('../dal/sync-payload.cjs');
const { ensureKillDatePullTasks, broadcastPullTaskEvents } = require('../lib/kill-date-pull.cjs');
const { recordAppError } = require('../lib/app-log.cjs');

/**
 * @param {import('express').Application} server
 * @param {object} ctx
 * @param {function} ctx.wrap
 * @param {object} ctx.db
 * @param {object} ctx.auth
 * @param {string} ctx.APP_VERSION
 * @param {function} ctx.getStoreDateStamp
 * @param {function} ctx.getHeatMap
 * @param {function} [ctx.broadcastUpdate]
 */
function registerSyncRoutes(server, ctx) {
    const {
        wrap, db, auth, APP_VERSION, getStoreDateStamp, getStoreClockPayload, getHeatMap, broadcastUpdate,
        executeDailyRhythm,
    } = ctx;

    server.get('/api/sync', wrap(async (req, res) => {
        const today = getStoreDateStamp();
        const pullEvents = ensureKillDatePullTasks(db, today);
        broadcastPullTaskEvents(db, pullEvents, broadcastUpdate);

        // Morning heal: first authenticated sync after 06:00 recovers a missed cron tick.
        const session = auth.getSession(req.header('x-session-token'));
        if (session && typeof executeDailyRhythm === 'function') {
            try {
                const { maybeEnsureMorningRhythm } = require('../lib/daily-rhythm.cjs');
                const clock = typeof getStoreClockPayload === 'function' ? getStoreClockPayload() : {};
                const heal = maybeEnsureMorningRhythm(
                    db,
                    {
                        getStoreDateStamp,
                        getStoreDayName: () => clock.storeWeekday,
                        getTimezone: () => clock.storeTimezone,
                        getStoreClockPayload,
                        storeTime: clock.storeTime,
                        broadcastUpdate,
                    },
                    executeDailyRhythm,
                    { reason: 'sync-heal' },
                );
                if (heal?.healed || heal?.success) {
                    if (typeof broadcastUpdate === 'function') broadcastUpdate({ table: 'tasks', action: 'rhythm_heal' });
                }
            } catch (err) {
                recordAppError('sync/morning-rhythm', err?.message || 'Morning rhythm heal failed', err, {
                    storeDate: today,
                    sessionUser: session?.name || '',
                }, db);
            }
        }

        try {
            const payload = assembleSyncPayload({
                db,
                auth,
                req,
                APP_VERSION,
                getStoreDateStamp,
                getStoreClockPayload,
                cachedHeatMap: getHeatMap(),
            });
            res.json(payload);
        } catch (err) {
            const sess = auth.getSession(req.header('x-session-token'));
            recordAppError('sync/assemble', err?.message || 'Sync payload failed', err, {
                storeDate: today,
                sessionUser: sess?.name || '',
                sessionRole: sess?.role || '',
                appVersion: APP_VERSION,
            }, db);
            throw err;
        }
    }));
}

module.exports = { registerSyncRoutes };
