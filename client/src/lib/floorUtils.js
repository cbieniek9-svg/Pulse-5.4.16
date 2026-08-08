import { normalizeRole } from './roles.js';

export const TASK_ZONES = [
    'General', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'Pop', 'Water', 'Jerry', 'Bakery', 'Dairy', 'Produce', 'Freezer',
    'Food Srvc', 'Receiving', 'Tills', 'Seasonal',
];

export const OOS_ZONES = [
    'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'Pop', 'Water', 'Dairy', 'Produce', 'Freezer', 'Bakery',
];

export const SCHEDULE_BUCKET_LABELS = {
    supervisor: 'Supervisor',
    premium: 'Premium / Shift Lead',
    rec: 'Receiving',
    stock_float: 'Stock / Float',
    bakery: 'Bakery',
    cash: 'Cash',
    cs: 'Customer Service',
    other: 'Other',
};

export const RHYTHM_SCHEDULE_DEPT_OPTIONS = [
    { value: 'Stock/Float', label: 'Stock / Float' },
    { value: 'REC', label: 'Receiving (REC)' },
    { value: 'Supervisor', label: 'Supervisor' },
    { value: 'Premium', label: 'Premium / Shift Lead' },
    { value: 'Open Cash', label: 'Cash' },
    { value: 'Customer Service', label: 'Customer Service' },
    { value: 'Bakery', label: 'Bakery' },
    { value: 'Grocery', label: 'Grocery / Floor' },
    { value: 'Freezer', label: 'Freezer (floor)' },
    { value: 'Other', label: 'Other' },
];

export const DD_WALK_FLAGS = [
    ['staffing_gap', 'Staffing gap'],
    ['floor_rough', 'Floor rough'],
    ['receiving_backup', 'Receiving backed up'],
    ['cs_pressure', 'CS / tills pressure'],
    ['morale_issue', 'Morale / staffing issue'],
    ['visual_urgent', 'Visual urgent (not logged)'],
];

const STATIC_KILL_ZONE_TO_MAP = {
    Dairy: 'Zone 1', Bakery: 'Zone 1', Produce: 'Zone 1', Freezer: 'Zone 1',
    Pop: 'Zone 3', Water: 'Zone 3', Jerry: 'Zone 3', Seasonal: 'Zone 3',
    Tills: 'Zone 4',
    General: null,
};

const SECTION_AISLE_FALLBACK = {
    'map-a1': 'A1', 'map-a2': 'A2', 'map-a3': 'A3', 'map-a4': 'A4',
    'map-a5': 'A5', 'map-a6': 'A6', 'map-a7': 'A7', 'map-a8': 'A8',
    'map-rfz': 'RFZ', 'map-fsfrz': 'FS FRZ',
};

export function genId(prefix = '') {
    const uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return prefix ? `${prefix}-${uid}` : uid;
}

export function upperCase(v) {
    return String(v ?? '').trim().toUpperCase();
}

export function datestamp(d = new Date()) {
    const p = new Intl.DateTimeFormat('en-CA').formatToParts(d);
    const v = p.reduce((a, x) => {
        if (x.type !== 'literal') a[x.type] = x.value;
        return a;
    }, {});
    return `${v.year}-${v.month}-${v.day}`;
}

export function storeToday(syncData) {
    return syncData?.storeDate || datestamp();
}

export function isActiveKillRow(k) {
    const status = String(k?.status || 'Active').trim();
    return !status || status === 'Active';
}

