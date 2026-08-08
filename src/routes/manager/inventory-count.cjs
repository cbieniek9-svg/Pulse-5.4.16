'use strict';

const {
    isInventoryCountEnabled,
    createSession,
    listSessions,
    summarizeBackstock,
    listCommittedBackstock,
    closeBackstockSession,
    closeLocationSession,
    finalizeOrderDraft,
    getOrderReport,
    getSession,
    getSessionDetail,
    isClosedStatus,
    insertScan,
    listActiveScans,
    updateLine,
    deleteLine,
    exportSession,
    buildPrintHtml,
    reopenSession,
    updateSession,
} = require('../../lib/inventory-count.cjs');
const { lookupItem, resolveVendorCode } = require('../../lib/item-catalog.cjs');
const { canAccessInventoryCount } = require('../../lib/staff-permissions.cjs');

function registerInventoryCountRoutes(server, ctx) {
    const { wrap, fail, requireSession, db } = ctx;

    const requireCountFeature = (req, res) => {
        const settings = typeof db?.getSettings === 'function' ? db.getSettings() : {};
        if (!isInventoryCountEnabled(settings)) {
            fail(res, 403, 'Inventory count is disabled. Enable it in Settings → Store & TV.');
            return false;
        }
        return true;
    };

    const requireCountAuth = (req, res) => {
        if (!requireCountFeature(req, res)) return null;
        const session = requireSession(req, res, false);
        if (!session) return null;
        if (!canAccessInventoryCount(db, session)) {
            fail(res, 403, 'Inventory count permission required.', 'INVENTORY_PERMISSION_REQUIRED');
            return null;
        }
        return session;
    };

    /** Public feature flag (no auth) — same pattern as /api/cs/config. */
    server.get('/api/inventory/config', wrap(async (_req, res) => {
        const settings = typeof db?.getSettings === 'function' ? db.getSettings() : {};
        const enabled = isInventoryCountEnabled(settings);
        res.set('Cache-Control', 'no-store');
        res.json({
            enabled,
            portalUrl: '/count',
            note: enabled
                ? 'Inventory count portal is on (location + backstock walks).'
                : 'Off by default until SMS / superseding is ready. Toggle in Settings.',
        });
    }));

    server.post('/api/inventory/sessions', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        const b = req.body ?? {};
        try {
            const countSession = createSession({
                location: b.location,
                session_type: b.session_type || b.type,
                created_by: auth.name || b.created_by,
            });
            res.json({ success: true, session: countSession });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not create count session.', e.code);
        }
    }));

    server.get('/api/inventory/sessions', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const sessions = listSessions({
                status: req.query?.status || 'all',
                session_type: req.query?.session_type || req.query?.type || undefined,
            });
            res.json({ success: true, sessions, count: sessions.length });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not list count sessions.', e.code);
        }
    }));

    /** Committed backstock memory (after CLOSE & COMMIT) — used by order finalize. */
    server.get('/api/inventory/backstock/summary', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const source = String(req.query?.source || 'committed').toLowerCase();
            const summary = summarizeBackstock({
                source: source === 'open' || source === 'both' ? source : 'committed',
                include_exported: req.query?.include_exported,
            });
            const committed = source === 'open' ? [] : listCommittedBackstock();
            res.json({ success: true, ...summary, committed_rows: committed });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not load backstock summary.', e.code);
        }
    }));

    /** Close backstock walk → write UPC×location into durable memory for order matching. */
    server.post('/api/inventory/sessions/:id/close-backstock', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const result = closeBackstockSession(req.params.id, {
                lookupItem: (upc) => {
                    try { return lookupItem(db, upc); } catch (_) { return null; }
                },
            });
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not close / commit backstock.', e.code);
        }
    }));

    /** Close location count without requiring CSV download. */
    server.post('/api/inventory/sessions/:id/close-location', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const result = closeLocationSession(req.params.id, {
                actor: auth.name,
                note: req.body?.note,
            });
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not close location count.', e.code);
        }
    }));

    /** Printable location count (cost/retail). */
    server.get('/api/inventory/sessions/:id/print', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const html = buildPrintHtml(req.params.id, {
                lookupItem: (upc) => {
                    try { return lookupItem(db, upc); } catch (_) { return null; }
                },
            });
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.send(html);
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not build count print view.', e.code);
        }
    }));

    server.get('/api/inventory/sessions/:id', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const detail = getSessionDetail(req.params.id);
            res.json({ success: true, ...detail });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not load count session.', e.code);
        }
    }));

    server.patch('/api/inventory/sessions/:id', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const countSession = updateSession(req.params.id, req.body ?? {});
            res.json({ success: true, session: countSession });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not update count session.', e.code);
        }
    }));

    server.post('/api/inventory/sessions/:id/export', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const { csv, count, filename, session: countSession } = exportSession(req.params.id);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
            res.setHeader('X-Export-Count', String(count));
            res.setHeader('X-Session-Id', countSession.id);
            res.send(csv);
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not export count session.', e.code);
        }
    }));

    server.post('/api/inventory/sessions/:id/reopen', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        const existing = getSession(req.params.id);
        if (existing && isClosedStatus(existing.status)) {
            const { assertInventoryControlReauth } = require('../../lib/inventory-reauth.cjs');
            try {
                await assertInventoryControlReauth({
                    db,
                    session: auth,
                    data: req.body ?? {},
                    action: 'reopen a locked inventory session',
                });
            } catch (e) {
                return fail(res, e.status || 403, e.message, e.code);
            }
        }
        try {
            const countSession = reopenSession(req.params.id);
            res.json({ success: true, session: countSession });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not reopen count session.', e.code);
        }
    }));

    /**
     * Order draft → pick list + clean order (vendor code + UPC).
     * Uses committed backstock memory. Never touches the floor labor order clock.
     * Saves report_json on the session so PRINT / CSV survive leaving the screen.
     */
    server.post('/api/inventory/sessions/:id/finalize-order', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        const b = req.body ?? {};
        try {
            const result = finalizeOrderDraft(req.params.id, {
                include_exported_backstock: b.include_exported_backstock,
                backstock_source: b.backstock_source,
                mark_exported: b.mark_exported !== false,
                lookupItem: (upc) => {
                    try {
                        const hit = lookupItem(db, upc);
                        if (!hit) return null;
                        return {
                            ...hit,
                            vendor_code: resolveVendorCode(db, hit),
                        };
                    } catch (_) { return null; }
                },
            });
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not finalize order draft.', e.code);
        }
    }));

    /** Re-open saved clean order / pick list (or regenerate if snapshot missing). */
    server.get('/api/inventory/sessions/:id/order-report', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const result = getOrderReport(req.params.id, {
                refresh: req.query?.refresh,
                include_exported_backstock: req.query?.include_exported_backstock,
                backstock_source: req.query?.backstock_source,
                lookupItem: (upc) => {
                    try {
                        const hit = lookupItem(db, upc);
                        if (!hit) return null;
                        return {
                            ...hit,
                            vendor_code: resolveVendorCode(db, hit),
                        };
                    } catch (_) { return null; }
                },
            });
            res.json({ success: true, ...result });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not load order report.', e.code);
        }
    }));

    server.post('/api/inventory/scan', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        const b = req.body ?? {};
        try {
            const row = insertScan({
                session_id: b.session_id,
                upc: b.upc,
                quantity: b.quantity,
                uom: b.uom,
                lookupItem: (upc) => {
                    try { return lookupItem(db, upc); } catch (_) { return null; }
                },
            });
            res.json({ success: true, scan: row });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not stage scan.', e.code);
        }
    }));

    server.get('/api/inventory/active', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const scans = listActiveScans({ session_id: req.query?.session_id });
            res.json({ success: true, scans, count: scans.length });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not load staged scans.', e.code);
        }
    }));

    /** Legacy: export first open session (prefer POST /sessions/:id/export). */
    server.get('/api/inventory/export', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const open = listSessions({ status: 'open' });
            if (!open.length) {
                return fail(res, 404, 'No open count session to export.');
            }
            const sessionId = String(req.query?.session_id || open[0].id);
            const { csv, count, filename, session: countSession } = exportSession(sessionId);
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
            res.setHeader('X-Export-Count', String(count));
            res.setHeader('X-Session-Id', countSession.id);
            res.send(csv);
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not export staged counts.', e.code);
        }
    }));

    server.patch('/api/inventory/lines/:id', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const line = updateLine(req.params.id, {
                ...(req.body ?? {}),
                actor: auth.name,
                lookupItem: (upc) => {
                    try { return lookupItem(db, upc); } catch (_) { return null; }
                },
            });
            res.json({ success: true, line });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not update count line.', e.code);
        }
    }));

    server.delete('/api/inventory/lines/:id', wrap(async (req, res) => {
        const auth = requireCountAuth(req, res);
        if (!auth) return;
        try {
            const result = deleteLine(req.params.id);
            res.json(result);
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not delete count line.', e.code);
        }
    }));
}

module.exports = { registerInventoryCountRoutes };
