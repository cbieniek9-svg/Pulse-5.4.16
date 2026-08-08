'use strict';

const { getBackupsDir } = require('../paths.cjs');
const { listBackupFiles, getBackupHealth } = require('../lib/backup-health.cjs');
const { openReportsTarget, assembleReportsPayload } = require('../dal/reports-payload.cjs');
const {
    ackAction,
    deferRhythmTasks,
    applyRhythmEstUpdates,
    addRhythmFromPlanning,
} = require('../lib/reports-actions.cjs');
const { buildTrendCsv } = require('../lib/history-trends.cjs');

/**
 * @param {import('express').Application} server
 * @param {object} ctx
 */
function registerReportsRoutes(server, ctx) {
    const {
        wrap, fail, requireSession, db, auth, getStoreDateStamp, APP_VERSION,
        getStoreClockPayload, getHeatMap, broadcastUpdate,
    } = ctx;

    server.get('/api/backups', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const dir = getBackupsDir();
        const backupDetails = listBackupFiles(dir);
        res.json({
            backups: backupDetails.map((b) => b.file),
            backup_details: backupDetails,
            health: getBackupHealth(dir),
        });
    }));

    server.get('/api/reports', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;

        const backupFile = req.query.backup;
        const opened = openReportsTarget(db, backupFile);
        if (!opened.ok) {
            return fail(res, 404, opened.error || 'Backup source unavailable.', opened.code || 'BACKUP_SOURCE_UNAVAILABLE');
        }

        try {
            const liveStoreDate = getStoreDateStamp();
            const payload = assembleReportsPayload({
                targetDb: opened.targetDb,
                APP_VERSION,
                liveStoreDate,
                backupFile: opened.backupFile || backupFile,
                reportSource: opened.reportSource,
                queryDate: req.query.date,
                queryStart: req.query.start,
                queryEnd: req.query.end,
                getStoreClockPayload: ctx.getStoreClockPayload,
                getHeatMap: ctx.getHeatMap,
            });
            res.json(payload);
        } finally {
            opened.close();
        }
    }));


    server.get('/api/reports/trends.csv', wrap(async (req, res) => {
        const session = requireSession(req, res);
        if (!session) return;

        const days = Math.max(7, Math.min(3650, Number(req.query.days || 365)));
        const endDate = (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.end || '')))
            ? String(req.query.end)
            : getStoreDateStamp();
        const csv = buildTrendCsv(db, { endDate, days });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=tgp_trends_${endDate}_${days}d.csv`);
        res.send(csv);
    }));

    server.post('/api/reports/ack-action', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        try {
            const result = ackAction(db, {
                action_id: b.action_id,
                reportDate: b.report_date || getStoreDateStamp(),
                actorName: session.name,
            });
            if (typeof broadcastUpdate === 'function') broadcastUpdate();
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Ack failed');
        }
    }));

    server.post('/api/reports/defer-rhythm', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        try {
            const result = deferRhythmTasks(db, {
                storeDate: b.store_date || getStoreDateStamp(),
                rhythmIds: b.rhythm_ids || b.rhythmIds || [],
                actorName: session.name,
                serverTime: new Date().toISOString(),
            });
            if (typeof broadcastUpdate === 'function') broadcastUpdate();
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Defer failed');
        }
    }));

    server.post('/api/reports/apply-rhythm-estimates', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        const updates = b.updates || b.rows || [];
        if (!Array.isArray(updates) || !updates.length) {
            return fail(res, 400, 'updates array required');
        }
        try {
            const result = applyRhythmEstUpdates(db, updates, { actorName: session.name });
            if (!result.applied.length) {
                return fail(res, 404, 'No rhythm template matched this task type.');
            }
            if (typeof broadcastUpdate === 'function') broadcastUpdate();
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Apply failed');
        }
    }));

    server.post('/api/reports/add-to-rhythm', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        try {
            const result = addRhythmFromPlanning(db, {
                detail: b.detail || b.task_type,
                day: b.day,
                zone: b.zone,
                priority: b.priority,
                est_mins: b.est_mins ?? b.avg_actual_mins,
                actorName: session.name,
            });
            if (typeof broadcastUpdate === 'function') broadcastUpdate();
            res.json({ success: true, created: result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Add to rhythm failed');
        }
    }));
}

module.exports = { registerReportsRoutes };
