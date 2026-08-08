'use strict';

const { WEEKDAY_NAMES, weekdayFromStoreDate } = require('./order-weekly-scorecard.cjs');
const {
    classifyShift,
    DEFAULT_SCHEDULE_ROLE_RULES,
    VALID_BUCKETS,
    RHYTHM_ASSIGN_BUCKETS,
} = require('./schedule-role-buckets.cjs');
const {
    attachStaffNameAliases,
    isStaffAliasIgnoredForSchedule,
    loadStaffNameAliases,
    normalizeStaffKey,
    resolveStaffAlias,
} = require('./staff-name-aliases.cjs');
const { sqliteTzOffsetModifier, DEFAULT_TZ } = require('./store-time.cjs');

function readStoreTimezone(db) {
    try {
        if (typeof db.getSettings === 'function') {
            const tz = db.getSettings()?.Store_Timezone;
            if (tz) return String(tz);
        }
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name = ?', 'Store_Timezone');
        return row?.setting_value || DEFAULT_TZ;
    } catch (_) {
        return DEFAULT_TZ;
    }
}

function readSetting(db, name) {
    const row = db.get('SELECT setting_value FROM settings WHERE setting_name = ?', name);
    return row?.setting_value || '';
}

function normKey(s) {
    return normalizeStaffKey(s);
}

function isDirectoryPremium(staffRow) {
    if (!staffRow) return false;
    const role = String(staffRow.role || '').trim();
    if (role === 'Premium Clerk') return true;
    if (role === 'Store Manager') return false;
    if (role === 'Manager' && staffRow.shift_lead_eligible !== 0) return true;
    return false;
}

/** Minutes since midnight from schedule start_time (HH:MM or h:mm AM/PM). */
function parseShiftMinutes(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const ampm = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (ampm) {
        let h = parseInt(ampm[1], 10);
        const m = parseInt(ampm[2], 10);
        const ap = ampm[3].toUpperCase();
        if (ap === 'PM' && h < 12) h += 12;
        if (ap === 'AM' && h === 12) h = 0;
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return h * 60 + m;
    }
    const mil = s.match(/^(\d{1,2}):(\d{2})/);
    if (!mil) return null;
    const h = parseInt(mil[1], 10);
    const m = parseInt(mil[2], 10);
    if (!Number.isFinite(h) || !Number.isFinite(m) || h > 23 || m > 59) return null;
    return h * 60 + m;
}

