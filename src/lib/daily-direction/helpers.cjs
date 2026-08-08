'use strict';

const { weekdayNameFromDateStamp } = require('../store-time.cjs');

const STATUS_COLORS = Object.freeze({ green: '#0f8', yellow: '#fa0', red: '#f44' });
const WALK_NOTE_FLAGS = Object.freeze([
    'staffing_gap',
    'floor_rough',
    'receiving_backup',
    'cs_pressure',
    'morale_issue',
    'visual_urgent',
]);

const WEEKDAY_NAMES = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const TGP_ORDER_WEEKDAYS = Object.freeze(new Set(['Sunday', 'Tuesday', 'Thursday']));

function normalizeWeekdayName(value) {
    const raw = String(value || '').trim().toLowerCase();
    return WEEKDAY_NAMES.find((day) => day.toLowerCase() === raw) || '';
}

function weekdayNameFromStoreDate(storeDate) {
    return weekdayNameFromDateStamp(storeDate);
}

function resolveTgpOrderWeekday({ storeDate, storeWeekday } = {}) {
    return normalizeWeekdayName(storeWeekday) || weekdayNameFromStoreDate(storeDate);
}

function isTgpOrderWeekday(value) {
    return TGP_ORDER_WEEKDAYS.has(normalizeWeekdayName(value));
}

function nowIso() {
    return new Date().toISOString();
}

function parseJson(raw, fallback) {
    try {
        const v = JSON.parse(raw || '');
        return v == null ? fallback : v;
    } catch (_) {
        return fallback;
    }
}

function normalizeStatusOverride(value) {
    const v = String(value || '').trim().toLowerCase();
    return ['green', 'yellow', 'red'].includes(v) ? v : '';
}

function datePart(value) {
    const raw = String(value || '').trim();
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return '';
    return new Date(parsed).toISOString().slice(0, 10);
}

function riskId(risk) {
    return `${risk.kind}:${String(risk.detail || risk.title || '').slice(0, 80)}`;
}

function severityFromException(ex) {
    const urgentKinds = new Set(['missing_finish', 'pull', 'task']);
    if (urgentKinds.has(ex.kind)) return 'urgent';
    if (ex.kind === 'pph' || ex.kind === 'zone' || ex.kind === 'scorecard_outlier') return 'warn';
    return 'info';
}

function deriveDayStatus(risks) {
    const visible = (risks || []).filter(Boolean);
    if (!visible.length) return 'green';
    const urgent = visible.filter((r) => r.severity === 'urgent');
    if (urgent.some((r) => r.kind === 'missing_finish')) return 'red';
    if (urgent.length >= 3) return 'red';
    if (urgent.filter((r) => r.kind === 'pull').length >= 2) return 'red';
    if (urgent.length > 0 || visible.some((r) => r.severity === 'warn')) return 'yellow';
    return 'yellow';
}

function statusColor(status) {
    return STATUS_COLORS[status] || STATUS_COLORS.yellow;
}

function normalizeDailyDirectionFloorMessage(message, status) {
    const text = String(message || '').trim();
    const normalizedStatus = ['green', 'yellow', 'red'].includes(String(status || '').toLowerCase())
        ? String(status).toLowerCase()
        : 'yellow';
    if (!text) return text;
    return text.replace(/^TODAY:\s*(GREEN|YELLOW|RED)\b/i, `TODAY: ${normalizedStatus.toUpperCase()}`);
}

function normalizeDefaultOrderDayLabel(message, isOrderDay) {
    let text = String(message || '');
    const desired = isOrderDay ? 'TGP Order Day' : 'Non-TGP Day';
    const stale = isOrderDay ? 'Non-TGP Day' : 'TGP Order Day';
    text = text.replace(new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), desired);
    text = text.replace(/\(\s*([^)·\n]+?)\s*·\s*(?:TGP Order Day|Non-TGP Day)\s*\)/i, `($1 · ${desired})`);
    return text;
}

function loadDailyDirectionRow(db, storeDate) {
    try {
        return db.get('SELECT * FROM daily_direction WHERE store_date = ?', storeDate) || null;
    } catch (_) {
        return null;
    }
}

function emptyWalkNotes() {
    return {
        free_text: '',
        flags: Object.fromEntries(WALK_NOTE_FLAGS.map((k) => [k, false])),
    };
}

function isTgpVendorName(value) {
    const v = String(value || '').trim();
    return /^(TGP|THE\s+GROCERY\s+PEOPLE)\b/i.test(v);
}

function safeAll(db, sql, ...params) {
    try {
        if (!db || typeof db.all !== 'function') return [];
        const rows = db.all(sql, ...params);
        return Array.isArray(rows) ? rows : [];
    } catch (_) {
        return [];
    }
}

function safeGet(db, sql, ...params) {
    try {
        if (!db || typeof db.get !== 'function') return null;
        return db.get(sql, ...params) || null;
    } catch (_) {
        return null;
    }
}

function normalizeMustWin(win) {
    if (typeof win === 'string') {
        return { text: win, owner: '', source_risk_id: '', task_id: '' };
    }
    return {
        text: String(win?.text || '').slice(0, 200),
        owner: String(win?.owner || '').slice(0, 40),
        source_risk_id: String(win?.source_risk_id || ''),
        task_id: String(win?.task_id || ''),
    };
}

module.exports = {
    STATUS_COLORS,
    WALK_NOTE_FLAGS,
    WEEKDAY_NAMES,
    TGP_ORDER_WEEKDAYS,
    normalizeWeekdayName,
    weekdayNameFromStoreDate,
    resolveTgpOrderWeekday,
    isTgpOrderWeekday,
    nowIso,
    parseJson,
    normalizeStatusOverride,
    datePart,
    riskId,
    severityFromException,
    deriveDayStatus,
    statusColor,
    normalizeDailyDirectionFloorMessage,
    normalizeDefaultOrderDayLabel,
    loadDailyDirectionRow,
    emptyWalkNotes,
    isTgpVendorName,
    safeAll,
    safeGet,
    normalizeMustWin,
};
