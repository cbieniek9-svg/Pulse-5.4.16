'use strict';

const crypto = require('crypto');
const {
    LANES,
    PRIORITIES,
    isMessageCenterEnabled,
    insertMessage,
    dismissMessage,
    promoteToPinned,
    clearLane,
    expiresAtFromHours,
    hasCommsPermission,
} = require('../../lib/comms-center.cjs');

function registerCommsRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, broadcastUpdate } = ctx;

    const requireComms = (req, res) => {
        const session = requireSession(req, res);
        if (!session) return null;
        if (!hasCommsPermission(db, session)) {
            fail(res, 403, 'Comms permission required.');
            return null;
        }
        return session;
    };

    server.post('/api/comms/post', wrap(async (req, res) => {
        const session = requireComms(req, res);
        if (!session) return;
        const settings = db.getSettings ? db.getSettings() : {};
        if (!isMessageCenterEnabled(settings)) {
            return fail(res, 400, 'Message Center is disabled. Enable it in manager settings or use legacy comms.');
        }

        const b = req.body ?? {};
        const lane = String(b.lane || '').trim();
        if (!LANES.includes(lane)) return fail(res, 400, 'lane must be pinned, ticker, or feed.');
        const body = String(b.body || '').trim();
        if (!body || body.length > 500) return fail(res, 400, 'body must be 1-500 characters.');
        const priority = PRIORITIES.includes(b.priority) ? b.priority : (lane === 'pinned' ? 'warn' : 'info');
        const zone = String(b.zone || '').trim().slice(0, 40);
        const expiresHours = b.expires_hours != null ? Number(b.expires_hours) : null;
        const expiresAt = expiresAtFromHours(expiresHours) || (b.expires_at ? new Date(b.expires_at).toISOString() : null);

        const msgId = insertMessage(db, {
            lane,
            body,
            priority,
            posted_by: session.name,
            expires_at: expiresAt,
            zone,
        });

        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'comms_post',
            'comms_messages',
            JSON.stringify({ msg_id: msgId, lane, priority, zone }),
        );
        broadcastUpdate({ table: 'comms_messages', action: 'refresh' });
        res.json({ success: true, msg_id: msgId });
    }));

    server.post('/api/comms/dismiss', wrap(async (req, res) => {
        const session = requireComms(req, res);
        if (!session) return;
        const msgId = String(req.body?.msg_id || '').trim();
        if (!msgId) return fail(res, 400, 'msg_id is required.');
        dismissMessage(db, msgId, session.name);
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'comms_dismiss',
            'comms_messages',
            JSON.stringify({ msg_id: msgId }),
        );
        broadcastUpdate({ table: 'comms_messages', action: 'refresh' });
        res.json({ success: true });
    }));

    server.post('/api/comms/promote', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const msgId = String(req.body?.msg_id || '').trim();
        if (!msgId) return fail(res, 400, 'msg_id is required.');
        promoteToPinned(db, msgId, session.name);
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'comms_promote',
            'comms_messages',
            JSON.stringify({ msg_id: msgId }),
        );
        broadcastUpdate({ table: 'comms_messages', action: 'refresh' });
        res.json({ success: true });
    }));

    server.post('/api/comms/clear-lane', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const lane = String(req.body?.lane || '').trim();
        if (!LANES.includes(lane)) return fail(res, 400, 'Invalid lane.');
        clearLane(db, lane, session.name);
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'comms_clear_lane',
            'comms_messages',
            JSON.stringify({ lane }),
        );
        broadcastUpdate({ table: 'comms_messages', action: 'refresh' });
        res.json({ success: true });
    }));

    server.post('/api/comms/set-mode', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const enabled = req.body?.enabled === true || req.body?.enabled === '1' || req.body?.enabled === 1;
        const systemMessages = req.body?.system_messages;
        db.run(
            "UPDATE settings SET setting_value = ? WHERE setting_name = 'Message_Center_Enabled'",
            enabled ? '1' : '0',
        );
        if (systemMessages !== undefined) {
            const sysOn = systemMessages === true || systemMessages === '1' || systemMessages === 1;
            db.run(
                "UPDATE settings SET setting_value = ? WHERE setting_name = 'Comms_System_Messages'",
                sysOn ? '1' : '0',
            );
        }
        db.upsertAudit(
            crypto.randomUUID(),
            new Date().toISOString(),
            session.name,
            'comms_set_mode',
            'settings',
            JSON.stringify({ Message_Center_Enabled: enabled ? '1' : '0' }),
        );
        broadcastUpdate({ table: 'comms_messages', action: 'refresh' });
        res.json({
            success: true,
            Message_Center_Enabled: enabled ? '1' : '0',
        });
    }));
}

module.exports = { registerCommsRoutes };
