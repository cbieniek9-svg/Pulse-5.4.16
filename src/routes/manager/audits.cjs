'use strict';

const crypto = require('crypto');
const { csvCell } = require('../../lib/csv-safe.cjs');
const { listManagerAudit, logManagerAudit } = require('../../lib/audit-log.cjs');

const { createPremiumZoneRecoveryTasks } = require('../../lib/premium-zone-recovery.cjs');

function registerAuditRoutes(server, ctx) {
    const { wrap, fail, requireSession, requireShiftLead, db, broadcastUpdate, refreshHeatMap } = ctx;

    server.get('/api/manager/audit-log', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const limit = req.query?.limit;
        const offset = req.query?.offset;
        res.json({ success: true, events: listManagerAudit(db, { limit, offset }) });
    }));

    server.post('/api/premium-zone-recovery', wrap(async (req, res) => {
        const session = requireShiftLead(req, res);
        if (!session) return;
        const check = req.body?.check ?? req.body;
        try {
            const result = createPremiumZoneRecoveryTasks(db, check, session.name);
            broadcastUpdate();
            res.json({ success: true, ...result });
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Recovery check failed.');
        }
    }));

    server.post('/api/homebase-audits', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;

        const { audit } = req.body ?? {};
        if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return fail(res, 400, 'audit must be a JSON object.');
        if (JSON.stringify(audit).length > 50000) return fail(res, 413, 'Audit payload too large.');

        for (const field of ['zone_name', 'premium_name']) {
            if (typeof audit[field] !== 'string' || !audit[field].trim())
                return fail(res, 400, `Missing required field: ${field}`);
            if (audit[field].length > 200)
                return fail(res, 400, `Field too long: ${field} (max 200 chars)`);
        }
        if (audit.notes !== undefined && typeof audit.notes !== 'string')
            return fail(res, 400, 'notes must be a string.');
        if (audit.notes && audit.notes.length > 1000)
            return fail(res, 400, 'notes exceeds 1000-character limit.');

        const auditor = db.findStaffByName(session.name);
        if (!auditor) return fail(res, 403, 'Auditor not found in staff table.');

        const FAIL_CHECKS = [
            { key: 'front_edge_pass', label: 'FRONT-EDGE', time: 20 },
            { key: 'tag_integrity_pass', label: 'TAG INTEGRITY', time: 15 },
            { key: 'hole_strategy_pass', label: 'HOLE STRATEGY', time: 10 },
            { key: 'clearances_pass', label: 'FIXTURE CLEARANCE', time: 15 },
        ];

        db.transaction(() => {
            db.run(
                'INSERT INTO homebase_audits (zone_name,premium_name,audit_data,notes,auditor_id) VALUES (?,?,?,?,?)',
                audit.zone_name, audit.premium_name, JSON.stringify(audit), audit.notes || '', auditor.id
            );
            const now = new Date().toISOString();
            const base = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
            FAIL_CHECKS.forEach((f, i) => {
                if (audit[f.key] === 0) {
                    db.run(
                        'INSERT INTO tasks (task_id,task_detail,status,priority,zone,assigned_to,est_mins,time_submitted) VALUES (?,?,?,?,?,?,?,?)',
                        `T-AUDIT-${base}-${i}`,
                        `RECOVERY: ${f.label} (${audit.premium_name})`,
                        'Open', 'High', audit.zone_name, 'Unassigned', f.time, now
                    );
                }
            });
            db.upsertAudit(crypto.randomUUID(), now, session.name, 'submit_audit', 'homebase_audits', JSON.stringify({ zone: audit.zone_name }));
        })();

        refreshHeatMap();
        broadcastUpdate();
        res.json({ success: true });
    }));

    server.get('/api/export/weekly-trends', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const trends = db.all(`
            SELECT strftime('%Y-W%W',timestamp) as week, zone_name, COUNT(*) as total_audits,
                ROUND(AVG(json_extract(audit_data,'$.front_edge_pass'))    *100,1) as front_edge_rate,
                ROUND(AVG(json_extract(audit_data,'$.tag_integrity_pass')) *100,1) as tag_integrity_rate,
                ROUND(AVG(json_extract(audit_data,'$.hole_strategy_pass')) *100,1) as hole_strategy_rate,
                ROUND(AVG(json_extract(audit_data,'$.clearances_pass'))    *100,1) as clearances_rate
            FROM homebase_audits WHERE audit_data IS NOT NULL
            GROUP BY week, zone_name ORDER BY week DESC, zone_name ASC
        `);
        if (!trends.length) return fail(res, 404, 'No trend data available.');
        const rows = trends.map((t) => [t.week, t.zone_name, t.total_audits,
            t.front_edge_rate + '%', t.tag_integrity_rate + '%', t.hole_strategy_rate + '%', t.clearances_rate + '%',
        ].map(csvCell).join(','));
        res.setHeader('Content-Type', 'text/csv');
        logManagerAudit(db, {
            req,
            session,
            action: 'export_weekly_trends',
            targetType: 'report',
            summary: 'Exported weekly audit trends CSV',
            metadata: { rows: rows.length },
        });
        res.setHeader('Content-Disposition', 'attachment; filename=Weekly_Trends.csv');
        res.send(['Week,Zone,Total Audits,Front Edge %,Tag Integrity %,Hole Strategy %,Clearances %', ...rows].join('\n'));
    }));

    server.get('/api/export/audits', wrap(async (req, res) => {
        if (!requireSession(req, res, true)) return;
        const { premium, start, end } = req.query;
        let sql = 'SELECT a.*, s.name as auditor_name FROM homebase_audits a JOIN staff s ON a.auditor_id=s.id WHERE 1=1';
        const params = [];
        if (premium) { sql += ' AND premium_name=?'; params.push(premium); }
        if (start) { sql += ' AND timestamp>=?'; params.push(start + ' 00:00:00'); }
        if (end) { sql += ' AND timestamp<=?'; params.push(end + ' 23:59:59'); }
        const rows = db.all(sql, ...params);
        if (!rows.length) return fail(res, 404, 'No audit data found.');
        logManagerAudit(db, {
            req,
            session: ctx.auth?.getSession(req.headers?.['x-session-token'] ?? req.body?.token),
            action: 'export_homebase_audits',
            targetType: 'report',
            summary: 'Exported HomeBase audits CSV',
            metadata: { rows: rows.length, premium: premium || null, start: start || null, end: end || null },
        });
        const csv = [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map(csvCell).join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=HomeBase_Audits.csv');
        res.send(csv);
    }));

    server.get('/api/export/kill-dates', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const { getStoreDateStamp } = ctx;
        const { buildKillDateExportPayload, renderKillDatePrintHtml, renderKillDateCsv } = require('../../lib/kill-date-export.cjs');
        const { getStoreMeta } = require('../../constants/store-meta.cjs');
        const settings = db.getSettings ? db.getSettings() : {};
        const storeDate = typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : new Date().toISOString().slice(0, 10);
        const payload = buildKillDateExportPayload(db, storeDate, settings);
        const format = String(req.query.format || 'print').toLowerCase();
        logManagerAudit(db, {
            req,
            session,
            action: 'export_kill_dates',
            targetType: 'report',
            targetId: storeDate,
            summary: `Exported expiry pull list for ${storeDate}`,
            metadata: { format, item_count: payload.items?.length ?? null },
        });
        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=Expiry_Pull_List_${storeDate}.csv`);
            return res.send(renderKillDateCsv(payload));
        }
        const html = renderKillDatePrintHtml(payload, getStoreMeta(settings).displayName);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    }));

    server.get('/api/export/receiving-log', wrap(async (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return;
        const staff = db.findStaffByName(session.name);
        const perms = String(staff?.permissions || '').split(',').filter(Boolean);
        const { isManagerRole } = require('../../lib/staff-permissions.cjs');
        const canExport = isManagerRole(session.role) || perms.includes('receiving');
        if (!canExport) return fail(res, 403, 'Manager or receiving permission required.');

        const { getStoreDateStamp } = ctx;
        const { buildReceivingLogPayload, renderReceivingLogCsv, renderReceivingLogPrintHtml } = require('../../lib/receiving-log-export.cjs');
        const { getStoreMeta } = require('../../constants/store-meta.cjs');
        const settings = db.getSettings ? db.getSettings() : {};
        const defaultDate = typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : new Date().toISOString().slice(0, 10);
        const storeDate = String(req.query.date || defaultDate).trim();

        let payload;
        try {
            payload = buildReceivingLogPayload(db, storeDate);
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Invalid date.');
        }

        const format = String(req.query.format || 'print').toLowerCase();
        logManagerAudit(db, {
            req,
            session,
            action: 'export_receiving_log',
            targetType: 'report',
            targetId: storeDate,
            summary: `Exported receiving log for ${storeDate}`,
            metadata: { format, item_count: payload.orders?.length ?? payload.rows?.length ?? null },
        });
        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=Receiving_Log_${storeDate}.csv`);
            return res.send(renderReceivingLogCsv(payload));
        }
        const html = renderReceivingLogPrintHtml(payload, getStoreMeta(settings).displayName);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    }));


    server.get('/api/export/receiving-file-maintenance', wrap(async (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return;
        const staff = db.findStaffByName(session.name);
        const perms = String(staff?.permissions || '').split(',').filter(Boolean);
        const { isManagerRole } = require('../../lib/staff-permissions.cjs');
        const canExport = isManagerRole(session.role) || perms.includes('receiving');
        if (!canExport) return fail(res, 403, 'Manager or receiving permission required.');

        const {
            addDays,
            buildFileMaintenanceReceivingLogPayload,
            renderFileMaintenanceReceivingLogCsv,
            renderFileMaintenanceReceivingLogHtml,
        } = require('../../lib/file-maintenance-receiving-log.cjs');
        const { getStoreMeta } = require('../../constants/store-meta.cjs');
        const settings = db.getSettings ? db.getSettings() : {};
        const today = typeof ctx.getStoreDateStamp === 'function' ? ctx.getStoreDateStamp() : new Date().toISOString().slice(0, 10);
        const defaultDate = addDays(today, -1);
        const storeDate = String(req.query.date || defaultDate).trim();
        const format = String(req.query.format || 'print').toLowerCase();

        let payload;
        try {
            payload = buildFileMaintenanceReceivingLogPayload(db, storeDate);
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Invalid date.');
        }

        logManagerAudit(db, {
            req,
            session,
            action: 'export_receiving_file_maintenance_log',
            targetType: 'report',
            targetId: payload.store_date,
            summary: `Exported receiving log for ${payload.store_date}`,
            metadata: { format, item_count: payload.rows?.length ?? null, invoice_ref_count: payload.invoice_ref_count ?? null },
        });

        if (format === 'csv') {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=Receiving_Log_${payload.store_date}.csv`);
            return res.send(renderFileMaintenanceReceivingLogCsv(payload));
        }

        const html = renderFileMaintenanceReceivingLogHtml(payload, getStoreMeta(settings).displayName);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    }));

    server.get('/api/export/tgp-cold-chain', wrap(async (req, res) => {
        // Dock staff on /rec need this for BOL paperwork; any signed-in session may print/export.
        const session = requireSession(req, res, false);
        if (!session) return;

        const { getStoreDateStamp } = ctx;
        const { buildColdChainPayload, renderColdChainCsv, renderColdChainPrintHtml } = require('../../lib/tgp-cold-chain-export.cjs');
        const { getStoreMeta } = require('../../constants/store-meta.cjs');
        const settings = db.getSettings ? db.getSettings() : {};
        const defaultDate = typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : new Date().toISOString().slice(0, 10);
        const start = String(req.query.start || req.query.date || defaultDate).trim();
        const end = String(req.query.end || start).trim();
        const format = String(req.query.format || 'print').toLowerCase();

        let payload;
        try {
            payload = buildColdChainPayload(db, start, end);
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Invalid date range.');
        }

        logManagerAudit(db, {
            req,
            session,
            action: 'export_tgp_cold_chain',
            targetType: 'report',
            targetId: `${payload.start}:${payload.end}`,
            summary: `Exported TGP cold chain for ${payload.start}${payload.end !== payload.start ? ` → ${payload.end}` : ''}`,
            metadata: { format, pallet_count: payload.summary?.pallet_count ?? null },
        });

        if (format === 'csv') {
            const fileLabel = payload.start === payload.end ? payload.start : `${payload.start}_${payload.end}`;
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=TGP_Cold_Chain_${fileLabel}.csv`);
            return res.send(renderColdChainCsv(payload));
        }

        const html = renderColdChainPrintHtml(payload, getStoreMeta(settings).displayName);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    }));

}

module.exports = { registerAuditRoutes };
