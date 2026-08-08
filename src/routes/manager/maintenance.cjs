'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { getDbPath, getBackupsDir, getDataRoot } = require('../../paths.cjs');
const { csvCell } = require('../../lib/csv-safe.cjs');
const { clearMarkdownArchive } = require('../../lib/clear-markdown-archive.cjs');
const { checkDatabaseHealth, recordBootHealth } = require('../../lib/db-health.cjs');
const { logManagerAudit } = require('../../lib/audit-log.cjs');
const { buildProductionReadinessReport } = require('../../lib/production-readiness.cjs');
const { buildReleaseManifest } = require('../../lib/release-manifest.cjs');
const { runBackupDrill } = require('../../../scripts/verify-backup.cjs');
const { buildHistoryExportZip } = require('../../lib/history-export.cjs');
const { createBackupPackage: defaultCreateBackupPackage } = require('../../lib/backup-package.cjs');
const { upsertSetting } = require('../../lib/settings-store.cjs');
const { isManagerRole, isShiftLeadRole } = require('../../lib/staff-permissions.cjs');

function canLoadDailyRhythm(session) {
    if (!session?.role) return false;
    return isManagerRole(session.role) || isShiftLeadRole(session.role);
}

function inspectDeviceSecurityState(db) {
    const row = db.get(`
        SELECT
            COUNT(*) AS authorized_devices,
            COALESCE(SUM(
                CASE WHEN device_token_hash IS NULL OR device_token_hash = '' THEN 1 ELSE 0 END
            ), 0) AS missing_token,
            COALESCE(SUM(
                CASE WHEN LOWER(TRIM(COALESCE(device_purpose, '')))
                    NOT IN ('tv', 'cs_desk', 'receiving', 'markdown') THEN 1 ELSE 0 END
            ), 0) AS missing_purpose,
            COALESCE(SUM(
                CASE WHEN device_token_hash IS NULL OR device_token_hash = ''
                    OR LOWER(TRIM(COALESCE(device_purpose, '')))
                        NOT IN ('tv', 'cs_desk', 'receiving', 'markdown')
                    THEN 1 ELSE 0 END
            ), 0) AS missing_token_or_purpose
        FROM trusted_devices
        WHERE status='Authorized'
    `) || {};
    const state = {
        authorized_devices: Number(row.authorized_devices || 0),
        missing_token: Number(row.missing_token || 0),
        missing_purpose: Number(row.missing_purpose || 0),
        missing_token_or_purpose: Number(row.missing_token_or_purpose || 0),
    };
    return { ...state, ready: state.missing_token_or_purpose === 0 };
}

