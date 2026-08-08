'use strict';

const { logManagerAudit } = require('../../lib/audit-log.cjs');
const {
    claimShadowAccess,
    buildAccessPayload,
    updateShadowSettings,
} = require('../../lib/edmonton-receiving-shadow.cjs');
const { createReceivingGuards } = require('./receiving-helpers.cjs');

/**
 * Financial Log report routes — access.
 */
function registerReceivingReportAccessRoutes(server, ctx) {
    const { wrap, fail, db } = ctx;
    const { requireManagerOnly } = createReceivingGuards(ctx);

    server.get('/api/receiving/report/access', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        res.json({ success: true, access: buildAccessPayload(db, session.name) });
    }));

    server.post('/api/receiving/report/shadow/claim', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        try {
            claimShadowAccess(db, session.name);
            logManagerAudit(db, {
                req,
                session,
                action: 'financial_log_shadow_claim',
                targetType: 'settings',
                targetId: 'Financial_Log_Shadow_Allowlist',
                summary: `${session.name} claimed Financial Log shadow access`,
            });
            res.json({ success: true, access: buildAccessPayload(db, session.name) });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not claim shadow access.');
        }
    }));

    server.put('/api/receiving/report/shadow/settings', wrap(async (req, res) => {
        const session = requireManagerOnly(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const patch = {};
        if (b.shadow_mode !== undefined || b.shadowMode !== undefined) {
            patch.shadow_mode = !!(b.shadow_mode ?? b.shadowMode);
        }
        if (b.allowlist !== undefined) {
            patch.allowlist = b.allowlist;
        }
        if (!Object.keys(patch).length) {
            fail(res, 400, 'No shadow settings provided.');
            return;
        }
        try {
            const result = updateShadowSettings(db, patch);
            logManagerAudit(db, {
                req,
                session,
                action: 'financial_log_shadow_settings',
                targetType: 'settings',
                targetId: 'Financial_Log_Shadow_Mode',
                summary: `Updated Financial Log shadow settings`,
                metadata: {
                    previous: result.previous,
                    current: result.current,
                },
            });
            res.json({
                success: true,
                shadow_mode: result.current.shadow_mode,
                allowlist: result.current.allowlist,
                access: buildAccessPayload(db, session.name),
            });
        } catch (e) {
            fail(res, e.status || 400, e.message || 'Could not update shadow settings.');
        }
    }));
}

module.exports = { registerReceivingReportAccessRoutes };
