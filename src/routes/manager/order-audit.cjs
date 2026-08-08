'use strict';

/**
 * Manager-only customer order audit trail (silent to floor / betacs UI).
 * @param {import('express').Application} server
 * @param {object} ctx
 */
function registerOrderAuditRoutes(server, ctx) {
    const { wrap, fail, requireSession, db } = ctx;

    server.get('/api/manager/order-audit', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;

        const orderId = String(req.query.order_id || '').trim();
        const limitRaw = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

        let rows;
        if (orderId) {
            rows = db.all(
                `SELECT id, order_id, actor, action, from_status, to_status, snapshot, ip, timestamp
                 FROM order_audit WHERE order_id = ? ORDER BY timestamp DESC LIMIT ?`,
                orderId,
                limit,
            );
        } else {
            rows = db.all(
                `SELECT id, order_id, actor, action, from_status, to_status, snapshot, ip, timestamp
                 FROM order_audit ORDER BY timestamp DESC LIMIT ?`,
                limit,
            );
        }

        res.json({ entries: rows });
    }));
}

module.exports = { registerOrderAuditRoutes };