function registerMaintenanceRoutes(server, ctx) {
    const {
        wrap, fail, requireSession, db, broadcastUpdate, executeEODSweep, executeDailyRhythm,
    } = ctx;

    server.post('/api/daily-rhythm', wrap(async (req, res) => {
        const { auth } = ctx;
        const token = req.body?.token ?? req.body?.userContext?.token ?? req.headers?.['x-session-token'];
        const session = auth.getSession(token);
        let actor = session;
        if (session) {
            if (!canLoadDailyRhythm(session)) return fail(res, 403, 'Unauthorized.');
        } else {
            // Dead token → 401 so clients re-prompt; PIN-only manager fallback stays 403.
            const access = auth.getCredentialAccessStatus(req.body?.userContext?.name);
            if (access.known && !access.allowed) {
                return fail(res, 403, 'Account access is revoked.', 'ACCOUNT_ACCESS_REVOKED');
            }
            const pinOk = await auth.isAuthorizedManager(req.body?.userContext);
            if (!pinOk) {
                if (token) return fail(res, 401, 'Session expired. Please sign in again.');
                return fail(res, 403, 'Unauthorized.');
            }
            actor = { name: req.body?.userContext?.name, role: 'Manager' };
        }
        const force = req.body?.force === true || req.body?.force === '1' || req.body?.force === 1;
        const reason = force
            ? (isManagerRole(actor?.role) ? 'manager-force' : 'shift-lead-force')
            : (isManagerRole(actor?.role) ? 'manager' : 'shift-lead');
        const result = executeDailyRhythm({ force, reason });
        logManagerAudit(db, {
            req,
            session: actor,
            actorName: actor?.name || req.body?.userContext?.name,
            action: force ? 'daily_rhythm_forced' : 'daily_rhythm_loaded',
            targetType: 'daily_rhythm',
            summary: force ? 'Forced daily rhythm reload' : 'Loaded daily rhythm',
            metadata: result,
        });
        res.json(result);
    }));

    server.get('/api/rhythm/status', wrap(async (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return;
        if (!canLoadDailyRhythm(session)) return fail(res, 403, 'Unauthorized.');
        const { buildMorningRhythmStatus } = require('../../lib/daily-rhythm.cjs');
        const clock = typeof ctx.getStoreClockPayload === 'function' ? ctx.getStoreClockPayload() : {};
        res.json({
            success: true,
            morning_rhythm: buildMorningRhythmStatus(db, {
                getStoreDateStamp: ctx.getStoreDateStamp,
                getStoreClockPayload: ctx.getStoreClockPayload,
                storeTime: clock.storeTime,
                getTimezone: () => clock.storeTimezone,
            }),
        });
    }));

    server.post('/api/export-csv', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const rows = db.all('SELECT * FROM tasks');
        if (!rows.length) return fail(res, 404, 'No task data to export.');
        logManagerAudit(db, {
            req,
            session,
            action: 'export_tasks_csv',
            targetType: 'report',
            summary: 'Exported task CSV',
            metadata: { rows: rows.length },
        });
        const csv = [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=tgp_export.csv');
        res.send(csv);
    }));

    server.post('/api/backup-db', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const createPkg = typeof ctx.createBackupPackage === 'function'
            ? ctx.createBackupPackage
            : defaultCreateBackupPackage;
        const dataRoot = typeof ctx.getDataRoot === 'function' ? ctx.getDataRoot() : getDataRoot();
        const pkg = await createPkg({
            db,
            dataRoot,
            stage: 'manual',
            actor: session.name || '',
        });
        if (!pkg?.ok) {
            return fail(
                res,
                500,
                pkg?.error || 'Backup verification failed.',
                pkg?.code || 'BACKUP_VERIFICATION_FAILED',
            );
        }
        if (!pkg.opsDbPath || !fs.existsSync(pkg.opsDbPath)) {
            return fail(res, 500, 'Verified backup file not found.', 'BACKUP_VERIFICATION_FAILED');
        }
        const filename = `TGP_Backup_${pkg.labelDate || 'package'}.db`;
        logManagerAudit(db, {
            req,
            session,
            action: 'database_backup_downloaded',
            targetType: 'database',
            summary: 'Downloaded verified database backup package',
            metadata: {
                filename,
                packageId: pkg.packageId || null,
                opsDbPath: pkg.opsDbPath,
            },
        });
        res.download(pkg.opsDbPath, filename);
    }));


    server.post('/api/maintenance/export-history', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const result = await buildHistoryExportZip(db, {
            days: Number(req.body?.days || 365),
            dataRoot: typeof ctx.getDataRoot === 'function' ? ctx.getDataRoot() : getDataRoot(),
            createBackupPackage: typeof ctx.createBackupPackage === 'function'
                ? ctx.createBackupPackage
                : undefined,
            actor: session.name || '',
        });
        logManagerAudit(db, {
            req,
            session,
            action: 'full_history_export_downloaded',
            targetType: 'database',
            summary: 'Downloaded full history export ZIP',
            metadata: {
                filename: result.filename,
                entries: result.entries,
                packageId: result.packageId || null,
            },
        });
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename=${result.filename}`);
        res.send(result.buffer);
    }));

    server.get('/api/maintenance/health', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const health = checkDatabaseHealth(db, {
            backupsDir: getBackupsDir(),
            dbPath: getDbPath(),
            maxBackupAgeHours: 72,
        });
        recordBootHealth(db, health);
        const network = typeof ctx.getNetworkInfo === 'function' ? ctx.getNetworkInfo() : null;
        const readiness = buildProductionReadinessReport({ db, health, network });
        const release = buildReleaseManifest({ db });
        logManagerAudit(db, {
            req,
            session,
            action: 'maintenance_health_checked',
            targetType: 'maintenance',
            summary: `Checked maintenance health: ${health.status}; readiness ${readiness.status}`,
            metadata: { status: health.status, readiness: readiness.status, errors: health.errors || [], warnings: health.warnings || [] },
        });
        res.json({ success: true, health, readiness, network, release });
    }));

    server.post('/api/maintenance/verify-backup', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        let result;
        try {
            result = runBackupDrill({
                backupsDir: getBackupsDir(),
                backup: req.body?.backup || '',
                skipMigrations: req.body?.skip_migrations === true,
            });
        } catch (e) {
            result = { ok: false, stage: 'startup', error: e.message || String(e) };
        }
        logManagerAudit(db, {
            req,
            session,
            action: result.ok ? 'backup_drill_passed' : 'backup_drill_failed',
            targetType: 'backup',
            targetId: result.backup || req.body?.backup || null,
            summary: result.ok ? `Backup drill passed: ${result.backup}` : `Backup drill failed at ${result.stage || 'startup'}`,
            metadata: result,
        });
        res.status(result.ok ? 200 : 500).json({ success: result.ok, result });
    }));

    server.post('/api/maintenance/secure-store', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const previous = db.get(
            "SELECT setting_value FROM settings WHERE setting_name='Require_TV_Device_Token'",
        )?.setting_value;
        upsertSetting(db, 'Require_TV_Device_Token', '1');
        const deviceSecurity = inspectDeviceSecurityState(db);
        logManagerAudit(db, {
            req,
            session,
            action: 'secure_store_enabled',
            targetType: 'settings',
            targetId: 'Require_TV_Device_Token',
            summary: 'Enabled Secure this store (Require_TV_Device_Token=1)',
            metadata: {
                previous: previous ?? null,
                Require_TV_Device_Token: '1',
                device_security: deviceSecurity,
            },
        });
        broadcastUpdate();
        const network = typeof ctx.getNetworkInfo === 'function' ? ctx.getNetworkInfo() : null;
        const health = checkDatabaseHealth(db, {
            backupsDir: getBackupsDir(),
            dbPath: getDbPath(),
            maxBackupAgeHours: 72,
        });
        const readiness = buildProductionReadinessReport({ db, health, network });
        res.json({
            success: true,
            Require_TV_Device_Token: '1',
            message: deviceSecurity.ready
                ? 'Token-only mode is enforced. All authorized devices have a valid purpose and token.'
                : `Token-only mode is enforced. ${deviceSecurity.missing_token_or_purpose} authorized device(s) are missing a token or purpose; assign both under TV & Devices.`,
            device_security: deviceSecurity,
            readiness,
        });
    }));

    server.post('/api/clear-ticker', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        db.run('DELETE FROM ticker');
        broadcastUpdate();
        db.upsertAudit(crypto.randomUUID(), new Date().toISOString(), session.name, 'clear_ticker', 'ticker', '{}');
        res.json({ success: true });
    }));

    server.post('/api/clear-markdown-db', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const result = clearMarkdownArchive(db);
        broadcastUpdate();
        logManagerAudit(db, {
            req,
            session,
            action: 'clear_markdown_archive',
            targetType: 'kill_dates',
            summary: 'Cleared markdown archive',
            metadata: result,
        });
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'clear_markdown_db',
            'kill_dates',
            JSON.stringify(result),
        );
        res.json({ success: true, ...result });
    }));

    server.post('/api/clear-db', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        db.transaction(() => {
            ['tasks', 'oos', 'special_orders', 'expected_orders', 'ticker',
                'shrink_log', 'kill_dates', 'audit_ledger', 'homebase_audits', 'order_audit'].forEach((t) => db.run(`DELETE FROM ${t}`));
        })();
        broadcastUpdate();
        logManagerAudit(db, {
            req,
            session,
            action: 'clear_operational_db',
            targetType: 'system',
            summary: 'Cleared operational tables',
            metadata: { tables: ['tasks', 'oos', 'special_orders', 'expected_orders', 'ticker', 'shrink_log', 'kill_dates', 'audit_ledger', 'homebase_audits', 'order_audit'] },
        });
        db.upsertAudit(crypto.randomUUID(), new Date().toISOString(), session.name, 'clear_db', 'system', '{}');
        res.json({ success: true });
    }));

    server.post('/api/eod-sweep', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const result = await executeEODSweep(new Date(), {
            vacuum: true,
            skipOrderHistoryArchive: false,
            actor: session.name || 'EOD',
        });
        if (result?.skipped && result.reason === 'busy') {
            return res.status(409).json({
                success: false,
                skipped: true,
                reason: 'busy',
                code: 'EOD_BUSY',
                timestamp: new Date().toISOString(),
            });
        }
        // Incomplete post-backup recovery throws; skipped already_swept only when backup is complete.
        if (!result?.success && !result?.skipped) {
            const err = new Error(result?.error || 'EOD sweep incomplete');
            err.status = 500;
            err.code = result?.code || 'EOD_BACKUP_INCOMPLETE';
            throw err;
        }
        logManagerAudit(db, {
            req,
            session,
            action: 'manual_eod_sweep',
            targetType: 'system',
            summary: result?.recovered_post_backup
                ? 'Recovered missing post-purge EOD backup'
                : result?.skipped && result.reason === 'already_swept'
                    ? 'EOD already complete for store day'
                    : 'Manually ran EOD sweep',
            metadata: {
                storeDate: result?.storeDate || null,
                skipped: !!result?.skipped,
                reason: result?.reason || null,
                recovered_post_backup: !!result?.recovered_post_backup,
            },
        });
        db.upsertAudit(crypto.randomUUID(), new Date().toISOString(), session.name, 'eod_sweep', 'system', '{}');
        res.json({
            success: true,
            ...(result && typeof result === 'object' ? result : {}),
        });
    }));

    server.post('/api/store-template/apply', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const { applyStoreTemplate } = require('../../lib/store-template.cjs');
        const template = String(req.body?.template || 'default').trim();
        const forceRhythm = req.body?.force_rhythm === true || req.body?.force_rhythm === '1';
        const forceZone = req.body?.force_zone === true || req.body?.force_zone === '1';
        const result = applyStoreTemplate(db, template, { forceRhythm, forceZone });
        broadcastUpdate();
        logManagerAudit(db, {
            req,
            session,
            action: 'apply_store_template',
            targetType: 'settings',
            targetId: template,
            summary: `Applied store template ${template}`,
            metadata: { forceRhythm, forceZone, result },
        });
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'apply_store_template',
            'settings',
            JSON.stringify(result),
        );
        res.json({ success: true, ...result });
    }));

    server.post('/api/rhythm-load-advisor', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const { buildRhythmLoadAdvisor } = require('../../lib/rhythm-load-advisor.cjs');
        const storeDate = typeof ctx.getStoreDateStamp === 'function' ? ctx.getStoreDateStamp() : new Date().toISOString().slice(0, 10);
        const storeWeekday = typeof ctx.getStoreDayName === 'function' ? ctx.getStoreDayName() : undefined;
        res.json(buildRhythmLoadAdvisor(db, { storeDate, storeWeekday }));
    }));
}

module.exports = { registerMaintenanceRoutes, canLoadDailyRhythm, inspectDeviceSecurityState };
