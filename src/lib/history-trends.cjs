'use strict';

const { HUMAN_CLOSED_TASK_FILTER } = require('./rhythm-task-expand.cjs');
const { computeArchivedOrderMetrics } = require('./shift-metrics.cjs');
const { getStoreMeta } = require('../constants/store-meta.cjs');
const { normalizeStoreTimezone } = require('./store-timezone.cjs');
const { createStoreTimeAccessors, sqliteTzOffsetModifier } = require('./store-time.cjs');

const SNAPSHOT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS daily_report_snapshots (
    store_date TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,

    tasks_created INTEGER NOT NULL DEFAULT 0,
    tasks_closed INTEGER NOT NULL DEFAULT 0,
    tasks_open_end_of_day INTEGER NOT NULL DEFAULT 0,
    urgent_tasks_created INTEGER NOT NULL DEFAULT 0,
    urgent_tasks_closed INTEGER NOT NULL DEFAULT 0,

    oos_opened INTEGER NOT NULL DEFAULT 0,
    oos_closed INTEGER NOT NULL DEFAULT 0,
    oos_open_end_of_day INTEGER NOT NULL DEFAULT 0,

    outdated_item_logs INTEGER NOT NULL DEFAULT 0,
    outdated_item_value REAL NOT NULL DEFAULT 0,
    expiry_pull_logs INTEGER NOT NULL DEFAULT 0,
    expiry_due_count INTEGER NOT NULL DEFAULT 0,

    expected_orders_count INTEGER NOT NULL DEFAULT 0,
    received_orders_count INTEGER NOT NULL DEFAULT 0,
    special_orders_count INTEGER NOT NULL DEFAULT 0,

    order_pieces INTEGER NOT NULL DEFAULT 0,
    order_minutes INTEGER NOT NULL DEFAULT 0,
    order_staff_count INTEGER NOT NULL DEFAULT 0,
    team_pph REAL,
    adjusted_pph REAL,

    daily_direction_posted INTEGER NOT NULL DEFAULT 0,
    shift_updates_posted INTEGER NOT NULL DEFAULT 0,

    manager_on_duty TEXT,
    snapshot_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_daily_report_snapshots_date ON daily_report_snapshots(store_date DESC);
`;

const EXPORT_TABLES = [
    'tasks',
    'oos',
    'special_orders',
    'expected_orders',
    'kill_dates',
    'shrink_log',
    'homebase_audits',
    'shift_order_history',
    'daily_direction',
    'shift_updates',
    'daily_report_snapshots',
    'manager_audit_log',
    'safety_blurbs',
    'daily_safety_focus',
];

const DEFAULT_RETENTION_DAYS = 365;
const TREND_WINDOWS = [7, 30, 90, 180, 365];

function clampInt(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function resolveOperationalRetentionDays(settings = {}) {
    return clampInt(settings.Operational_Retention_Days, 30, 3650, DEFAULT_RETENTION_DAYS);
}

function resolveTrendWindowDays(settings = {}, requested) {
    return clampInt(requested ?? settings.Report_Trend_Window_Days, 7, 365, 90);
}

function ensureDailyReportSnapshotsSchema(db) {
    if (!db || typeof db.exec !== 'function') return false;
    db.exec(SNAPSHOT_TABLE_SQL);
    return true;
}

function addDays(dateStamp, delta) {
    const d = new Date(`${dateStamp}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
}

function dateRange(startDate, endDate) {
    const out = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) return out;
    let d = startDate;
    let guard = 0;
    while (d <= endDate && guard < 4000) {
        out.push(d);
        d = addDays(d, 1);
        guard++;
    }
    return out;
}


function resolveSnapshotSettings(db, opts = {}) {
    if (opts.settings && typeof opts.settings === 'object') return opts.settings;
    try {
        if (db && typeof db.getSettings === 'function') return db.getSettings() || {};
    } catch (_) { /* ignore */ }
    return {};
}

