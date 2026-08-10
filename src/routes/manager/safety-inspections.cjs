'use strict';

const { logManagerAudit } = require('../../lib/audit-log.cjs');
const {
    getActiveTemplate,
    listInspectionRuns,
    buildRunPayload,
    createInspectionRun,
    saveInspectionRun,
    submitInspectionRun,
    renderInspectionPrintHtml,
} = require('../../lib/safety-inspections.cjs');
const { getStoreMeta } = require('../../constants/store-meta.cjs');
const { canAccessSafeInspections, isManagerRole, listStaffForSync, parsePermissions } = require('../../lib/staff-permissions.cjs');
const { isPrivateIpv4 } = require('../../lib/safe-network-interfaces.cjs');
const { requestIp, findAuthorizedTrustedDevice } = require('../../lib/trusted-device-tokens.cjs');

function listSafeLoginStaff(db) {
    return listStaffForSync(db)
        .filter((s) => s.active === 1 && s.app_access === 1)
        .filter((s) => isManagerRole(s.role) || parsePermissions(s.permissions).includes('safe'))
        .map((s) => ({ name: s.name, role: s.role || 'Clerk' }));
}

function registerSafetyInspectionRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, getStoreDateStamp, broadcastUpdate } = ctx;

    const requireSafeAccess = (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return null;
        if (!canAccessSafeInspections(db, session)) {
            fail(res, 403, 'Manager login or Safety inspections permission required for /safe.');
            return null;
        }
        return session;
    };

    // Pre-login staff picker: must stay ungated by session, but restrict to
    // loopback/private LAN or an authorized trusted device (not the open internet).
    const allowSafeLoginOptions = (req, res) => {
        const raw = String(requestIp(req) || '').replace(/^::ffff:/i, '').toLowerCase();
        const loopback = raw === '127.0.0.1' || raw === '::1' || raw === 'localhost';
        if (loopback || isPrivateIpv4(raw)) return true;
        const device = findAuthorizedTrustedDevice(db, req);
        if (device.authorized) return true;
        fail(res, 403, 'Safe login options are limited to the store LAN or a trusted device.');
        return false;
    };

    server.get('/api/safe/login-options', wrap(async (req, res) => {
        if (!allowSafeLoginOptions(req, res)) return;
        res.json({ success: true, staff: listSafeLoginStaff(db) });
    }));

    server.get('/api/safety/template', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const template = getActiveTemplate(db);
        if (!template) return fail(res, 404, 'Safety checklist template not found.');
        res.json({ success: true, template });
    }));

    server.get('/api/safety/inspections', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const runs = listInspectionRuns(db, {
            status: req.query?.status || '',
            fromDate: req.query?.from || '',
            toDate: req.query?.to || '',
            limit: req.query?.limit,
        });
        res.json({ success: true, runs });
    }));

    server.get('/api/safety/inspections/:runId', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const payload = buildRunPayload(db, req.params.runId);
        if (!payload) return fail(res, 404, 'Inspection not found.');
        res.json({ success: true, ...payload });
    }));

    server.post('/api/safety/inspections', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const serverTime = new Date().toISOString();
        const inspectionDate = req.body?.inspection_date || getStoreDateStamp();
        try {
            const payload = createInspectionRun(db, {
                inspectionDate,
                actorName: session.name,
                serverTime,
            });
            logManagerAudit(db, {
                req,
                session,
                action: 'safety_inspection_created',
                targetType: 'safety_inspection_run',
                targetId: payload.run.run_id,
                summary: `Started safety inspection for ${payload.run.inspection_date}`,
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'safety_inspection_runs', action: 'insert', data: { run_id: payload.run.run_id } });
            }
            res.json({ success: true, ...payload });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not start inspection.');
        }
    }));

    server.patch('/api/safety/inspections/:runId', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const serverTime = new Date().toISOString();
        try {
            const payload = saveInspectionRun(db, req.params.runId, req.body || {}, session.name, serverTime);
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'safety_inspection_runs', action: 'update', id_col: 'run_id', id_val: req.params.runId });
            }
            res.json({ success: true, ...payload });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not save inspection.');
        }
    }));

    server.post('/api/safety/inspections/:runId/submit', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const serverTime = new Date().toISOString();
        try {
            const payload = submitInspectionRun(db, req.params.runId, session.name, serverTime);
            logManagerAudit(db, {
                req,
                session,
                action: 'safety_inspection_submitted',
                targetType: 'safety_inspection_run',
                targetId: payload.run.run_id,
                summary: `Submitted safety inspection for ${payload.run.inspection_date}`,
                metadata: { no_count: payload.stats.no_count },
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'safety_inspection_runs', action: 'update', id_col: 'run_id', id_val: req.params.runId });
            }
            res.json({ success: true, ...payload });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not submit inspection.');
        }
    }));

    server.get('/api/export/safety-inspection', wrap(async (req, res) => {
        const session = requireSafeAccess(req, res);
        if (!session) return;
        const runId = String(req.query.run_id || req.query.runId || '').trim();
        if (!runId) return fail(res, 400, 'run_id is required.');
        const payload = buildRunPayload(db, runId);
        if (!payload) return fail(res, 404, 'Inspection not found.');
        if (payload.run.status !== 'submitted') {
            return fail(res, 400, 'Only submitted inspections can be printed.');
        }
        const settings = db.getSettings ? db.getSettings() : {};
        logManagerAudit(db, {
            req,
            session,
            action: 'export_safety_inspection',
            targetType: 'safety_inspection_run',
            targetId: runId,
            summary: `Printed safety inspection ${runId}`,
        });
        const html = renderInspectionPrintHtml(payload, getStoreMeta(settings).displayName);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(html);
    }));
}

module.exports = { registerSafetyInspectionRoutes, listSafeLoginStaff };
