'use strict';

const MAX_METADATA_CHARS = 4000;

function actorFromSession(session) {
    if (!session) return { actor_staff_id: null, actor_name: null };
    return {
        actor_staff_id: session.staff_id ?? session.id ?? null,
        actor_name: session.name || null,
    };
}

function safeJson(value) {
    if (value == null) return null;
    try {
        const json = JSON.stringify(value);
        return json.length > MAX_METADATA_CHARS
            ? JSON.stringify({ truncated: true, preview: json.slice(0, MAX_METADATA_CHARS) })
            : json;
    } catch (e) {
        return JSON.stringify({ unserializable: true, message: e.message });
    }
}

function requestIp(req) {
    return req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || null;
}

function requestUserAgent(req) {
    const ua = req?.headers?.['user-agent'];
    return ua ? String(ua).slice(0, 500) : null;
}

/**
 * Best-effort manager audit logger. It must never break the manager action it is observing.
 */
function logManagerAudit(db, {
    req,
    session,
    actorName,
    action,
    targetType = null,
    targetId = null,
    summary = null,
    metadata = null,
    eventId = '',
} = {}) {
    if (!db || !action) return false;
    const actor = actorFromSession(session);
    const createdAt = new Date().toISOString();
    try {
        db.run(
            `INSERT INTO manager_audit_log (
                created_at, actor_staff_id, actor_name, action, target_type, target_id,
                summary, metadata_json, ip_address, user_agent, source_event_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source_event_id) WHERE source_event_id != '' DO NOTHING`,
            createdAt,
            actor.actor_staff_id,
            actor.actor_name || actorName || null,
            String(action),
            targetType == null ? null : String(targetType),
            targetId == null ? null : String(targetId),
            summary == null ? null : String(summary).slice(0, 1000),
            safeJson(metadata),
            requestIp(req),
            requestUserAgent(req),
            String(eventId || ''),
        );
        return true;
    } catch (e) {
        try { console.warn(`[AUDIT] manager audit write failed: ${e.message}`); } catch (_) { /* noop */ }
        return false;
    }
}

function listManagerAudit(db, { limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 100, 500));
    const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    return db.all(
        `SELECT id, created_at, actor_staff_id, actor_name, action, target_type, target_id,
                summary, metadata_json, ip_address, user_agent
           FROM manager_audit_log
          ORDER BY id DESC
          LIMIT ? OFFSET ?`,
        safeLimit,
        safeOffset,
    ).map((row) => ({
        ...row,
        metadata: (() => {
            if (!row.metadata_json) return null;
            try { return JSON.parse(row.metadata_json); } catch (_) { return null; }
        })(),
    }));
}

module.exports = {
    logManagerAudit,
    listManagerAudit,
    safeJson,
};