function currentStoreMinutes(db, storeDate) {
    try {
        const tz = readStoreTimezone(db);
        const now = new Date();
        const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: tz,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        const parts = Object.fromEntries(fmt.formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
        const today = `${parts.year}-${parts.month}-${parts.day}`;
        if (storeDate && today !== storeDate) {
            // Outside store date — treat as mid-day so "started" filters stay usable in tests/off-hours.
            return 12 * 60;
        }
        const h = parseInt(parts.hour, 10);
        const m = parseInt(parts.minute, 10);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
        return h * 60 + m;
    } catch (_) {
        return null;
    }
}

/** Scheduled today as Supervisor/Premium on the grid, or premium/manager in the staff directory. */
function isScheduledShiftLeadCandidate(ctx, canonicalName) {
    if (!canonicalName || !ctx?.hasSchedule) return false;
    if (!ctx.scheduledNames.has(normKey(canonicalName))) return false;
    const bucket = ctx.staffBuckets?.[normKey(canonicalName)];
    if (bucket === 'supervisor' || bucket === 'premium') return true;
    const staffRow = ctx.directory.find((s) => normKey(s.name) === normKey(canonicalName));
    return isDirectoryPremium(staffRow);
}

function earliestByStart(ctx, names) {
    const list = (names || []).filter(Boolean);
    if (!list.length) return '';
    if (list.length === 1) return list[0];
    const scored = list.map((name) => ({
        name,
        start: ctx.staffStartMinutes?.[normKey(name)],
    }));
    scored.sort((a, b) => {
        if (a.start == null && b.start == null) return a.name.localeCompare(b.name);
        if (a.start == null) return 1;
        if (b.start == null) return -1;
        return a.start - b.start || a.name.localeCompare(b.name);
    });
    return scored[0].name;
}

function filterStarted(ctx, names, nowMinutes) {
    const list = (names || []).filter((name) => isScheduled(ctx, name));
    if (nowMinutes == null) return list;
    return list.filter((name) => {
        const start = ctx.staffStartMinutes?.[normKey(name)];
        return start == null || start <= nowMinutes;
    });
}

/**
 * Supervisor owns walks/huddles when on/already in; Premium covers when Supervisor is off or not in yet.
 */
function pickShiftLeadAssignee(ctx, opts = {}) {
    if (!ctx?.hasSchedule) return '';
    const nowMinutes = opts.nowMinutes != null ? opts.nowMinutes : ctx.nowMinutes;
    const supervisors = (ctx.buckets?.supervisor || []).filter((n) => isScheduled(ctx, n));
    const premiums = (ctx.buckets?.premium || []).filter((n) => isScheduled(ctx, n));
    const startedSup = filterStarted(ctx, supervisors, nowMinutes);
    const startedPrem = filterStarted(ctx, premiums, nowMinutes);

    const active = String(ctx.activeManager || '').trim();
    if (active && isScheduled(ctx, active)) {
        const activeKey = normKey(active);
        if (startedSup.some((n) => normKey(n) === activeKey)) return active;
        if (!startedSup.length && startedPrem.some((n) => normKey(n) === activeKey)) return active;
        if (!startedSup.length && !startedPrem.length && supervisors.some((n) => normKey(n) === activeKey)) {
            return active;
        }
    }

    if (startedSup.length) return earliestByStart(ctx, startedSup);
    if (startedPrem.length) return earliestByStart(ctx, startedPrem);
    if (supervisors.length) return earliestByStart(ctx, supervisors);
    if (premiums.length) return earliestByStart(ctx, premiums);
    return '';
}

function hashPick(list, taskKey) {
    if (!list?.length) return '';
    if (list.length === 1) return list[0];
    const s = String(taskKey || '').toLowerCase();
    let idx = 0;
    for (let i = 0; i < s.length; i += 1) idx = (idx + s.charCodeAt(i) * (i + 3)) % list.length;
    return list[idx];
}

function pickFromBucket(ctx, bucket, taskKey) {
    const list = (ctx?.buckets?.[bucket] || []).filter((name) => isScheduled(ctx, name));
    return hashPick(list, taskKey);
}

function loadStaffDirectory(db) {
    try {
        const rows = db.all('SELECT name, role, shift_lead_eligible FROM staff WHERE active = 1') || [];
        return attachStaffNameAliases(rows, loadStaffNameAliases(db));
    } catch (_) {
        return attachStaffNameAliases([], []);
    }
}

function canonicalStaffName(directory, rawName) {
    const key = normKey(rawName);
    if (!key) return '';
    const hit = directory.find((s) => normKey(s.name) === key);
    if (hit) return String(hit.name).trim();

    const alias = resolveStaffAlias(directory, rawName);
    if (alias) {
        if (alias.alias_type === 'alias') {
            const target = String(alias.target_name || '').trim();
            if (!target) return '';
            const targetHit = directory.find((s) => normKey(s.name) === normKey(target));
            return targetHit ? String(targetHit.name).trim() : target;
        }
        if (isStaffAliasIgnoredForSchedule(alias)) return '';
    }

    return String(rawName || '').trim();
}

function pickFirst(ctx, bucket) {
    const list = ctx.buckets[bucket] || [];
    return list[0] || '';
}

function weekdayNameForStoreDate(storeDate) {
    const idx = weekdayFromStoreDate(storeDate);
    return idx != null ? WEEKDAY_NAMES[idx] : '';
}

/** Skip FIFO rhythm tasks on TGP order days and while the order clock is running. */
function shouldSkipFifoRhythm(db, storeDate) {
    const weekday = weekdayNameForStoreDate(storeDate);
    if (weekday) {
        const isOrderDay = db.get(
            "SELECT 1 FROM rhythm_tasks WHERE day=? AND detail='TGP Order' LIMIT 1",
            weekday,
        );
        if (isOrderDay) return true;
    }
    const orderStart = readSetting(db, 'Order_Start');
    if (!orderStart) return false;
    const orderEnd = readSetting(db, 'Order_End');
    if (!orderEnd) return true;
    return Date.parse(orderEnd) < Date.parse(orderStart);
}

function staffBucket(ctx, name) {
    return ctx.staffBuckets?.[normKey(name)] || 'other';
}

function fifoEligibleForStaff(ctx, assignee, aisles) {
    const bucket = staffBucket(ctx, assignee);
    if (bucket === 'rec' || bucket === 'cash' || bucket === 'cs' || bucket === 'premium' || bucket === 'supervisor') {
        return false;
    }
    if (bucket === 'stock_float') return true;
    if (bucket === 'bakery') {
        return (aisles || []).every((a) => /bakery|bake/i.test(String(a || '')));
    }
    return false;
}

function buildAisleZoneMap(db) {    const out = {};
    let mapping = {};
    let labels = {};
    try { mapping = JSON.parse(readSetting(db, 'Zone_Mapping') || '{}'); } catch (_) { /* ignore */ }
    try { labels = JSON.parse(readSetting(db, 'Zone_Section_Labels') || '{}'); } catch (_) { /* ignore */ }
    const sectionAisle = {
        'map-a1': 'A1', 'map-a2': 'A2', 'map-a3': 'A3', 'map-a4': 'A4', 'map-a5': 'A5',
        'map-a6': 'A6', 'map-a7': 'A7', 'map-a8': 'A8', 'map-rfz': 'RFZ', 'map-fsfrz': 'FS FRZ',
    };
    Object.entries(mapping).forEach(([zone, ids]) => {
        (ids || []).forEach((id) => {
            const label = labels[id]?.label || sectionAisle[id] || '';
            if (label) out[normKey(label)] = zone;
        });
    });
    ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'rfz', 'fs frz', 'fsfrz'].forEach((k) => {
        if (!out[k]) out[k] = 'General';
    });
    return out;
}