function resolveSnapshotDateModifier(db, opts = {}) {
    const settings = resolveSnapshotSettings(db, opts);
    try {
        const tz = normalizeStoreTimezone(getStoreMeta(settings).timezone).timezone;
        const ref = /^\d{4}-\d{2}-\d{2}$/.test(opts.storeDate || '')
            ? new Date(`${opts.storeDate}T12:00:00Z`)
            : new Date();
        const mod = sqliteTzOffsetModifier(tz, ref);
        return /^[+-]\d+ minutes$/.test(mod) && mod !== '+0 minutes' ? mod : '';
    } catch (_) {
        return '';
    }
}

const SNAPSHOT_DATE_COLUMNS = 'time_submitted|time_closed|time_logged|arrived_at|departed_at|arrival_time|timestamp';
const SNAPSHOT_DATE_RE = new RegExp(`\\b(date|datetime)\\(\\s*(${SNAPSHOT_DATE_COLUMNS})\\s*\\)`, 'gi');

function localizeSnapshotDateSql(sql, modifier) {
    if (!modifier) return sql;
    return String(sql).replace(SNAPSHOT_DATE_RE, (_m, fn, col) => `${fn}(${col}, '${modifier}')`);
}

function safeGet(db, sql, ...params) {
    try { return db.get(sql, ...params) || {}; } catch (_) { return {}; }
}

function safeAll(db, sql, ...params) {
    try { return db.all(sql, ...params) || []; } catch (_) { return []; }
}

function count(db, sql, ...params) {
    return Number(safeGet(db, sql, ...params).c || 0);
}

function sum(db, sql, ...params) {
    return Number(safeGet(db, sql, ...params).t || 0);
}

