'use strict';

const cron = require('node-cron');
const { DEFAULT_TZ } = require('./store-timezone.cjs');
const { ensureKillDatePullTasks, broadcastPullTaskEvents } = require('./kill-date-pull.cjs');

function resolveTimezone(getTimezone) {
    try {
        const tz = (typeof getTimezone === 'function' ? getTimezone() : '') || DEFAULT_TZ;
        new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
        return tz;
    } catch {
        return DEFAULT_TZ;
    }
}

/**
 * Cron jobs aligned to Store_Timezone (not PC local clock).
 * @param {object} opts
 * @param {function} opts.getTimezone
 * @param {function} [opts.log]
 * @param {function} [opts.onEod]
 * @param {function} [opts.onRhythm]
 * @param {function} [opts.onWeeklyBackup]
 * @param {object} [opts.db]
 * @param {function} [opts.broadcastUpdate]
 * @param {function} [opts.getStoreDateStamp]
 */
function createStoreSchedulers(opts) {
    const {
        getTimezone, log, onEod, onRhythm, onWeeklyBackup, db, broadcastUpdate, getStoreDateStamp,
    } = opts;
    let jobs = [];

    function stop() {
        jobs.forEach((j) => j.stop());
        jobs = [];
    }

    function schedule(cronExpr, fn, label) {
        const tz = resolveTimezone(getTimezone);
        try {
            jobs.push(cron.schedule(cronExpr, fn, { timezone: tz }));
            log?.(`[SCHED] ${label}: ${cronExpr} (${tz})`);
        } catch (err) {
            log?.(`[SCHED] ${label} invalid TZ ${tz}: ${err.message}; using ${DEFAULT_TZ}`);
            jobs.push(cron.schedule(cronExpr, fn, { timezone: DEFAULT_TZ }));
        }
    }

    function runMidnightRollover() {
        log?.('[SCHED] Store midnight — refresh expiry/pull windows…');
        if (!db || typeof broadcastUpdate !== 'function' || typeof getStoreDateStamp !== 'function') return;
        try {
            const today = getStoreDateStamp();
            const pullEvents = ensureKillDatePullTasks(db, today);
            broadcastPullTaskEvents(db, pullEvents, broadcastUpdate);
            broadcastUpdate();
        } catch (err) {
            log?.(`[SCHED] Midnight rollover failed: ${err && err.message}`);
        }
    }

    function start() {
        stop();

        schedule('0 0 * * *', runMidnightRollover, 'midnight rollover');

        schedule('1 0 * * *', () => {
            log?.('Triggering scheduled EOD Sweep (00:01 store time)…');
            if (onEod) {
                void Promise.resolve(onEod()).catch((err) => {
                    log?.(`[EOD] Scheduled sweep failed: ${err && err.message}`);
                });
            }
        }, 'EOD sweep');

        schedule('0 6 * * *', () => {
            log?.('Triggering scheduled Daily Rhythm (06:00 store time)…');
            onRhythm?.({ reason: 'scheduled' });
        }, 'daily rhythm');

        // Catch sleep/hibernate misses of the exact 06:00 tick while the process stays up.
        schedule('*/15 6-10 * * *', () => {
            log?.('Rhythm watchdog tick (06:00–10:45 store time)…');
            onRhythm?.({ reason: 'watchdog' });
        }, 'daily rhythm watchdog');

        schedule('0 19 * * 0', () => {
            log?.('Scheduled weekly database backup (Sunday 7pm store time)…');
            if (onWeeklyBackup) {
                void Promise.resolve(onWeeklyBackup()).catch((err) => {
                    log?.(`[WEEKLY-BK] Backup failed: ${err && err.message}`);
                });
            }
        }, 'weekly backup');
    }

    return { start, stop, runMidnightRollover };
}

module.exports = { createStoreSchedulers, resolveTimezone };