function zoneForAisle(aisleZoneMap, aisle) {
    const raw = String(aisle || '').trim();
    if (!raw) return 'General';
    const key = normKey(raw);
    if (aisleZoneMap[key]) return aisleZoneMap[key];
    const m = raw.match(/^A\s*(\d+)/i);
    if (m) return aisleZoneMap[`a${m[1]}`] || 'General';
    return 'General';
}

/** Map section id for FIFO tasks — aisle-level (A1), not macro zone (Zone 2). */
function mapSectionForFifoAisle(aisle) {
    const raw = String(aisle || '').trim();
    if (!raw) return 'General';
    const m = raw.match(/^A\s*(\d+)/i);
    if (m) return `A${m[1]}`;
    const aliases = {
        rfz: 'Pop', pop: 'Pop',
        'fs frz': 'Freezer', fsfrz: 'Freezer', freezer: 'Freezer',
        tills: 'Tills', bakery: 'Bakery', dairy: 'Dairy', produce: 'Produce',
        water: 'Water', jerry: 'Jerry', seasonal: 'Seasonal',
        'food srvc': 'Food Srvc',
    };
    const key = normKey(raw);
    if (aliases[key]) return aliases[key];
    return raw;
}

/**
 * @param {object} db
 * @param {string} storeDate YYYY-MM-DD
 */