function tableExists(db, tableName) {
    return Boolean(safeGet(db, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", tableName).name);
}

function getSnapshot(db, storeDate) {
    if (!tableExists(db, 'daily_report_snapshots')) return null;
    return safeGet(db, 'SELECT * FROM daily_report_snapshots WHERE store_date=?', storeDate);
}

function normalizeSnapshot(row) {
    if (!row || !row.store_date) return null;
    const numeric = [
        'tasks_created', 'tasks_closed', 'tasks_open_end_of_day', 'urgent_tasks_created', 'urgent_tasks_closed',
        'oos_opened', 'oos_closed', 'oos_open_end_of_day',
        'outdated_item_logs', 'outdated_item_value', 'expiry_pull_logs', 'expiry_due_count',
        'expected_orders_count', 'received_orders_count', 'special_orders_count',
        'order_pieces', 'order_minutes', 'order_staff_count', 'team_pph', 'adjusted_pph',
        'daily_direction_posted', 'shift_updates_posted',
    ];
    const out = { ...row };
    numeric.forEach((k) => {
        if (out[k] === null || out[k] === undefined || out[k] === '') {
            out[k] = (k === 'team_pph' || k === 'adjusted_pph') ? null : 0;
        } else {
            out[k] = Number(out[k]);
        }
    });
    return out;
}

function buildDailyReportSnapshot(db, opts = {}) {
    const storeDate = opts.storeDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(storeDate || '')) {
        throw new Error('storeDate must be YYYY-MM-DD');
    }

    const createdAt = opts.createdAt || new Date().toISOString();
    const dateModifier = resolveSnapshotDateModifier(db, { ...opts, storeDate });
    const localSql = (sql) => localizeSnapshotDateSql(sql, dateModifier);
    const countLocal = (sql, ...params) => count(db, localSql(sql), ...params);
    const sumLocal = (sql, ...params) => sum(db, localSql(sql), ...params);

    const order = safeGet(db, `
        SELECT store_date, total_pieces, actual_order_minutes, staff_count,
               actual_pieces_per_hour, adjusted_per_person_pph
        FROM shift_order_history
        WHERE store_date=?
    `, storeDate);

    let adjustedPph = order.adjusted_per_person_pph != null ? Number(order.adjusted_per_person_pph) : null;
    if (adjustedPph == null && order.store_date) {
        const pph = computeArchivedOrderMetrics(
            Number(order.total_pieces || 0),
            Number(order.actual_order_minutes || 0),
            Math.max(1, Number(order.staff_count || 1)),
        );
        adjustedPph = pph.adjusted_per_person_pph ?? null;
    }

    const dd = safeGet(db, 'SELECT posted_at, posted_by FROM daily_direction WHERE store_date=?', storeDate);
    const shiftUpdates = count(db, 'SELECT COUNT(*) as c FROM shift_updates WHERE store_date=?', storeDate);

    const snapshot = {
        store_date: storeDate,
        created_at: createdAt,

        tasks_created: countLocal('SELECT COUNT(*) as c FROM tasks WHERE date(time_submitted)=?', storeDate),
        tasks_closed: countLocal(`SELECT COUNT(*) as c FROM tasks WHERE (status='Closed' OR status='Archived') AND ${HUMAN_CLOSED_TASK_FILTER} AND date(time_closed)=?`, storeDate),
        tasks_open_end_of_day: countLocal(`
            SELECT COUNT(*) as c FROM tasks
            WHERE date(time_submitted)<=?
              AND (time_closed IS NULL OR time_closed='' OR date(time_closed)>?)
              AND COALESCE(status,'')!='Archived'
        `, storeDate, storeDate),
        urgent_tasks_created: countLocal("SELECT COUNT(*) as c FROM tasks WHERE priority IN ('Urgent','High') AND date(time_submitted)=?", storeDate),
        urgent_tasks_closed: countLocal(`SELECT COUNT(*) as c FROM tasks WHERE priority IN ('Urgent','High') AND (status='Closed' OR status='Archived') AND ${HUMAN_CLOSED_TASK_FILTER} AND date(time_closed)=?`, storeDate),

        oos_opened: countLocal('SELECT COUNT(*) as c FROM oos WHERE date(time_logged)=?', storeDate),
        oos_closed: countLocal("SELECT COUNT(*) as c FROM oos WHERE status IN ('Closed','Archived') AND date(time_closed)=?", storeDate),
        oos_open_end_of_day: countLocal(`
            SELECT COUNT(*) as c FROM oos
            WHERE date(time_logged)<=?
              AND (time_closed IS NULL OR time_closed='' OR date(time_closed)>?)
              AND COALESCE(status,'')!='Archived'
        `, storeDate, storeDate),

        outdated_item_logs: countLocal('SELECT COUNT(*) as c FROM shrink_log WHERE date(time_logged)=?', storeDate),
        outdated_item_value: sumLocal('SELECT COALESCE(SUM(cost),0) as t FROM shrink_log WHERE date(time_logged)=?', storeDate),
        expiry_pull_logs: countLocal("SELECT COUNT(*) as c FROM kill_dates WHERE COALESCE(closed_by,'')!='' AND date(time_closed)=?", storeDate),
        expiry_due_count: countLocal('SELECT COUNT(*) as c FROM kill_dates WHERE date(kill_date)=?', storeDate),

        expected_orders_count: countLocal('SELECT COUNT(*) as c FROM expected_orders WHERE expected_day=?', storeDate),
        received_orders_count: countLocal('SELECT COUNT(*) as c FROM expected_orders WHERE date(arrived_at)=?', storeDate),
        special_orders_count: countLocal('SELECT COUNT(*) as c FROM special_orders WHERE date(time_logged)=?', storeDate),

        order_pieces: Number(order.total_pieces || 0),
        order_minutes: Number(order.actual_order_minutes || 0),
        order_staff_count: Number(order.staff_count || 0),
        team_pph: order.actual_pieces_per_hour == null ? null : Number(order.actual_pieces_per_hour),
        adjusted_pph: adjustedPph == null ? null : Number(adjustedPph),

        daily_direction_posted: dd.posted_at ? 1 : 0,
        shift_updates_posted: shiftUpdates,

        manager_on_duty: safeGet(db, "SELECT setting_value FROM settings WHERE setting_name='Active_Manager'").setting_value || '',
    };

    snapshot.snapshot_json = JSON.stringify({
        source: 'daily_report_snapshots',
        store_date: storeDate,
        created_at: createdAt,
        labels: {
            outdated_item_logs: 'Outdated item logs',
            expiry_pull_logs: 'Expiry / markdown pulls',
        },
    });

    if (opts.persist !== false && typeof db.run === 'function') {
        ensureDailyReportSnapshotsSchema(db);
        db.run(`
            INSERT INTO daily_report_snapshots (
                store_date, created_at, tasks_created, tasks_closed, tasks_open_end_of_day,
                urgent_tasks_created, urgent_tasks_closed, oos_opened, oos_closed, oos_open_end_of_day,
                outdated_item_logs, outdated_item_value, expiry_pull_logs, expiry_due_count,
                expected_orders_count, received_orders_count, special_orders_count,
                order_pieces, order_minutes, order_staff_count, team_pph, adjusted_pph,
                daily_direction_posted, shift_updates_posted, manager_on_duty, snapshot_json
            ) VALUES (
                @store_date, @created_at, @tasks_created, @tasks_closed, @tasks_open_end_of_day,
                @urgent_tasks_created, @urgent_tasks_closed, @oos_opened, @oos_closed, @oos_open_end_of_day,
                @outdated_item_logs, @outdated_item_value, @expiry_pull_logs, @expiry_due_count,
                @expected_orders_count, @received_orders_count, @special_orders_count,
                @order_pieces, @order_minutes, @order_staff_count, @team_pph, @adjusted_pph,
                @daily_direction_posted, @shift_updates_posted, @manager_on_duty, @snapshot_json
            )
            ON CONFLICT(store_date) DO UPDATE SET
                created_at=excluded.created_at,
                tasks_created=excluded.tasks_created,
                tasks_closed=excluded.tasks_closed,
                tasks_open_end_of_day=excluded.tasks_open_end_of_day,
                urgent_tasks_created=excluded.urgent_tasks_created,
                urgent_tasks_closed=excluded.urgent_tasks_closed,
                oos_opened=excluded.oos_opened,
                oos_closed=excluded.oos_closed,
                oos_open_end_of_day=excluded.oos_open_end_of_day,
                outdated_item_logs=excluded.outdated_item_logs,
                outdated_item_value=excluded.outdated_item_value,
                expiry_pull_logs=excluded.expiry_pull_logs,
                expiry_due_count=excluded.expiry_due_count,
                expected_orders_count=excluded.expected_orders_count,
                received_orders_count=excluded.received_orders_count,
                special_orders_count=excluded.special_orders_count,
                order_pieces=excluded.order_pieces,
                order_minutes=excluded.order_minutes,
                order_staff_count=excluded.order_staff_count,
                team_pph=excluded.team_pph,
                adjusted_pph=excluded.adjusted_pph,
                daily_direction_posted=excluded.daily_direction_posted,
                shift_updates_posted=excluded.shift_updates_posted,
                manager_on_duty=excluded.manager_on_duty,
                snapshot_json=excluded.snapshot_json
        `, snapshot);
    }

    return snapshot;
}

function loadOrBuildSnapshot(db, storeDate, opts = {}) {
    const existing = normalizeSnapshot(getSnapshot(db, storeDate));
    let currentStoreDate = opts.currentStoreDate || '';
    if (!currentStoreDate) {
        try {
            const settings = resolveSnapshotSettings(db, opts);
            currentStoreDate = createStoreTimeAccessors(() => settings).getStoreDateStamp();
        } catch (_) {
            currentStoreDate = '';
        }
    }
    const forceRebuild = !!(currentStoreDate && storeDate === currentStoreDate);
    if (existing && opts.preferRaw !== true && !forceRebuild) return existing;
    try {
        return normalizeSnapshot(buildDailyReportSnapshot(db, {
            storeDate,
            persist: opts.persist !== false && typeof db.run === 'function',
            createdAt: opts.createdAt,
            settings: opts.settings,
        }));
    } catch (_) {
        return existing || normalizeSnapshot({ store_date: storeDate });
    }
}

function periodRows(db, startDate, endDate, opts = {}) {
    return dateRange(startDate, endDate).map((d) => loadOrBuildSnapshot(db, d, opts)).filter(Boolean);
}

function aggregateRows(rows = []) {
    const total = (k) => rows.reduce((acc, r) => acc + Number(r?.[k] || 0), 0);
    const avgNonZero = (k) => {
        const vals = rows.map((r) => Number(r?.[k])).filter((v) => Number.isFinite(v) && v > 0);
        if (!vals.length) return null;
        return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    };
    return {
        days: rows.length,
        tasks_created: total('tasks_created'),
        tasks_closed: total('tasks_closed'),
        urgent_tasks_created: total('urgent_tasks_created'),
        urgent_tasks_closed: total('urgent_tasks_closed'),
        oos_opened: total('oos_opened'),
        oos_closed: total('oos_closed'),
        outdated_item_logs: total('outdated_item_logs'),
        outdated_item_value: Math.round(total('outdated_item_value') * 100) / 100,
        expiry_pull_logs: total('expiry_pull_logs'),
        expiry_due_count: total('expiry_due_count'),
        expected_orders_count: total('expected_orders_count'),
        received_orders_count: total('received_orders_count'),
        special_orders_count: total('special_orders_count'),
        order_pieces: total('order_pieces'),
        order_minutes: total('order_minutes'),
        order_staff_count: total('order_staff_count'),
        order_days: rows.filter((r) => Number(r.order_pieces || 0) > 0).length,
        avg_team_pph: avgNonZero('team_pph'),
        avg_adjusted_pph: avgNonZero('adjusted_pph'),
        daily_direction_posted_days: total('daily_direction_posted'),
        shift_updates_posted: total('shift_updates_posted'),
        shift_update_days: rows.filter((r) => Number(r.shift_updates_posted || 0) > 0).length,
    };
}

function pctChange(current, previous) {
    const cur = Number(current || 0);
    const prev = Number(previous || 0);
    if (!prev && !cur) return 0;
    if (!prev) return 100;
    return Math.round(((cur - prev) / prev) * 100);
}

function metricCard(key, label, current, previous, suffix = '') {
    const delta_pct = pctChange(current, previous);
    return {
        key,
        label,
        current,
        previous,
        delta_pct,
        direction: delta_pct > 0 ? 'up' : (delta_pct < 0 ? 'down' : 'flat'),
        suffix,
    };
}

function weekdayName(storeDate) {
    const d = new Date(`${storeDate}T12:00:00Z`);
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

function strongestWeekday(rows, field) {
    const buckets = {};
    rows.forEach((r) => {
        const v = Number(r?.[field] || 0);
        if (!v) return;
        const w = weekdayName(r.store_date);
        buckets[w] = (buckets[w] || 0) + v;
    });
    const sorted = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
    if (!sorted.length) return null;
    return { weekday: sorted[0][0], value: sorted[0][1] };
}

function buildInsights(current, previous, rows, windowDays) {
    const insights = [];
    const add = (severity, title, detail, metric) => insights.push({ severity, title, detail, metric });

    const taskDelta = pctChange(current.tasks_created, previous.tasks_created);
    if (Math.abs(taskDelta) >= 15) {
        add(taskDelta > 0 ? 'warn' : 'ok',
            `Task volume ${taskDelta > 0 ? 'up' : 'down'} ${Math.abs(taskDelta)}%`,
            `Current ${windowDays} days: ${current.tasks_created}; previous period: ${previous.tasks_created}.`,
            'tasks_created');
    }

    if (current.oos_opened > current.oos_closed + 3) {
        add('warn',
            'OOS opened faster than it closed',
            `${current.oos_opened} opened vs ${current.oos_closed} closed in the current window.`,
            'oos');
    } else if (current.oos_opened || current.oos_closed) {
        add('ok',
            'OOS closure pace looks controlled',
            `${current.oos_opened} opened vs ${current.oos_closed} closed in the current window.`,
            'oos');
    }

    const outdatedDelta = pctChange(current.outdated_item_logs, previous.outdated_item_logs);
    if (current.outdated_item_logs && Math.abs(outdatedDelta) >= 20) {
        add(outdatedDelta > 0 ? 'warn' : 'ok',
            `Outdated item logs ${outdatedDelta > 0 ? 'up' : 'down'} ${Math.abs(outdatedDelta)}%`,
            `Current ${windowDays} days: ${current.outdated_item_logs}; previous period: ${previous.outdated_item_logs}.`,
            'outdated_items');
    }

    const expiryDay = strongestWeekday(rows, 'expiry_pull_logs') || strongestWeekday(rows, 'outdated_item_logs');
    if (expiryDay) {
        add('info',
            `Outdated/expiry work clusters on ${expiryDay.weekday}`,
            `${expiryDay.value} logged pull/outdated records in the current window.`,
            'expiry_weekday');
    }

    if (current.avg_adjusted_pph != null && previous.avg_adjusted_pph != null) {
        const pphDelta = pctChange(current.avg_adjusted_pph, previous.avg_adjusted_pph);
        if (Math.abs(pphDelta) >= 8) {
            add(pphDelta < 0 ? 'warn' : 'ok',
                `Order adjusted PPH ${pphDelta < 0 ? 'down' : 'up'} ${Math.abs(pphDelta)}%`,
                `Current average ${current.avg_adjusted_pph}; previous average ${previous.avg_adjusted_pph}.`,
                'adjusted_pph');
        }
    }

    const ddRate = current.days ? Math.round((current.daily_direction_posted_days / current.days) * 100) : 0;
    if (current.days && ddRate < 80) {
        add('warn',
            'Daily Direction posting is inconsistent',
            `Posted ${current.daily_direction_posted_days} of ${current.days} report days (${ddRate}%).`,
            'daily_direction');
    } else if (current.days) {
        add('ok',
            'Daily Direction consistency is strong',
            `Posted ${current.daily_direction_posted_days} of ${current.days} report days (${ddRate}%).`,
            'daily_direction');
    }

    if (current.days && current.shift_update_days < Math.max(1, Math.round(current.days * 0.25))) {
        add('info',
            'Shift Updates are lightly used',
            `${current.shift_updates_posted} updates across ${current.shift_update_days} of ${current.days} days.`,
            'shift_updates');
    }

    if (!insights.length) {
        add('info',
            'No strong trend signal yet',
            'Keep running daily reports; insights become more useful as the snapshot history fills in.',
            'baseline');
    }

    return insights.slice(0, 8);
}

function compactDailyRows(rows) {
    return rows.map((r) => ({
        store_date: r.store_date,
        tasks_created: r.tasks_created,
        tasks_closed: r.tasks_closed,
        oos_opened: r.oos_opened,
        oos_closed: r.oos_closed,
        outdated_item_logs: r.outdated_item_logs,
        expiry_pull_logs: r.expiry_pull_logs,
        order_pieces: r.order_pieces,
        adjusted_pph: r.adjusted_pph,
        daily_direction_posted: r.daily_direction_posted,
        shift_updates_posted: r.shift_updates_posted,
        manager_on_duty: r.manager_on_duty || '',
    }));
}

function buildTrendsAndInsights(db, opts = {}) {
    const settings = opts.settings || (db.getSettings ? db.getSettings() : {});
    const endDate = opts.endDate;
    const windowDays = resolveTrendWindowDays(settings, opts.windowDays);
    const startDate = addDays(endDate, -(windowDays - 1));
    const previousEnd = addDays(startDate, -1);
    const previousStart = addDays(previousEnd, -(windowDays - 1));
    const persist = opts.persist !== false && typeof db.run === 'function';

    if (persist) ensureDailyReportSnapshotsSchema(db);

    const currentRows = periodRows(db, startDate, endDate, { persist });
    const previousRows = periodRows(db, previousStart, previousEnd, { persist });
    const current = aggregateRows(currentRows);
    const previous = aggregateRows(previousRows);

    const cards = [
        metricCard('tasks_created', 'Tasks Created', current.tasks_created, previous.tasks_created),
        metricCard('tasks_closed', 'Tasks Closed', current.tasks_closed, previous.tasks_closed),
        metricCard('oos_opened', 'OOS Opened', current.oos_opened, previous.oos_opened),
        metricCard('oos_closed', 'OOS Closed', current.oos_closed, previous.oos_closed),
        metricCard('outdated_item_logs', 'Outdated Items', current.outdated_item_logs, previous.outdated_item_logs),
        metricCard('expiry_pull_logs', 'Expiry Pulls', current.expiry_pull_logs, previous.expiry_pull_logs),
        metricCard('order_pieces', 'Order Pieces', current.order_pieces, previous.order_pieces),
        metricCard('avg_adjusted_pph', 'Avg Adj PPH', current.avg_adjusted_pph, previous.avg_adjusted_pph),
        metricCard('daily_direction_posted_days', 'Direction Days', current.daily_direction_posted_days, previous.daily_direction_posted_days),
        metricCard('shift_updates_posted', 'Shift Updates', current.shift_updates_posted, previous.shift_updates_posted),
    ];

    return {
        window_days: windowDays,
        start_date: startDate,
        end_date: endDate,
        previous_start_date: previousStart,
        previous_end_date: previousEnd,
        current,
        previous,
        cards,
        insights: buildInsights(current, previous, currentRows, windowDays),
        daily_rows: compactDailyRows(currentRows).slice(-120),
        labels: {
            outdated_item_logs: 'Outdated Items',
            expiry_pull_logs: 'Expiry / Markdown Pulls',
        },
    };
}

function csvCell(value) {
    const s = String(value === null || value === undefined ? '' : value);
    if (/^[=+\-@]/.test(s)) return `"'${s.replace(/"/g, '""')}"`;
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function snapshotsToCsv(rows = []) {
    const headers = [
        'store_date', 'tasks_created', 'tasks_closed', 'urgent_tasks_created', 'urgent_tasks_closed',
        'oos_opened', 'oos_closed', 'outdated_item_logs', 'outdated_item_value',
        'expiry_pull_logs', 'expiry_due_count', 'expected_orders_count', 'received_orders_count',
        'special_orders_count', 'order_pieces', 'order_minutes', 'order_staff_count',
        'team_pph', 'adjusted_pph', 'daily_direction_posted', 'shift_updates_posted', 'manager_on_duty',
    ];
    return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n');
}

function buildTrendCsv(db, opts = {}) {
    const endDate = opts.endDate;
    const days = clampInt(opts.days, 7, 3650, 90);
    const startDate = addDays(endDate, -(days - 1));
    const rows = periodRows(db, startDate, endDate, {
        persist: opts.persist !== false && typeof db.run === 'function',
        settings: opts.settings,
    });
    return snapshotsToCsv(rows);
}

function backfillDailyReportSnapshots(db, opts = {}) {
    if (!db || typeof db.run !== 'function') return { ok: false, error: 'Writable db required.' };
    ensureDailyReportSnapshotsSchema(db);
    const endDate = opts.endDate || new Date().toISOString().slice(0, 10);
    const days = clampInt(opts.days, 1, 3650, 365);
    const startDate = opts.startDate || addDays(endDate, -(days - 1));
    const dates = dateRange(startDate, endDate);
    let created = 0;
    const errors = [];
    dates.forEach((d) => {
        try {
            buildDailyReportSnapshot(db, { storeDate: d, persist: true, settings: opts.settings });
            created++;
        } catch (e) {
            errors.push({ store_date: d, error: e.message });
        }
    });
    return { ok: errors.length === 0, start_date: startDate, end_date: endDate, snapshots: created, errors };
}

module.exports = {
    DEFAULT_RETENTION_DAYS,
    TREND_WINDOWS,
    EXPORT_TABLES,
    SNAPSHOT_TABLE_SQL,
    ensureDailyReportSnapshotsSchema,
    resolveOperationalRetentionDays,
    resolveTrendWindowDays,
    addDays,
    dateRange,
    localizeSnapshotDateSql,
    resolveSnapshotDateModifier,
    buildDailyReportSnapshot,
    backfillDailyReportSnapshots,
    buildTrendsAndInsights,
    buildTrendCsv,
    snapshotsToCsv,
};
