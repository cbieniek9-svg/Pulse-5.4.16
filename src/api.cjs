'use strict';

const crypto = require('crypto');
const { getDataRoot } = require('./paths.cjs');
const { APP_VERSION } = require('./app-version.cjs');
const { MANAGER_WRITABLE_SETTINGS, CLERK_WRITABLE_SETTINGS } = require('./constants/api-settings.cjs');
const { isManagerRole, isShiftLeadRole } = require('./lib/staff-permissions.cjs');
const { loadHeatMap } = require('./dal/heatmap.cjs');
const { createActionHandlers } = require('./actions/handlers.cjs');
const { registerCoreRoutes } = require('./routes/core.cjs');
const { registerSyncRoutes } = require('./routes/sync.cjs');
const { registerActionRoutes } = require('./routes/action.cjs');
const { registerReportsRoutes } = require('./routes/reports.cjs');
const { registerManagerRoutes } = require('./routes/manager.cjs');
const { registerBetacsRoutes } = require('./routes/betacs.cjs');
const { registerPresenceRoutes } = require('./routes/presence.cjs');
const { resolveOrderStoreDate, isOrderAlreadyArchived, upsertShiftOrderHistory } = require('./lib/order-history-archive.cjs');
const { archiveCommsForEod, isMessageCenterEnabled } = require('./lib/comms-center.cjs');
const { executeDailyRhythm: runDailyRhythm, ensureDailyRhythmOnBoot } = require('./lib/daily-rhythm.cjs');
const { buildDailyReportSnapshot, resolveOperationalRetentionDays, addDays } = require('./lib/history-trends.cjs');
const { sqliteTzOffsetModifier, DEFAULT_TZ } = require('./lib/store-time.cjs');
const { createBackupPackage: defaultCreateBackupPackage } = require('./lib/backup-package.cjs');
const { upsertSetting } = require('./lib/settings-store.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED FACTORY — receives injected dependencies from main.cjs
// ─────────────────────────────────────────────────────────────────────────────
module.exports = (server, db, auth, broadcastUpdate, getStoreDateStamp, getStoreDayName, getStoreClockPayload, getBootHealth = () => null, getNetworkInfo = () => null) => {

    const fail = (res, status, msg, code = null) =>
        res.status(status).json({
            error: msg,
            ...(code ? { code } : {}),
            timestamp: new Date().toISOString(),
        });

    const wrap = (fn) => async (req, res) => {
        try {
            await fn(req, res);
        } catch (err) {
            const session = auth.getSession(req.headers?.['x-session-token'] ?? req.body?.token);
            const { recordAppError } = require('./lib/app-log.cjs');
            recordAppError(`api/${req.method} ${req.url}`, err.message || 'Internal Server Error', err, {
                status: err.status || (String(err.message).includes('UNIQUE') ? 409 : 500),
                sessionUser: session?.name || '',
                sessionRole: session?.role || '',
            }, db);
            console.error(`[API] ${req.method} ${req.url}: ${err.message}`);
            if (!res.headersSent) {
                const status = err.status || (String(err.message).includes('UNIQUE') ? 409 : 500);
                fail(res, status, err.message || 'Internal Server Error', err.code);
            }
        }
    };

    /**
     * 401 is reserved for "you presented a token and it is no longer valid", which is the
     * signal clients use to re-prompt for login. A request with no token at all stays 403,
     * since there is no session to have expired.
     */
    const requireSession = (req, res, needManager = false) => {
        const token = req.headers?.['x-session-token'] ?? req.body?.token;
        const session = auth.getSession(token);
        if (!session) {
            if (token) fail(res, 401, 'Session expired. Please sign in again.');
            else fail(res, 403, needManager ? 'Manager session required.' : 'Unauthorized.');
            return null;
        }
        if (needManager && !isManagerRole(session.role)) {
            fail(res, 403, 'Manager session required.');
            return null;
        }
        return session;
    };

    const requireShiftLead = (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return null;
        if (!isManagerRole(session.role) && !isShiftLeadRole(session.role)) {
            fail(res, 403, 'Shift lead session required.');
            return null;
        }
        return session;
    };

    const isRhythmScheduleEditEnabled = () => {
        const row = db.get("SELECT setting_value FROM settings WHERE setting_name='Rhythm_Schedule_Edit_Enabled'");
        return row?.setting_value !== '0';
    };

    const checkSettingPermission = async (res, settingKey, token, userContext) => {
        if (MANAGER_WRITABLE_SETTINGS.has(settingKey)) {
            const access = auth.getCredentialAccessStatus(userContext?.name);
            if (access.known && !access.allowed) {
                fail(res, 403, 'Account access is revoked.', 'ACCOUNT_ACCESS_REVOKED');
                return false;
            }
            const session = auth.getSession(token ?? userContext?.token);
            const isManager = (session && isManagerRole(session.role)) || await auth.isAuthorizedManager(userContext);
            if (!isManager) { fail(res, 403, 'Manager role required for this setting.'); return false; }
        } else if (!CLERK_WRITABLE_SETTINGS.has(settingKey)) {
            fail(res, 403, 'Unknown or read-only setting.');
            return false;
        }
        return true;
    };

    let cachedHeatMap = loadHeatMap(db);
    const refreshHeatMap = () => { cachedHeatMap = loadHeatMap(db); };

    const actionHandlers = createActionHandlers({ db, broadcastUpdate, getStoreDateStamp });

    /**
     * EOD archives and deletes, so two overlapping runs can clear a live order clock
     * between another run's read and write. The scheduler, the boot catch-up loop and
     * the manual manager action can all fire it, so the guard is process-wide (matching
     * the daily rhythm's own re-entrancy guard).
     */
    let eodRunning = false;

    async function executeEODSweep(targetDate = new Date(), opts = {}) {
        if (eodRunning) {
            console.warn('[EOD] Sweep already running — ignoring overlapping request');
            return { skipped: true, reason: 'busy' };
        }
        eodRunning = true;
        try {
            return await runEODSweep(targetDate, opts);
        } finally {
            eodRunning = false;
        }
    }

    function readEodSetting(name) {
        return String(
            db.get("SELECT setting_value FROM settings WHERE setting_name=?", name)?.setting_value || '',
        ).trim();
    }

    function persistEodBackupError(payload) {
        try {
            upsertSetting(db, 'Eod_Last_Backup_Error', JSON.stringify(payload));
        } catch (_) { /* ignore */ }
    }

    function packageBelongsToStoreDate(packageId, storeDate) {
        const id = String(packageId || '');
        const day = String(storeDate || '');
        return Boolean(id && day && id.includes(day));
    }

    /**
     * Called only when Last_EOD_Sweep already equals today's store date.
     * A leftover yesterday post id must not look "complete".
     */
    function isEodBackupIncomplete(today) {
        const error = readEodSetting('Eod_Last_Backup_Error');
        const pre = readEodSetting('Eod_Last_Pre_Backup_Package');
        const post = readEodSetting('Eod_Last_Post_Backup_Package');
        if (error) return true;
        if (!post) return true;
        // Today's pre recorded but post still names a prior day (stale alias / crash).
        if (
            pre
            && packageBelongsToStoreDate(pre, today)
            && !packageBelongsToStoreDate(post, today)
        ) {
            return true;
        }
        return false;
    }

    async function invokeCreateBackupPackage(opts, args) {
        const createPkg = typeof opts.createBackupPackage === 'function'
            ? opts.createBackupPackage
            : defaultCreateBackupPackage;
        try {
            const result = await createPkg(args);
            if (result && typeof result.ok === 'boolean') return result;
            return {
                ok: false,
                packageId: null,
                error: 'createBackupPackage returned an invalid result',
                code: 'BACKUP_VERIFICATION_FAILED',
            };
        } catch (e) {
            return {
                ok: false,
                packageId: null,
                error: e?.message || String(e),
                code: e?.code || 'BACKUP_VERIFICATION_FAILED',
            };
        }
    }

    async function completePostEodBackup(today, opts = {}) {
        const resolveDataRoot = typeof opts.getDataRoot === 'function' ? opts.getDataRoot : getDataRoot;
        const actor = opts.actor || 'EOD';
        const prePackageId = readEodSetting('Eod_Last_Pre_Backup_Package') || null;

        console.log(`[EOD] Completing missing post-purge backup for ${today}`);
        const post = await invokeCreateBackupPackage(opts, {
            db,
            dataRoot: resolveDataRoot(),
            stage: 'post_eod',
            labelDate: today,
            actor,
        });
        if (!post.ok) {
            persistEodBackupError({
                at: new Date().toISOString(),
                storeDate: today,
                stage: 'post_eod',
                message: post.error || 'post-purge backup failed',
                code: post.code || 'BACKUP_VERIFICATION_FAILED',
                packageId: post.packageId || null,
                pre_backup_package: prePackageId,
                recovered_post_backup: true,
            });
            try {
                upsertSetting(db, 'Eod_Last_Post_Backup_Package', '');
            } catch (_) { /* ignore */ }
            const err = new Error(
                `EOD post-purge backup failed (${post.error || 'verification failed'}). Purge already committed; retry backup before relying on this store day.`,
            );
            err.status = 500;
            err.code = 'EOD_POST_BACKUP_REQUIRED';
            throw err;
        }

        try {
            upsertSetting(db, 'Eod_Last_Post_Backup_Package', post.packageId || '');
            upsertSetting(db, 'Eod_Last_Backup_Error', '');
            upsertSetting(db, 'Eod_Last_Backup_Ok_At', new Date().toISOString());
        } catch (_) { /* ignore */ }

        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (_) { /* non-fatal */ }
        console.log(`[EOD] Post-purge backup recovered for ${today}`);
        return {
            success: true,
            storeDate: today,
            skipped: false,
            recovered_post_backup: true,
            pre_backup_package: prePackageId,
            post_backup_package: post.packageId,
        };
    }

    async function runEODSweep(targetDate = new Date(), opts = {}) {
        const doVacuum = opts.vacuum === true;
        const skipOrderHistoryArchive = opts.skipOrderHistoryArchive === true;
        const force = opts.force === true;
        const t_now = targetDate.toISOString();
        const today = getStoreDateStamp(targetDate);
        const storeTz = getStoreClockPayload?.()?.storeTimezone || DEFAULT_TZ;
        const tzMod = sqliteTzOffsetModifier(storeTz, targetDate);
        const lastEodRow = db.get("SELECT setting_value FROM settings WHERE setting_name='Last_EOD_Sweep'");
        const lastEod = String(lastEodRow?.setting_value || '').trim();
        // Same store day again is a no-op unless a manager forces it — re-running would
        // clear a live Order_Start that was started after the first sweep.
        // Exception: post-purge backup may still be incomplete after a prior purge.
        if (!force && lastEod === today) {
            if (isEodBackupIncomplete(today)) {
                return completePostEodBackup(today, opts);
            }
            console.log(`[EOD] Already swept for ${today} — skipping`);
            return { skipped: true, reason: 'already_swept', storeDate: today };
        }
        const isNewStoreDay = !lastEod || lastEod < today;
        const settingsBeforeSweep = db.getSettings ? db.getSettings() : {};
        const retentionDays = resolveOperationalRetentionDays(settingsBeforeSweep);
        const cutoff = new Date(targetDate.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
        const snapshotDate = opts.snapshotDate || addDays(today, -1);
        const resolveDataRoot = typeof opts.getDataRoot === 'function' ? opts.getDataRoot : getDataRoot;
        const actor = opts.actor || 'EOD';
        let pre = null;

        try {
            try {
                buildDailyReportSnapshot(db, {
                    storeDate: snapshotDate,
                    createdAt: t_now,
                    persist: true,
                });
                try {
                    db.run(
                        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Snapshot_Error','')",
                    );
                } catch (_) { /* ignore */ }
            } catch (snapshotErr) {
                console.error(`[EOD] Daily report snapshot failed for ${snapshotDate}:`, snapshotErr.message);
                const alertPayload = JSON.stringify({
                    at: t_now,
                    storeDate: snapshotDate,
                    message: snapshotErr.message || 'snapshot failed',
                });
                try {
                    db.run(
                        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Snapshot_Error',?)",
                        alertPayload,
                    );
                } catch (_) { /* ignore */ }
                try {
                    const { recordAppError } = require('./lib/app-log.cjs');
                    recordAppError('eod/snapshot', 'Daily report snapshot failed — archive aborted', snapshotErr, {
                        snapshotDate,
                        today,
                    }, db);
                } catch (_) { /* ignore */ }
                // First-boot recovery may skip order history; still allow that path.
                // Normal EOD must not destroy live data without a durable yesterday snapshot.
                if (!skipOrderHistoryArchive) {
                    const err = new Error(
                        `EOD aborted: daily report snapshot failed for ${snapshotDate} (${snapshotErr.message}). Fix the error and retry EOD.`,
                    );
                    err.status = 500;
                    throw err;
                }
            }

            pre = await invokeCreateBackupPackage(opts, {
                db,
                dataRoot: resolveDataRoot(),
                stage: 'pre_eod',
                labelDate: today,
                actor,
            });
            if (!pre.ok) {
                persistEodBackupError({
                    at: t_now,
                    storeDate: today,
                    stage: 'pre_eod',
                    message: pre.error || 'pre-purge backup failed',
                    code: pre.code || 'BACKUP_VERIFICATION_FAILED',
                    packageId: pre.packageId || null,
                });
                const err = new Error(
                    `EOD aborted: pre-purge backup failed (${pre.error || 'verification failed'}). Fix the error and retry EOD.`,
                );
                err.status = 500;
                err.code = 'EOD_PRE_BACKUP_REQUIRED';
                throw err;
            }
            try {
                // New pre starts a new dual-backup pair — never leave yesterday's post id
                // looking like today's completed backup after purge/post failure.
                upsertSetting(db, 'Eod_Last_Pre_Backup_Package', pre.packageId || '');
                upsertSetting(db, 'Eod_Last_Post_Backup_Package', '');
                upsertSetting(db, 'Eod_Last_Backup_Ok_At', '');
            } catch (_) { /* ignore */ }

            db.transaction(() => {
                if (!skipOrderHistoryArchive) {
                    const osRow = db.get("SELECT setting_value FROM settings WHERE setting_name='Order_Start'");
                    const oeRow = db.get("SELECT setting_value FROM settings WHERE setting_name='Order_End'");
                    const os = (osRow && osRow.setting_value) ? String(osRow.setting_value) : '';
                    const oe = (oeRow && oeRow.setting_value) ? String(oeRow.setting_value) : '';
                    // Order clock is archived when FINISH is pressed. EOD only catches unfinished clocks.
                    // If start is set but end is empty, stamp end as EOD time so history is complete and
                    // "finished today" guards can see a real order_end.
                    if (os) {
                        const orderEnd = oe || t_now;
                        if (!oe) {
                            console.warn(`[EOD] Unfinished order clock archived with EOD end stamp for ${today}`);
                        }
                        const storeDate = resolveOrderStoreDate(os, orderEnd, getStoreDateStamp);
                        if (!isOrderAlreadyArchived(db, storeDate)) {
                            upsertShiftOrderHistory(db, {
                                orderStart: os,
                                orderEnd,
                                recordedAt: t_now,
                                storeDate,
                                settings: db.getSettings ? db.getSettings() : {},
                                counts: db.getCounts ? (db.getCounts() || {}) : {},
                            });
                        }
                    }
                } else if (db.get("SELECT setting_value FROM settings WHERE setting_name='Order_Start'")?.setting_value) {
                    // Intermediate catch-up days skip archive on purpose — also skip clearing
                    // the clock, or a multi-day gap wipes today's live Order_Start with no history.
                    console.warn(`[EOD] Leaving live order clock intact (skipOrderHistoryArchive) for ${today}`);
                }
                db.run("UPDATE tasks          SET status='Archived',closed_by='AUTO',time_closed=? WHERE status='Open'    AND date(time_submitted, ?) < date(?) AND priority NOT IN ('Urgent','High')", t_now, tzMod, today);
                db.run("UPDATE oos            SET status='Archived',closed_by='AUTO',time_closed=? WHERE status='Open'    AND date(time_logged, ?) < date(?)", t_now, tzMod, today);
                
                // Customer orders stay open until manually cleared (no auto-archive at EOD).
                // db.run("UPDATE special_orders SET status='Archived',closed_by='AUTO',time_closed=? WHERE status='Open'    AND time_logged<?", t_now, beforeToday);
                
                db.run("UPDATE expected_orders SET status='Archived',closed_by='AUTO',time_closed=? WHERE status='Pending' AND COALESCE(category,'general')!='hardware'", t_now);
                db.run("UPDATE shrink_log     SET status='Archived' WHERE status='Open'");
                
                // Removed 'special_orders' from the array list below
                ['tasks', 'oos', 'expected_orders', 'kill_dates'].forEach((t) =>
                    db.run(`UPDATE ${t} SET status='Archived' WHERE status='Closed'`)
                );
                
                db.run("DELETE FROM tasks          WHERE status='Archived' AND time_closed<?", cutoff);
                db.run("DELETE FROM oos            WHERE status='Archived' AND time_closed<?", cutoff);
                db.run("DELETE FROM special_orders WHERE status='Archived' AND time_closed<?", cutoff); // retention purge is configurable
                db.run("DELETE FROM expected_orders WHERE status='Archived' AND time_closed<?", cutoff);
                db.run("DELETE FROM kill_dates     WHERE status='Archived' AND time_closed<?", cutoff);
                db.run("DELETE FROM shrink_log     WHERE status='Archived' AND time_logged<?", cutoff);
                db.run("DELETE FROM homebase_audits WHERE timestamp<?", cutoff);
                const settingsNow = db.getSettings ? db.getSettings() : {};
                if (isMessageCenterEnabled(settingsNow)) {
                    archiveCommsForEod(db, today);
                } else {
                    db.run("DELETE FROM ticker");
                    db.run("UPDATE settings SET setting_value='' WHERE setting_name IN ('Shift_Notes')");
                    db.run("UPDATE settings SET setting_value='0' WHERE setting_name='Critical_Alert'");
                }
                db.run("DELETE FROM audit_ledger WHERE id NOT IN (SELECT id FROM audit_ledger ORDER BY timestamp DESC LIMIT 1000)");
                // Only clear the live order clock when this pass is allowed to archive it.
                // Catch-up intermediate days keep Order_Start so today's floor clock survives.
                if (!skipOrderHistoryArchive) {
                    db.run("UPDATE settings SET setting_value='' WHERE setting_name IN ('Order_Start','Order_End','Active_Manager')");
                    db.run("UPDATE settings SET setting_value='0' WHERE setting_name='Hardware_Arrived'");
                    try { db.run('UPDATE counts SET hardware=0 WHERE id=1'); } catch (_) { /* counts table optional in tests */ }
                    db.run("UPDATE settings SET setting_value='0' WHERE setting_name='Last_Actual_PPH'");
                }
                if (isNewStoreDay) {
                    db.run("UPDATE settings SET setting_value='' WHERE setting_name='Daily_Rhythm_Last_Loaded'");
                }
                // Must be an upsert: nothing seeds this row, so a plain UPDATE matched no
                // rows and left the stamp unset. catchUpMissedSweeps treats a missing stamp
                // as "never swept" and ran a full destructive sweep on every single boot —
                // clearing the live order clock and Active_Manager each restart.
                db.run(
                    "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Last_EOD_Sweep',?)",
                    today,
                );
            })();
        } catch (sweepErr) {
            console.error(`[EOD] Sweep transaction FAILED for ${today}:`, sweepErr);
            throw sweepErr;
        }

        if (doVacuum) {
            try { db.exec('VACUUM'); console.log(`[EOD] VACUUM complete for ${today}`); } catch (ve) { console.error('[EOD] VACUUM failed:', ve); }
        }

        // Purge already committed — surface board updates even if post-backup fails.
        try { broadcastUpdate(); } catch (_) { /* non-fatal */ }

        const post = await invokeCreateBackupPackage(opts, {
            db,
            dataRoot: resolveDataRoot(),
            stage: 'post_eod',
            labelDate: today,
            actor,
        });
        if (!post.ok) {
            persistEodBackupError({
                at: new Date().toISOString(),
                storeDate: today,
                stage: 'post_eod',
                message: post.error || 'post-purge backup failed',
                code: post.code || 'BACKUP_VERIFICATION_FAILED',
                packageId: post.packageId || null,
                pre_backup_package: pre.packageId || null,
            });
            try {
                upsertSetting(db, 'Eod_Last_Post_Backup_Package', '');
            } catch (_) { /* ignore */ }
            const err = new Error(
                `EOD post-purge backup failed (${post.error || 'verification failed'}). Purge already committed; retry backup before relying on this store day.`,
            );
            err.status = 500;
            err.code = 'EOD_POST_BACKUP_REQUIRED';
            throw err;
        }

        try {
            upsertSetting(db, 'Eod_Last_Post_Backup_Package', post.packageId || '');
            upsertSetting(db, 'Eod_Last_Backup_Error', '');
            upsertSetting(db, 'Eod_Last_Backup_Ok_At', new Date().toISOString());
        } catch (_) { /* ignore */ }

        try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* non-fatal */ }
        console.log(`[EOD] Sweep complete for ${today}`);
        return {
            success: true,
            storeDate: today,
            skipped: false,
            pre_backup_package: pre.packageId,
            post_backup_package: post.packageId,
        };
    }

    function executeDailyRhythm(opts = {}) {
        const getTimezone = () => getStoreClockPayload?.()?.storeTimezone || DEFAULT_TZ;
        return runDailyRhythm(db, { getStoreDateStamp, getStoreDayName, getTimezone, broadcastUpdate }, opts);
    }

    executeDailyRhythm.ensureOnBoot = () => {
        const getTimezone = () => getStoreClockPayload?.()?.storeTimezone || DEFAULT_TZ;
        return ensureDailyRhythmOnBoot(db, { getStoreDateStamp, getStoreDayName, getTimezone, broadcastUpdate }, executeDailyRhythm);
    };

    async function executeWeeklyBackup(opts = {}) {
        const stamp = getStoreDateStamp();
        const resolveDataRoot = typeof opts.getDataRoot === 'function' ? opts.getDataRoot : getDataRoot;
        const result = await invokeCreateBackupPackage(opts, {
            db,
            dataRoot: resolveDataRoot(),
            stage: 'weekly',
            labelDate: stamp,
            actor: opts.actor || 'WEEKLY',
        });
        if (!result.ok) {
            const err = new Error(
                `Weekly backup failed (${result.error || 'verification failed'}).`,
            );
            err.status = 500;
            err.code = result.code || 'BACKUP_VERIFICATION_FAILED';
            throw err;
        }
        console.log(`[WEEKLY-BK] Package saved: ${result.packageId || stamp}`);
        try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch (_) { /* non-fatal */ }
        return { success: true, storeDate: stamp, packageId: result.packageId };
    }

    if (!db.get("SELECT 1 FROM settings WHERE setting_name='TV_ACCESS_KEY'")) {
        db.run("INSERT INTO settings (setting_name,setting_value) VALUES ('TV_ACCESS_KEY',?)",
            crypto.randomBytes(8).toString('hex').toUpperCase());
    }

    const routeCtx = {
        wrap, fail, requireSession, requireShiftLead, isRhythmScheduleEditEnabled,
        checkSettingPermission, db, auth, broadcastUpdate,
        getStoreDateStamp, getStoreDayName, getStoreClockPayload, getBootHealth, getNetworkInfo, APP_VERSION, actionHandlers,
    };

    registerCoreRoutes(server, routeCtx);
    registerSyncRoutes(server, { ...routeCtx, getHeatMap: () => cachedHeatMap, executeDailyRhythm });
    registerActionRoutes(server, routeCtx);
    registerReportsRoutes(server, { ...routeCtx, getHeatMap: () => cachedHeatMap });
    registerBetacsRoutes(server, routeCtx);
    registerPresenceRoutes(server, routeCtx);
    registerManagerRoutes(server, {
        ...routeCtx,
        executeEODSweep,
        executeDailyRhythm,
        refreshHeatMap,
    });

    server.use((err, _req, res, _next) => {
        console.error('[EXPRESS]', err.message);
        if (!res.headersSent)
            res.status(err.status || 500).json({ error: err.message || 'Internal Server Error', timestamp: new Date().toISOString() });
    });

    return { executeEODSweep, executeDailyRhythm, executeWeeklyBackup };
};