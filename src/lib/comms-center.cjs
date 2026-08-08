'use strict';

const crypto = require('crypto');
const { rhythmNotLoadedBy630, wasTgpOrderDay } = require('./manager-exceptions.cjs');

const LANES = Object.freeze(['pinned', 'ticker', 'feed']);
const PRIORITIES = Object.freeze(['info', 'warn', 'urgent']);

function nowIso() {
    return new Date().toISOString();
}

function genMsgId() {
    return `CM-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function isMessageCenterEnabled(settings = {}) {
    return settings.Message_Center_Enabled === '1';
}

function isSystemMessagesEnabled(settings = {}) {
    return settings.Comms_System_Messages !== '0';
}

function parseMeta(row) {
    try {
        return JSON.parse(row?.meta_json || '{}');
    } catch (_) {
        return {};
    }
}

function normalizeRow(row) {
    if (!row) return null;
    return {
        msg_id: row.msg_id,
        lane: row.lane,
        body: row.body,
        priority: row.priority || 'info',
        source: row.source || 'human',
        posted_by: row.posted_by,
        posted_at: row.posted_at,
        expires_at: row.expires_at || null,
        dismissed_at: row.dismissed_at || null,
        dismissed_by: row.dismissed_by || null,
        zone: row.zone || '',
        dedupe_key: row.dedupe_key || '',
        meta: parseMeta(row),
        archived_at: row.archived_at || null,
    };
}

function isActiveRow(row, nowMs = Date.now()) {
    if (!row) return false;
    if (row.dismissed_at || row.archived_at) return false;
    if (row.expires_at && Date.parse(row.expires_at) <= nowMs) return false;
    return true;
}

function listActiveMessages(db, { lane = null, zone = null, limit = 40 } = {}) {
    const params = [];
    let sql = `
        SELECT * FROM comms_messages
        WHERE dismissed_at IS NULL
          AND archived_at IS NULL
          AND (expires_at IS NULL OR expires_at = '' OR datetime(expires_at) > datetime('now'))
    `;
    if (lane) {
        sql += ' AND lane = ?';
        params.push(lane);
    }
    sql += ' ORDER BY datetime(posted_at) DESC LIMIT ?';
    params.push(Math.max(limit, 1));

    const rows = db.all(sql, ...params)
        .filter((row) => isActiveRow(row))
        .map(normalizeRow);

    if (!zone) return rows.slice(0, limit);
    return filterMessagesForViewer(rows, { zone }).slice(0, limit);
}

/** Store-wide (empty/General) visible to all; zone-specific rows need a matching viewer zone. */
function filterMessagesForViewer(rows, { zone = null, showAll = false } = {}) {
    if (showAll) return rows || [];
    return (rows || []).filter((row) => {
        const z = row.zone || '';
        if (!z || z === 'General') return true;
        if (!zone) return false;
        return z === zone;
    });
}

function dismissHumanPinned(db, by) {
    db.run(
        `UPDATE comms_messages
         SET dismissed_at = ?, dismissed_by = ?
         WHERE lane = 'pinned' AND source = 'human'
           AND dismissed_at IS NULL AND archived_at IS NULL`,
        nowIso(),
        by,
    );
}

function insertMessage(db, {
    lane,
    body,
    priority = 'info',
    source = 'human',
    posted_by,
    posted_at = nowIso(),
    expires_at = null,
    zone = '',
    dedupe_key = '',
    meta = {},
    replaceHumanPin = true,
}) {
    const trimmed = String(body || '').trim();
    if (!trimmed) throw Object.assign(new Error('Message body is required.'), { status: 400 });
    if (!LANES.includes(lane)) throw Object.assign(new Error('Invalid lane.'), { status: 400 });
    const pri = PRIORITIES.includes(priority) ? priority : 'info';

    if (dedupe_key) {
        // Respect human (or auto) dismiss: do not recreate the same key until
        // the row is archived (EOD, or when the condition clears below).
        const existing = db.get(
            `SELECT msg_id, dismissed_at FROM comms_messages
             WHERE dedupe_key = ? AND archived_at IS NULL
             ORDER BY posted_at DESC LIMIT 1`,
            dedupe_key,
        );
        if (existing) {
            if (existing.dismissed_at) return existing.msg_id;
            db.run(
                `UPDATE comms_messages
                 SET body = ?, priority = ?, posted_at = ?, expires_at = ?, meta_json = ?
                 WHERE msg_id = ?`,
                trimmed,
                pri,
                posted_at,
                expires_at,
                JSON.stringify(meta || {}),
                existing.msg_id,
            );
            return existing.msg_id;
        }
    }

    if (lane === 'pinned' && source === 'human' && replaceHumanPin) {
        dismissHumanPinned(db, posted_by);
    }

    const msgId = genMsgId();
    db.run(
        `INSERT INTO comms_messages (
            msg_id, lane, body, priority, source, posted_by, posted_at, expires_at,
            zone, dedupe_key, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        msgId,
        lane,
        trimmed,
        pri,
        source,
        posted_by,
        posted_at,
        expires_at,
        zone || '',
        dedupe_key || '',
        JSON.stringify(meta || {}),
    );
    return msgId;
}

