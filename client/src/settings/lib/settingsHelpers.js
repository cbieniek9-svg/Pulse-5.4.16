export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const RHYTHM_DAYS = ['Everyday', ...WEEKDAYS];
export const ZONES = [
    'General', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8',
    'Pop', 'Water', 'Jerry', 'Bakery', 'Dairy', 'Produce', 'Freezer',
    'Food Srvc', 'Receiving', 'Tills', 'Seasonal',
];
export const MAP_SECTIONS = ['map-a1', 'map-a2', 'map-a3', 'map-a4', 'map-a5', 'map-a6', 'map-a7', 'map-a8', 'map-rfz', 'map-fsfrz'];
export const DAY_ORDER = Object.fromEntries(RHYTHM_DAYS.map((d, i) => [d, i]));

export const SCHEDULE_ROLE_BUCKETS = ['rec', 'stock_float', 'bakery', 'supervisor', 'premium', 'cash', 'cs', 'other'];

export const RHYTHM_ASSIGN_BUCKET_OPTIONS = [
    { value: '', label: 'Auto (from task text)' },
    { value: 'shift_lead', label: 'Supervisor → Premium (walks/huddle)' },
    { value: 'supervisor', label: 'Supervisor' },
    { value: 'premium', label: 'Premium / Shift Lead' },
    { value: 'stock_float', label: 'Stock / Float' },
    { value: 'bakery', label: 'Bakery' },
    { value: 'rec', label: 'Receiving (REC)' },
    { value: 'cash', label: 'Cash' },
    { value: 'cs', label: 'Customer Service' },
    { value: 'other', label: 'Other' },
];

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

export const STAFF_ALIAS_TYPES = [
    { id: 'alias', label: 'Alias → app staff' },
    { id: 'inactive', label: 'Inactive / left store' },
    { id: 'file_maintenance', label: 'File maintenance (no rhythm)' },
    { id: 'pending_staff', label: 'Pending staff (no rhythm)' },
    { id: 'schedule_only', label: 'Schedule only (no rhythm)' },
];

export const STAFF_PERM_KEYS = ['tasks', 'receiving', 'markdown', 'comms', 'safe', 'inventory'];

export const VALID_TABS = ['rhythm', 'vendors', 'deliveries', 'store', 'safety', 'staff', 'items', 'audit', 'devices', 'maintenance'];

export const TAB_LABELS = {
    rhythm: 'Rhythm',
    vendors: 'Vendors',
    deliveries: 'Deliveries',
    store: 'Store / TV',
    safety: 'Safety',
    staff: 'Staff',
    items: 'Catalog',
    audit: 'Task times',
    devices: 'Devices',
    maintenance: 'Maintain',
};

// Single classifier lives in lib/floorUtils.js (mirroring src/lib/schedule-role-buckets.cjs).
// Re-exported here so Settings → Staff and Shift Roster can never disagree.
export {
    classifyImportedShift,
    rhythmScheduleDeptValue,
    scheduleBucketForShift,
    scheduleDeptValueForShift,
} from '../../lib/floorUtils.js';

export function settingIsEnabled(settings, key, defaultValue = true) {
    const raw = settings ? settings[key] : undefined;
    if (raw === undefined || raw === null || raw === '') return !!defaultValue;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    const s = String(raw).trim().toLowerCase();
    if (!s) return !!defaultValue;
    return !['0', 'false', 'off', 'no'].includes(s);
}

export function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return 'n/a';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export function formatDateTime(value) {
    if (!value) return 'n/a';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString();
}

export function fmtRecvTime(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (_) {
        return '';
    }
}

export function genId(prefix) {
    const uid = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    return prefix ? `${prefix}-${uid}` : uid;
}

export function titleCase(v) {
    return String(v ?? '').trim().split(/\s+/).filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

export function isoToDatetimeLocal(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function datetimeLocalToIso(s) {
    if (!s || !String(s).trim()) return null;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function sortRhythmTasks(tasks) {
    return [...(tasks || [])].sort((a, b) => {
        const da = DAY_ORDER[a.day] ?? 99;
        const db = DAY_ORDER[b.day] ?? 99;
        if (da !== db) return da - db;
        return String(a.detail).localeCompare(String(b.detail));
    });
}

export function sortVendorRows(rows) {
    return [...(rows || [])].sort((a, b) => {
        const da = DAY_ORDER[a.day] ?? 99;
        const db = DAY_ORDER[b.day] ?? 99;
        if (da !== db) return da - db;
        return String(a.vendor).localeCompare(String(b.vendor));
    });
}

export function parseFifoAssignments(settings) {
    try {
        const rows = JSON.parse(settings?.FIFO_Aisle_Assignments || '[]');
        return Array.isArray(rows) ? rows : [];
    } catch (_) {
        return [];
    }
}

export function parseJsonSetting(raw, fallback = {}) {
    try {
        return JSON.parse(raw || JSON.stringify(fallback));
    } catch (_) {
        return fallback;
    }
}

export function defaultNewStaffPerms(role) {
    if (role === 'Premium Clerk') return new Set(['tasks', 'receiving']);
    if (role === 'Clerk') return new Set(['tasks']);
    return new Set();
}

export function storeDateToday(syncData) {
    return syncData?.storeDate || new Date().toISOString().slice(0, 10);
}

export function tabFromLocation(search, hash) {
    const params = new URLSearchParams(search);
    const q = (params.get('tab') || '').trim().toLowerCase();
    if (VALID_TABS.includes(q)) return q;
    const h = (hash || '').replace(/^#/, '').trim().toLowerCase();
    if (VALID_TABS.includes(h)) return h;
    return 'rhythm';
}

export function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.includes(',') ? result.split(',').pop() : result);
        };
        reader.onerror = () => reject(reader.error || new Error('File read failed'));
        reader.readAsDataURL(file);
    });
}

export function downloadScheduleTemplate() {
    const rows = [
        ['Staff', 'Date', 'Start', 'End', 'Department', 'Role', 'Notes'],
        ['Jane Doe', '2026-06-26', '09:00', '17:00', 'Stock/Float', 'Clerk', ''],
        ['John Smith', '2026-06-26', '09:00', '17:00', 'REC', 'Receiver', ''],
        ['Alex Lee', '2026-06-26', '08:00', '16:00', 'Premium', 'Shift Lead', ''],
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tgp-schedule-template.csv';
    a.click();
    URL.revokeObjectURL(url);
}

export function verifySettingsPersisted(syncData, checks) {
    for (const [key, expected] of checks) {
        const actual = syncData?.settings?.[key];
        if (String(actual ?? '') !== String(expected ?? '')) return false;
    }
    return true;
}
