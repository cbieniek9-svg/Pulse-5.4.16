'use strict';

/**
 * Browse / search the full kill_dates history (Active + Closed + Archived + Deleted).
 * Sync only ships Active rows; this is how staff check for double-entry before logging FIFO.
 */

const VALID_STATUSES = new Set(['Active', 'Closed', 'Archived', 'Deleted', 'all', 'archived']);

function normalizeQuery(raw) {
    return String(raw || '').trim().toLowerCase();
}

function normalizeStatusFilter(raw) {
    const s = String(raw || 'all').trim();
    if (!VALID_STATUSES.has(s)) return 'all';
    return s;
}

/**
 * @param {object} db
 * @param {{ q?: string, zone?: string, status?: string, limit?: number, offset?: number }} opts
 */
function listMarkdownArchive(db, opts = {}) {
    const q = normalizeQuery(opts.q);
    const zone = String(opts.zone || '').trim();
    const status = normalizeStatusFilter(opts.status);
    let limit = parseInt(opts.limit, 10);
    if (!Number.isFinite(limit) || limit < 1) limit = 200;
    if (limit > 500) limit = 500;
    let offset = parseInt(opts.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const where = [];
    const params = [];

    if (status === 'archived') {
        where.push("status != 'Active'");
    } else if (status !== 'all') {
        where.push('status = ?');
        params.push(status);
    }

    if (zone) {
        where.push('zone = ?');
        params.push(zone);
    }

    if (q) {
        where.push('(LOWER(COALESCE(item,\'\')) LIKE ? OR LOWER(COALESCE(item_code,\'\')) LIKE ? OR LOWER(COALESCE(logged_by,\'\')) LIKE ?)');
        const like = `%${q}%`;
        params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.get(`SELECT COUNT(*) AS c FROM kill_dates ${whereSql}`, ...params)?.c ?? 0;
    const rows = db.all(
        `SELECT id, item, item_code, kill_date, zone, status, logged_by, closed_by, time_closed, quantity
           FROM kill_dates
           ${whereSql}
          ORDER BY
            CASE status WHEN 'Active' THEN 0 WHEN 'Closed' THEN 1 WHEN 'Archived' THEN 2 ELSE 3 END,
            kill_date DESC,
            item ASC
          LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
    );

    const counts = {
        Active: 0,
        Closed: 0,
        Archived: 0,
        Deleted: 0,
    };
    (db.all('SELECT status, COUNT(*) AS c FROM kill_dates GROUP BY status') || []).forEach((r) => {
        const key = String(r.status || '');
        if (Object.prototype.hasOwnProperty.call(counts, key)) counts[key] = r.c;
        else counts[key] = r.c;
    });

    return {
        rows,
        total,
        limit,
        offset,
        counts,
        filters: { q, zone, status },
    };
}

/**
 * Find existing rows that would make a new FIFO entry a likely double.
 * Match priority: exact item_code (preferred), else item+zone.
 *
 * @param {object} db
 * @param {{ item_code?: string, item?: string, zone?: string, kill_date?: string }} candidate
 */
function findMarkdownDuplicates(db, candidate = {}) {
    const code = String(candidate.item_code || '').trim().toLowerCase();
    const item = String(candidate.item || '').trim().toLowerCase();
    const zone = String(candidate.zone || '').trim();
    const killDate = String(candidate.kill_date || '').trim();

    if (!code && !item) return { matches: [], active: [], archived: [] };

    let rows = [];
    if (code) {
        rows = db.all(
            `SELECT id, item, item_code, kill_date, zone, status, logged_by, closed_by, time_closed, quantity
               FROM kill_dates
              WHERE LOWER(TRIM(COALESCE(item_code,''))) = ?
              ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, kill_date DESC
              LIMIT 40`,
            code,
        ) || [];
    } else if (item) {
        rows = db.all(
            `SELECT id, item, item_code, kill_date, zone, status, logged_by, closed_by, time_closed, quantity
               FROM kill_dates
              WHERE LOWER(TRIM(COALESCE(item,''))) = ?
                AND (? = '' OR zone = ?)
              ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, kill_date DESC
              LIMIT 40`,
            item,
            zone,
            zone,
        ) || [];
    }

    const active = rows.filter((r) => r.status === 'Active');
    const archived = rows.filter((r) => r.status !== 'Active');
    const sameDate = killDate
        ? rows.filter((r) => String(r.kill_date || '') === killDate)
        : [];

    return {
        matches: rows,
        active,
        archived,
        same_date: sameDate,
        risk: active.length ? 'active' : (sameDate.length ? 'same_date' : (archived.length ? 'archived' : 'none')),
    };
}

module.exports = {
    listMarkdownArchive,
    findMarkdownDuplicates,
    normalizeStatusFilter,
};