function buildRhythmAssignContext(db, storeDate) {
    const directory = loadStaffDirectory(db);
    const nameSet = new Set(directory.map((s) => normKey(s.name)));
    const shifts = db.all(
        'SELECT staff_name, start_time, end_time, role, department FROM staff_shifts WHERE shift_date = ? ORDER BY start_time, staff_name',
        storeDate,
    ) || [];

    const roleRulesJson = readSetting(db, 'Schedule_Role_Buckets');
    const buckets = {
        rec: [], stock_float: [], bakery: [], supervisor: [], premium: [], cash: [], cs: [], other: [],
    };
    const scheduledNames = new Set();
    const staffBuckets = {};
    const staffStartMinutes = {};

    shifts.forEach((shift) => {
        const name = canonicalStaffName(directory, shift.staff_name);
        if (!name) return;
        scheduledNames.add(normKey(name));
        const bucket = classifyShift(shift.department, shift.role, roleRulesJson);
        staffBuckets[normKey(name)] = bucket;
        if (!buckets[bucket]) buckets[bucket] = [];
        if (!buckets[bucket].includes(name)) buckets[bucket].push(name);
        const startMin = parseShiftMinutes(shift.start_time);
        if (startMin != null) {
            const key = normKey(name);
            if (staffStartMinutes[key] == null || startMin < staffStartMinutes[key]) {
                staffStartMinutes[key] = startMin;
            }
        }
        const staffRow = directory.find((s) => normKey(s.name) === normKey(name));
        // Directory premium still joins the premium pool unless tagged Supervisor on the grid.
        if (isDirectoryPremium(staffRow) && bucket !== 'supervisor' && !buckets.premium.includes(name)) {
            buckets.premium.push(name);
        }
    });
    let activeManager = String(readSetting(db, 'Active_Manager') || '').trim();
    activeManager = canonicalStaffName(directory, activeManager);
    const rhythmCtx = {
        hasSchedule: shifts.length > 0,
        scheduledNames,
        staffBuckets,
        directory,
        buckets,
        staffStartMinutes,
        nowMinutes: currentStoreMinutes(db, storeDate),
        activeManager: '',
    };
    if (activeManager && shifts.length > 0 && !isScheduledShiftLeadCandidate(rhythmCtx, activeManager)) {
        activeManager = '';
    }
    rhythmCtx.activeManager = activeManager;

    const shiftLead = pickShiftLeadAssignee(rhythmCtx) || '';

    let fifoRows = [];
    try { fifoRows = JSON.parse(readSetting(db, 'FIFO_Aisle_Assignments') || '[]'); } catch (_) { fifoRows = []; }

    return {
        storeDate,
        hasSchedule: shifts.length > 0,
        buckets,
        scheduledNames,
        shiftLead,
        activeManager: activeManager || shiftLead,
        nowMinutes: rhythmCtx.nowMinutes,
        staffStartMinutes,
        stockFloatPrimary: pickFirst({ buckets }, 'stock_float'),
        recPrimary: pickFirst({ buckets }, 'rec'),
        fifoRows: Array.isArray(fifoRows) ? fifoRows : [],
        aisleZoneMap: buildAisleZoneMap(db),
        directory,
        staffBuckets,
        roleRulesJson,
    };
}

function resolveAssignee(ctx, rule, taskKey = '') {
    if (!ctx?.hasSchedule) return 'Unassigned';
    let name = '';
    switch (rule) {
        case 'shift_lead':
            name = pickShiftLeadAssignee(ctx) || ctx.shiftLead || ctx.activeManager || '';
            break;
        case 'supervisor':
            name = pickFromBucket(ctx, 'supervisor', taskKey)
                || pickShiftLeadAssignee(ctx)
                || '';
            break;
        case 'premium':
            name = pickFromBucket(ctx, 'premium', taskKey); break;
        case 'stock_float': name = pickFromBucket(ctx, 'stock_float', taskKey); break;
        case 'bakery': name = pickFromBucket(ctx, 'bakery', taskKey); break;
        case 'rec': name = pickFromBucket(ctx, 'rec', taskKey); break;
        case 'cash': name = pickFromBucket(ctx, 'cash', taskKey); break;
        case 'cs': name = pickFromBucket(ctx, 'cs', taskKey); break;
        case 'other': name = pickFromBucket(ctx, 'other', taskKey); break;
        default: break;
    }
    if (!name || !isScheduled(ctx, name)) return 'Unassigned';
    return name;
}
function isScheduled(ctx, name) {
    return ctx.scheduledNames.has(normKey(name));
}