function dismissMessage(db, msgId, by) {
    const row = db.get('SELECT msg_id FROM comms_messages WHERE msg_id = ?', msgId);
    if (!row) throw Object.assign(new Error('Message not found.'), { status: 404 });
    db.run(
        'UPDATE comms_messages SET dismissed_at = ?, dismissed_by = ? WHERE msg_id = ?',
        nowIso(),
        by,
        msgId,
    );
}

function promoteToPinned(db, msgId, by) {
    const row = db.get('SELECT * FROM comms_messages WHERE msg_id = ?', msgId);
    if (!row || !isActiveRow(row)) throw Object.assign(new Error('Message not found.'), { status: 404 });
    dismissHumanPinned(db, by);
    const priority = row.priority === 'info' ? 'warn' : row.priority;
    db.run(
        `UPDATE comms_messages
         SET lane = 'pinned', priority = ?, posted_at = ?, source = 'human', posted_by = ?
         WHERE msg_id = ?`,
        priority,
        nowIso(),
        by,
        msgId,
    );
}

function clearLane(db, lane, by) {
    if (!LANES.includes(lane)) throw Object.assign(new Error('Invalid lane.'), { status: 400 });
    db.run(
        `UPDATE comms_messages
         SET dismissed_at = ?, dismissed_by = ?
         WHERE lane = ? AND dismissed_at IS NULL AND archived_at IS NULL`,
        nowIso(),
        by,
        lane,
    );
}

function expiresAtFromHours(hours) {
    const n = Number(hours);
    if (!Number.isFinite(n) || n <= 0) return null;
    return new Date(Date.now() + n * 3600000).toISOString();
}

function collectSystemMessageSpecs(db, ctx) {
    const {
        settings = {},
        storeDate,
        storeWeekday,
        storeTime,
        kpis = {},
    } = ctx;
    const specs = [];

    const rhythm = rhythmNotLoadedBy630(db, storeDate, storeTime, storeWeekday);
    if (rhythm) {
        specs.push({
            lane: 'feed',
            body: rhythm.detail,
            priority: 'warn',
            dedupe_key: `system:rhythm-not-loaded:${storeDate}`,
            meta: { kind: 'rhythm_not_loaded' },
        });
    }

    const orderStart = settings.Order_Start || '';
    const orderEnd = settings.Order_End || '';
    if (orderStart && !orderEnd) {
        specs.push({
            lane: 'feed',
            body: `Order clock running — ${kpis.order_staff || kpis.staff || 1} staff on order`,
            priority: 'info',
            dedupe_key: `system:order-running:${storeDate}`,
            meta: { kind: 'order_running' },
        });
    }

    if (orderStart && orderEnd && wasTgpOrderDay(db, storeWeekday)) {
        specs.push({
            lane: 'feed',
            body: `Order finished today — ${Number(kpis.g || 0) + Number(kpis.f || 0)} pieces on board`,
            priority: 'info',
            dedupe_key: `system:order-finished:${storeDate}`,
            meta: { kind: 'order_finished' },
            expires_at: expiresAtFromHours(12),
        });
    }

    // NOTE: the "DOCK: … on receiving" ticker was intentionally removed.
    // Staff check vendors in/out themselves, so an on-dock banner is just
    // noise; arrivals are already visible in the receiving list.

    const pullToday = db.get(`
        SELECT COUNT(*) as c FROM kill_dates
        WHERE status = 'Active' AND kill_date <= ?
    `, storeDate)?.c ?? 0;
    if (pullToday > 0) {
        specs.push({
            lane: 'feed',
            body: `${pullToday} expiry item${pullToday === 1 ? '' : 's'} PULL TODAY — see manager hub pull list`,
            priority: 'urgent',
            dedupe_key: `system:pull-today:${storeDate}`,
            meta: { kind: 'pull_today', count: pullToday },
        });
    }

    // OOS/hole counts are manager-report-only. Do not generate floor-facing
    // comms messages from OOS volume; keep OOS signal in Reports/Manager Hub.

    return specs;
}

function syncSystemMessages(db, ctx) {
    if (!isSystemMessagesEnabled(ctx.settings)) return;
    if (!isMessageCenterEnabled(ctx.settings)) return;
    const specs = collectSystemMessageSpecs(db, ctx);
    specs.forEach((spec) => {
        insertMessage(db, {
            ...spec,
            source: 'system',
            posted_by: 'SYSTEM',
            replaceHumanPin: false,
        });
    });
    retractClearedSystemMessages(db, ctx.storeDate, specs);
}

