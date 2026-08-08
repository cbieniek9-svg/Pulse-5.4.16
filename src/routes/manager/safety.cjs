'use strict';

const {
    listSafetyBlurbs,
    ensureDailySafetyFocus,
    importSafetyBlurbs,
    updateSafetyBlurb,
    clearDailySafetyFocus,
    loadDailySafetyFocus,
} = require('../../lib/safety-blurbs.cjs');
const { logManagerAudit } = require('../../lib/audit-log.cjs');

function registerSafetyRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, getStoreDateStamp, broadcastUpdate } = ctx;

    const requireManager = (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return null;
        return session;
    };

    server.get('/api/manager/safety', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const storeDate = req.query?.date || getStoreDateStamp();
        const focus = ensureDailySafetyFocus(db, storeDate, { selectedBy: 'AUTO' });
        res.json({
            success: true,
            store_date: storeDate,
            focus,
            blurbs: listSafetyBlurbs(db),
        });
    }));

    server.post('/api/manager/safety/import', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const text = req.body?.text || req.body?.messages || '';
        const added = importSafetyBlurbs(db, text, { active: true });
        if (!added.length) return fail(res, 400, 'Paste at least one safety blurb, one per line.');
        logManagerAudit(db, {
            req,
            session,
            action: 'safety_blurbs_imported',
            targetType: 'safety_blurbs',
            summary: `Imported ${added.length} safety blurb(s)`,
            metadata: { count: added.length },
        });
        broadcastUpdate();
        res.json({ success: true, added_count: added.length, blurbs: listSafetyBlurbs(db) });
    }));

    server.post('/api/manager/safety/blurb', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const id = req.body?.id;
        const patch = {
            message: req.body?.message,
            active: req.body?.active,
            sort_order: req.body?.sort_order,
        };
        const row = updateSafetyBlurb(db, id, patch);
        logManagerAudit(db, {
            req,
            session,
            action: 'safety_blurb_updated',
            targetType: 'safety_blurb',
            targetId: row.id,
            summary: `Updated safety blurb #${row.id}`,
            metadata: { active: row.active, sort_order: row.sort_order },
        });
        broadcastUpdate();
        res.json({ success: true, blurb: row, blurbs: listSafetyBlurbs(db) });
    }));

    server.post('/api/manager/safety/focus', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const storeDate = req.body?.store_date || getStoreDateStamp();
        const blurbId = req.body?.blurb_id || req.body?.id || null;
        const focus = ensureDailySafetyFocus(db, storeDate, {
            selectedBy: session.name || 'Manager',
            force: true,
            blurbId,
        });
        logManagerAudit(db, {
            req,
            session,
            action: blurbId ? 'daily_safety_focus_set' : 'daily_safety_focus_rotated',
            targetType: 'daily_safety_focus',
            targetId: storeDate,
            summary: blurbId ? `Set daily safety focus for ${storeDate}` : `Picked next daily safety focus for ${storeDate}`,
            metadata: { store_date: storeDate, blurb_id: focus.blurb_id, message: focus.message },
        });
        broadcastUpdate();
        res.json({ success: true, focus, blurbs: listSafetyBlurbs(db) });
    }));

    server.post('/api/manager/safety/clear-focus', wrap(async (req, res) => {
        const session = requireManager(req, res);
        if (!session) return;
        const storeDate = req.body?.store_date || getStoreDateStamp();
        const result = clearDailySafetyFocus(db, storeDate, { selectedBy: session.name || 'Manager' });
        logManagerAudit(db, {
            req,
            session,
            action: 'daily_safety_focus_cleared',
            targetType: 'daily_safety_focus',
            targetId: storeDate,
            summary: `Cleared daily safety focus for ${storeDate}`,
            metadata: result.previous || {},
        });
        broadcastUpdate();
        res.json({ success: true, cleared: result.cleared, focus: loadDailySafetyFocus(db, storeDate), blurbs: listSafetyBlurbs(db) });
    }));
}

module.exports = { registerSafetyRoutes };