function expandFifoTasks(db, rhythmTask, ctx) {
    if (shouldSkipFifoRhythm(db, ctx.storeDate)) return [];

    const base = {
        priority: rhythmTask?.priority || 'Routine',
        est_mins: rhythmTask?.est_mins ?? 15,
    };
    const rows = [];
    const seen = new Set();

    (ctx.fifoRows || []).forEach((row) => {
        const staff = String(row?.staff || '').trim();
        const aisles = Array.isArray(row?.aisles) ? row.aisles.filter(Boolean) : [];
        if (!staff || !aisles.length) return;
        const assignee = canonicalStaffName(ctx.directory, staff);
        if (!assignee || !isScheduled(ctx, assignee)) return;
        if (!fifoEligibleForStaff(ctx, assignee, aisles)) return;
        const label = aisles.map((a) => String(a).trim()).join(', ');
        const key = `${normKey(assignee)}|${normKey(label)}`;
        if (seen.has(key)) return;
        seen.add(key);
        const zone = mapSectionForFifoAisle(aisles[0]);
        rows.push({
            task_detail: `FIFO Audit — ${label}`,
            zone,
            assigned_to: assignee,
            ...base,
        });
    });

    if (rows.length) return rows;

    if (shouldSkipFifoRhythm(db, ctx.storeDate)) return [];

    const fallback = resolveAssignee(ctx, 'stock_float', rhythmTask?.detail || 'FIFO Audit');
    return [{
        task_detail: 'FIFO Audit',
        zone: rhythmTask?.zone || 'General',
        assigned_to: fallback,
        ...base,
    }];
}

function taskAssignRule(detail) {
    const d = String(detail || '').trim();
    if (/^FIFO Audit/i.test(d)) return 'fifo_expand';
    if (/^Receive .+ order$/i.test(d)) return 'rec';
    if (/^Daily direction huddle/i.test(d)) return 'shift_lead';
    if (/^Store walk/i.test(d)) return 'shift_lead';
    if (/^Mid-day zone walk/i.test(d)) return 'shift_lead';
    if (/^Pre-close zone walk/i.test(d)) return 'shift_lead';
    if (/^TGP Order/i.test(d)) return 'rec';
    if (/^Work the TGP order/i.test(d)) return 'stock_float';
    if (/^Check freezer/i.test(d)) return 'stock_float';
    if (/^Level off displays|^Work dead displays|^Back stock|^Clean Shelves|^Update DOTS/i.test(d)) {
        return 'stock_float';
    }
    if (/^Bakery/i.test(d)) return 'bakery';
    return 'stock_float';
}
function normalizeAssignBucket(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (!v || v === 'auto') return '';
    if (v === 'shift_lead' || VALID_BUCKETS.has(v)) return v;
    return '';
}

function resolveTaskAssignee(ctx, taskDetail, assignBucket) {
    const detail = String(taskDetail || '').trim();
    const forced = normalizeAssignBucket(assignBucket);
    const rule = forced || taskAssignRule(detail);
    if (!ctx?.hasSchedule) return 'Unassigned';
    if (rule === 'fifo_expand') {
        const m = detail.match(/^FIFO Audit\s*[—–-]\s*(.+)$/i);
        if (m) {
            const label = m[1].trim();
            const targetAisles = label.split(/,\s*/).map((a) => normKey(a)).filter(Boolean);
            for (const row of ctx.fifoRows || []) {
                const staff = String(row?.staff || '').trim();
                const aisles = Array.isArray(row?.aisles) ? row.aisles.filter(Boolean) : [];
                if (!staff || !aisles.length) continue;
                const rowKeys = aisles.map((a) => normKey(a));
                const matches = targetAisles.every((k) => rowKeys.includes(k))
                    && rowKeys.every((k) => targetAisles.includes(k));
                if (!matches) continue;
                const assignee = canonicalStaffName(ctx.directory, staff);
                if (isScheduled(ctx, assignee)) return assignee;
            }
        }
        return resolveAssignee(ctx, 'stock_float', detail);
    }
    return resolveAssignee(ctx, rule, detail);
}