export function expiryDaysUntil(killDate, today) {
    if (!killDate || !today) return null;
    const a = new Date(`${today}T12:00:00`);
    const b = new Date(`${killDate}T12:00:00`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    return Math.round((b - a) / 86400000);
}

export function addDaysStamp(stamp, days) {
    const [y, m, d] = stamp.split('-').map(Number);
    const dt = new Date(y, m - 1, d + days);
    const p = (n) => String(n).padStart(2, '0');
    return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

export function fmtIsoShort(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_) {
        return String(iso).slice(11, 16);
    }
}

/**
 * Mirror of DEFAULT_SCHEDULE_ROLE_RULES in src/lib/schedule-role-buckets.cjs — order and word
 * boundaries matter. Sync sends a server-computed `bucket` on each shift, so this only runs as a
 * fallback; tests/shift-roster-buckets.test.cjs asserts the two stay in agreement.
 */
const SCHEDULE_ROLE_RULES = [
    { match: /\brec\b|receiv/i, bucket: 'rec' },
    { match: /bakery|bake/i, bucket: 'bakery' },
    { match: /stock\s*\/?\s*float|\bfloat\b|\bstock\b|\bstk\b|home\s*base|homebase|center\s*store|grocery|aisle|floor/i, bucket: 'stock_float' },
    { match: /freezer|frozen/i, bucket: 'stock_float' },
    { match: /supervisor|\bsupv\b|\bsup\b/i, bucket: 'supervisor' },
    { match: /premium|prem\b|shift\s*lead|shiftlead|zone\s*prem/i, bucket: 'premium' },
    { match: /\bmanager\b|\bmgr\b/i, bucket: 'premium', exclude: /store\s*manager/i },
    { match: /open\s*cash|clo\s*cash|\bcash\b|till/i, bucket: 'cash' },
    { match: /cust\s*serv|\bcs\b|customer/i, bucket: 'cs' },
];

function matchScheduleRules(text) {
    const s = String(text || '').trim().toLowerCase();
    if (!s) return 'other';
    for (const rule of SCHEDULE_ROLE_RULES) {
        if (rule.exclude && rule.exclude.test(s)) continue;
        if (rule.match.test(s)) return rule.bucket;
    }
    return 'other';
}

/**
 * Department is what the Shift Roster dropdown writes, so a department that classifies cleanly
 * wins outright. Only fall back to department + role together when it does not ('CLOSER',
 * 'OUTSIDE', blank) — otherwise a job title like 'FT Centre Store Clerk/Cashier' would keep
 * out-voting an explicit 'Customer Service' assignment.
 */
export function classifyImportedShift(department, role) {
    const byDepartment = matchScheduleRules(department);
    if (byDepartment !== 'other') return byDepartment;
    return matchScheduleRules(`${department || ''} ${role || ''}`);
}

/** Prefer the bucket the server already computed; classify locally only if it is missing. */
export function scheduleBucketForShift(shift) {
    const fromServer = String(shift?.bucket || '').trim();
    if (fromServer && SCHEDULE_BUCKET_LABELS[fromServer]) return fromServer;
    return classifyImportedShift(shift?.department, shift?.role);
}

/** Which RHYTHM_SCHEDULE_DEPT_OPTIONS value the dropdown should show for a shift row. */
export function scheduleDeptValueForShift(shift) {
    const bucket = scheduleBucketForShift(shift);
    if (bucket === 'rec') return 'REC';
    if (bucket === 'bakery') return 'Bakery';
    if (bucket === 'stock_float') {
        // Refine from department only — role job titles must not steer this.
        const dept = String(shift?.department || '');
        if (/freezer|frozen/i.test(dept)) return 'Freezer';
        if (/grocery|aisle|floor/i.test(dept)) return 'Grocery';
        return 'Stock/Float';
    }
    if (bucket === 'supervisor') return 'Supervisor';
    if (bucket === 'premium') return 'Premium';
    if (bucket === 'cash') return 'Open Cash';
    if (bucket === 'cs') return 'Customer Service';
    return 'Other';
}

export function rhythmScheduleDeptValue(department, role) {
    return scheduleDeptValueForShift({ department, role });
}

export function countScheduleComplement(shiftsToday = []) {
    const names = new Set();
    shiftsToday.forEach((s) => {
        const n = String(s.staff_name || '').trim();
        if (n) names.add(n.toLowerCase());
    });
    return names.size;
}

export function isShiftLeadEligible(s) {
    if (!s || s.active !== 1) return false;
    const role = normalizeRole(s.role);
    if (role === 'store manager') return false;
    if (s.shift_lead_eligible === 0) return false;
    return role === 'premium clerk' || role === 'manager';
}

function normalizeKillZoneLabel(label, sectionId) {
    const raw = String(label || '').trim();
    if (!raw && sectionId) return SECTION_AISLE_FALLBACK[sectionId] || '';
    const aisleMatch = raw.match(/^A\s*(\d{1,2})$/i);
    if (aisleMatch) return `A${parseInt(aisleMatch[1], 10)}`;
    if (/^A\d{1,2}$/i.test(raw)) return raw.toUpperCase();
    return raw.toUpperCase();
}

function buildKillZoneMapFromSettings(settings) {
    const out = { ...STATIC_KILL_ZONE_TO_MAP };
    let mapping = {};
    let labels = {};
    try { mapping = JSON.parse(settings?.Zone_Mapping || '{}'); } catch (_) { /* ignore */ }
    try { labels = JSON.parse(settings?.Zone_Section_Labels || '{}'); } catch (_) { /* ignore */ }
    Object.keys(mapping).forEach((mapZone) => {
        (mapping[mapZone] || []).forEach((sectionId) => {
            const label = (labels[sectionId]?.label) || SECTION_AISLE_FALLBACK[sectionId] || '';
            const key = normalizeKillZoneLabel(label, sectionId);
            if (key) out[key] = mapZone;
        });
    });
    return out;
}

export function mgrKillZoneOwner(zone, settings) {
    let owners = {};
    try { owners = JSON.parse(settings?.Zone_Ownership || '{}'); } catch (_) { /* ignore */ }
    const map = buildKillZoneMapFromSettings(settings || {});
    if (!zone) return '';
    const z = String(zone).trim();
    if (owners[z]) return String(owners[z]);
    const mapped = map[z] ?? map[z.toUpperCase()];
    if (mapped && owners[mapped]) return String(owners[mapped]);
    return '';
}

export function commsViewerZone(isManager) {
    if (isManager) return null;
    try { return sessionStorage.getItem('tgp_comms_view_zone') || ''; } catch (_) { return ''; }
}

export function filterCommsRows(rows, isManager) {
    const zone = commsViewerZone(isManager);
    if (isManager) return rows || [];
    return (rows || []).filter((m) => {
        const z = m.zone || '';
        if (!z || z === 'General') return true;
        if (!zone) return false;
        return z === zone;
    });
}

export function getPremiumZones(settings) {
    let zones = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'General'];
    try {
        const owners = JSON.parse(settings?.Zone_Ownership || '{}');
        const fromSettings = Object.keys(owners).filter((z) => z && z !== 'Unassigned');
        if (fromSettings.length) zones = [...new Set([...fromSettings, 'General'])];
    } catch (_) { /* keep default */ }
    return zones;
}

