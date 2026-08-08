const UNMAPPED = '#a855f7';
const BLUE = '#0cf';

const ZONE_COLORS = {
    'Zone 1': '#f90',
    'Zone 2': '#0f8',
    'Zone 3': BLUE,
    'Zone 4': '#f44',
    COMMAND: '#f44',
};

const SECTION_COLORS = {
    Pop: '#0f8',
    Freezer: '#f90',
    Water: '#0f8',
    Seasonal: '#f44',
    Tills: '#f44',
    Bakery: '#f44',
};

const SECTION_ID_ALIASES = { 'map-rfz': 'Pop' };

const ZONE_FILL = {
    'Zone 1': { warm: 'rgba(255,170,0,0.14)', cold: 'rgba(255,170,0,0.07)' },
    'Zone 2': { warm: 'rgba(0,255,136,0.14)', cold: 'rgba(0,255,136,0.07)' },
    'Zone 3': { warm: 'rgba(0,229,255,0.14)', cold: 'rgba(0,229,255,0.07)' },
    'Zone 4': { warm: 'rgba(255,68,68,0.14)', cold: 'rgba(255,68,68,0.07)' },
    COMMAND: { warm: 'rgba(255,68,68,0.14)', cold: 'rgba(255,68,68,0.07)' },
    unmapped: { warm: 'rgba(168,85,247,0.14)', cold: 'rgba(168,85,247,0.07)' },
};

const ZONE_TO_SECTIONS = {
    Dairy: ['Dairy'], Bakery: ['Bakery'], Produce: ['Produce'], Freezer: ['Freezer'],
    A1: ['A1'], A2: ['A2'], A3: ['A3'], A4: ['A4'],
    A5: ['A5'], A6: ['A6'], A7: ['A7'], A8: ['A8'],
    Pop: ['Pop'], Water: ['Water'], Jerry: ['Jerry'], Seasonal: ['Seasonal'],
    General: [],
    'Zone 1': ['Dairy', 'Bakery', 'Produce', 'Freezer', 'Pop'],
    'Zone 2': ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'],
    'Zone 3': ['Pop', 'Water', 'Jerry', 'Seasonal'],
};

export const MAP_SECTION_IDS = [
    'map-a1', 'map-a2', 'map-a3', 'map-a4', 'map-a5', 'map-a6', 'map-a7', 'map-a8',
    'map-rfz', 'map-fsfrz',
];

export const A5_SECTION_COLORS = ['#f90', BLUE, '#0f8'];

function normalizeMapZoneKey(z) {
    if (z === 'COMMAND' || z === 'Command') return 'Zone 4';
    return z;
}

function normalizeSectionId(sectionId) {
    const bare = String(sectionId || '').replace(/^map-/, '');
    const m = /^a(\d)$/i.exec(bare);
    if (m) return `A${m[1]}`;
    if (bare === 'rfz') return 'Pop';
    if (bare === 'fsfrz') return 'Freezer';
    return bare;
}

function tasksForSection(sectionId, tasks) {
    const secId = normalizeSectionId(sectionId);
    return (tasks || []).filter((t) => {
        const z = t.zone || 'General';
        if (z === 'General') return false;
        if (z === secId || z === sectionId) return true;
        const sections = ZONE_TO_SECTIONS[z];
        return sections && sections.includes(secId);
    });
}

export function mapSectionPriorityClass(sectionId, tasks) {
    const matched = tasksForSection(sectionId, tasks);
    if (!matched.length) return '';
    if (matched.some((t) => t.priority === 'Urgent' || String(t.task_detail || '').startsWith('PULL:'))) {
        return 'map-priority-urgent';
    }
    if (matched.some((t) => t.priority === 'High')) return 'map-priority-high';
    return 'map-priority-active';
}

function resolveSectionColorKey(sectionId) {
    if (!sectionId) return null;
    if (SECTION_COLORS[sectionId]) return sectionId;
    const alias = SECTION_ID_ALIASES[sectionId];
    if (alias && SECTION_COLORS[alias]) return alias;
    return null;
}

export function colorForZone(zone) {
    const key = normalizeMapZoneKey(zone);
    return key && ZONE_COLORS[key] ? ZONE_COLORS[key] : UNMAPPED;
}

export function colorForSection(sectionId, zone) {
    if (zone) return colorForZone(zone);
    const sectionKey = resolveSectionColorKey(sectionId);
    if (sectionKey) return SECTION_COLORS[sectionKey];
    return UNMAPPED;
}

function fillFromHex(hex, isCold) {
    const a = isCold ? 0.07 : 0.14;
    if (hex === '#0f8') return isCold ? 'rgba(0,255,136,0.07)' : 'rgba(0,255,136,0.14)';
    if (hex === '#f90') return isCold ? 'rgba(255,170,0,0.07)' : 'rgba(255,170,0,0.14)';
    if (hex === BLUE) return isCold ? 'rgba(0,229,255,0.07)' : 'rgba(0,229,255,0.14)';
    if (hex === '#f44') return isCold ? 'rgba(255,68,68,0.07)' : 'rgba(255,68,68,0.14)';
    if (hex === UNMAPPED) return isCold ? ZONE_FILL.unmapped.cold : ZONE_FILL.unmapped.warm;
    return isCold ? 'rgba(168,85,247,0.07)' : 'rgba(168,85,247,0.14)';
}

export function fillForZone(zone, isCold) {
    const key = normalizeMapZoneKey(zone);
    const fills = (key && ZONE_FILL[key]) || ZONE_FILL.unmapped;
    return isCold ? fills.cold : fills.warm;
}

export function fillForSection(sectionId, zone, isCold) {
    const hex = colorForSection(sectionId, zone);
    if (resolveSectionColorKey(sectionId)) return fillFromHex(hex, isCold);
    return fillForZone(zone, isCold);
}

export function computeMapSectionStyle(sectionId, zoneName, isCold, tasks) {
    const color = colorForSection(sectionId, zoneName);
    const fill = fillForSection(sectionId, zoneName, isCold);
    const priCls = mapSectionPriorityClass(sectionId, tasks);
    return {
        borderColor: color,
        background: fill,
        opacity: isCold ? 0.88 : 1,
        boxShadow: isCold ? 'inset 0 0 0 1px rgba(255,255,255,0.12)' : 'none',
        labelColor: color,
        priorityClass: priCls,
    };
}