/**
 * Auto-dismiss system messages whose condition no longer holds.
 *
 * System banners (rhythm-not-loaded, order-running, oos-surge, …) are
 * (re)posted while their condition is true but were previously never taken
 * down once it cleared — so e.g. a "rhythm not loaded" warning would linger
 * all day after the rhythm was actually loaded. This reconciles the active
 * system messages against the specs the current sync produced and dismisses
 * any that are no longer being generated.
 *
 * Scope is limited to the current store date's `system:*:<storeDate>` keys so
 * we never touch human messages or prior-day archives.
 */
function retractClearedSystemMessages(db, storeDate, specs) {
    const activeKeys = new Set((specs || []).map((s) => s.dedupe_key).filter(Boolean));
    const rows = db.all(
        `SELECT msg_id, dedupe_key, dismissed_at FROM comms_messages
         WHERE source = 'system' AND archived_at IS NULL
           AND dedupe_key LIKE 'system:%'`,
    );
    const now = nowIso();
    rows.forEach((row) => {
        const key = row.dedupe_key || '';
        if (storeDate && !key.endsWith(`:${storeDate}`)) return; // only manage today's keys
        if (activeKeys.has(key)) return;                          // condition still true → keep
        if (row.dismissed_at) {
            // Already dismissed (often by a human). Archive so a later same-day
            // re-trigger of this condition can post a fresh message.
            db.run(
                'UPDATE comms_messages SET archived_at = ? WHERE msg_id = ?',
                now,
                row.msg_id,
            );
            return;
        }
        db.run(
            'UPDATE comms_messages SET dismissed_at = ?, dismissed_by = ? WHERE msg_id = ?',
            now,
            'SYSTEM',
            row.msg_id,
        );
    });
}

function archiveCommsForEod(db, storeDate) {
    const active = db.all(`
        SELECT * FROM comms_messages
        WHERE dismissed_at IS NULL AND archived_at IS NULL
    `);
    if (active.length) {
        db.run(
            'INSERT INTO comms_handoff_archive (store_date, archived_at, payload_json) VALUES (?, ?, ?)',
            storeDate,
            nowIso(),
            JSON.stringify(active.map(normalizeRow)),
        );
        db.run(
            'UPDATE comms_messages SET archived_at = ? WHERE dismissed_at IS NULL AND archived_at IS NULL',
            nowIso(),
        );
    }
    db.run('DELETE FROM ticker');
    db.run("UPDATE settings SET setting_value = '' WHERE setting_name = 'Shift_Notes'");
    db.run("UPDATE settings SET setting_value = '0' WHERE setting_name = 'Critical_Alert'");
}

function buildLegacyTicker(db) {
    return db.all('SELECT msg_id, message FROM ticker');
}

function buildCommsSyncPayload(db, settings, ctx) {
    if (!isMessageCenterEnabled(settings)) {
        return {
            enabled: false,
            legacy_ticker: buildLegacyTicker(db),
        };
    }

    syncSystemMessages(db, { ...ctx, settings });

    const pinned = listActiveMessages(db, { lane: 'pinned', limit: 3 });
    const ticker = listActiveMessages(db, { lane: 'ticker', limit: 24 });
    const feed = listActiveMessages(db, { lane: 'feed', limit: 24 });

    return {
        enabled: true,
        system_messages: isSystemMessagesEnabled(settings),
        pinned,
        ticker,
        feed,
    };
}

function mapTickerForLegacyClients(commsPayload) {
    if (!commsPayload?.enabled) return [];
    return (commsPayload.ticker || []).map((row) => ({
        msg_id: row.msg_id,
        message: row.body,
    }));
}

function getHandoffForReportDate(db, reportDate) {
    const row = db.get(
        'SELECT * FROM comms_handoff_archive WHERE store_date = ? ORDER BY id DESC LIMIT 1',
        reportDate,
    );
    if (!row) return null;
    let messages = [];
    try {
        messages = JSON.parse(row.payload_json || '[]');
    } catch (_) { /* ignore */ }
    return {
        store_date: row.store_date,
        archived_at: row.archived_at,
        messages,
    };
}

const { isManagerRole } = require('./staff-permissions.cjs');

function hasCommsPermission(db, session) {
    if (!session) return false;
    if (isManagerRole(session.role)) return true;
    if (session.role === 'TV') return false;
    const row = db.get('SELECT permissions FROM staff WHERE name = ?', session.name);
    const perms = String(row?.permissions || '').split(',').map((s) => s.trim());
    return perms.includes('comms');
}

module.exports = {
    LANES,
    PRIORITIES,
    isMessageCenterEnabled,
    isSystemMessagesEnabled,
    listActiveMessages,
    filterMessagesForViewer,
    insertMessage,
    dismissMessage,
    promoteToPinned,
    clearLane,
    expiresAtFromHours,
    collectSystemMessageSpecs,
    syncSystemMessages,
    retractClearedSystemMessages,
    archiveCommsForEod,
    buildCommsSyncPayload,
    mapTickerForLegacyClients,
    getHandoffForReportDate,
    hasCommsPermission,
    normalizeRow,
};