function resolveTaskZoneForBoard(taskDetail) {
    const detail = String(taskDetail || '').trim();
    const m = detail.match(/^FIFO Audit\s*[—–-]\s*(.+)$/i);
    if (m) {
        const aisles = m[1].split(/,\s*/).map((a) => a.trim()).filter(Boolean);
        return mapSectionForFifoAisle(aisles[0]);
    }
    if (/^FIFO Audit$/i.test(detail)) return 'General';
    return null;
}

/**
 * Recompute assigned_to on open board tasks submitted on the given store date.
 * Carryover Urgent/High from prior days are left alone.
 * @returns {{ updated: number, total: number, scheduleLoaded: boolean, storeDate: string }}
 */
function reapplyRhythmAssignments(db, storeDate) {
    const ctx = buildRhythmAssignContext(db, storeDate);
    const tzMod = sqliteTzOffsetModifier(readStoreTimezone(db));
    const open = db.all(
        `SELECT task_id, task_detail, assigned_to, zone FROM tasks
         WHERE status='Open' AND date(time_submitted, ?) = date(?)`,
        tzMod,
        storeDate,
    ) || [];
    let updated = 0;
    // Optional assign_bucket from matching rhythm template (detail match).
    let templateByDetail = new Map();
    try {
        const templates = db.all('SELECT detail, assign_bucket FROM rhythm_tasks') || [];
        templates.forEach((t) => {
            const key = String(t.detail || '').trim().toLowerCase();
            if (key && !templateByDetail.has(key)) {
                templateByDetail.set(key, t.assign_bucket || '');
            }
        });
    } catch (_) {
        templateByDetail = new Map();
    }

    db.transaction(() => {
        open.forEach((task) => {
            const bucketHint = templateByDetail.get(String(task.task_detail || '').trim().toLowerCase()) || '';
            const nextAssign = resolveTaskAssignee(ctx, task.task_detail, bucketHint);
            const nextZone = resolveTaskZoneForBoard(task.task_detail);
            const zoneChanged = nextZone && nextZone !== task.zone;
            if (nextAssign !== task.assigned_to || zoneChanged) {
                if (zoneChanged) {
                    db.run('UPDATE tasks SET assigned_to = ?, zone = ? WHERE task_id = ?', nextAssign, nextZone, task.task_id);
                } else {
                    db.run('UPDATE tasks SET assigned_to = ? WHERE task_id = ?', nextAssign, task.task_id);
                }
                updated += 1;
            }
        });
    })();
    return { updated, total: open.length, scheduleLoaded: ctx.hasSchedule, storeDate };
}

function expandRhythmTaskForBoard(db, rhythmTask, assignCtx) {
    const detail = String(rhythmTask?.detail || '').trim();
    const base = {
        priority: rhythmTask?.priority || 'Routine',
        est_mins: rhythmTask?.est_mins ?? 15,
    };
    const ctx = assignCtx || buildRhythmAssignContext(db, new Date().toISOString().slice(0, 10));
    const forced = normalizeAssignBucket(rhythmTask?.assign_bucket);
    const rule = forced || taskAssignRule(detail);

    if (rule === 'fifo_expand') {
        return expandFifoTasks(db, rhythmTask, ctx);
    }

    const assigned_to = resolveAssignee(ctx, rule, detail);
    let zone = rhythmTask?.zone || 'General';
    if (/^Check freezer/i.test(detail)) {
        zone = 'Zone 1';
    }

    return [{
        task_detail: detail,
        zone,
        assigned_to,
        ...base,
    }];
}

module.exports = {
    buildRhythmAssignContext,
    expandRhythmTaskForBoard,
    classifyShift,
    canonicalStaffName,
    isDirectoryPremium,
    isScheduledShiftLeadCandidate,
    taskAssignRule,
    resolveAssignee,
    pickFromBucket,
    pickShiftLeadAssignee,
    parseShiftMinutes,
    resolveTaskAssignee,
    resolveTaskZoneForBoard,
    mapSectionForFifoAisle,
    reapplyRhythmAssignments,
    shouldSkipFifoRhythm,
    fifoEligibleForStaff,
    normalizeAssignBucket,
    DEFAULT_SCHEDULE_ROLE_RULES,
    RHYTHM_ASSIGN_BUCKETS,
    VALID_BUCKETS,
};