export function getCommsZoneOptions(settings) {
    const base = ['', 'General'];
    try {
        const owners = JSON.parse(settings?.Zone_Ownership || '{}');
        Object.keys(owners).forEach((z) => {
            if (z && z !== 'Unassigned') base.push(z);
        });
    } catch (_) { /* ignore */ }
    TASK_ZONES.forEach((z) => { if (!base.includes(z)) base.push(z); });
    return base;
}

export function resolveZoneMapping(settings) {
    let fromServer = {};
    try { fromServer = JSON.parse(settings?.Zone_Mapping || '{}'); } catch (_) { /* ignore */ }
    return fromServer;
}

export function heatMapLastAuditIso(entry) {
    if (!entry) return '';
    if (typeof entry === 'string') return entry;
    if (typeof entry === 'object' && entry.last_audit) return String(entry.last_audit);
    return '';
}

export function isHeatMapZoneCold(entry, nowMs, thresholdMs) {
    const iso = heatMapLastAuditIso(entry);
    if (!iso) return true;
    const t = new Date(iso).getTime();
    if (Number.isNaN(t)) return true;
    return (nowMs - t) > thresholdMs;
}

export function normalizeMapZoneKey(z) {
    if (z === 'COMMAND' || z === 'Command') return 'Zone 4';
    return z;
}
