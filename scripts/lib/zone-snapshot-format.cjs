'use strict';

const SECTION_ORDER = [
    'map-a1', 'map-a2', 'map-a3', 'map-a4', 'map-a5', 'map-a6',
    'map-a7', 'map-a8', 'map-rfz', 'map-fsfrz', 'map-cmd',
];

const SECTION_FALLBACK = {
    'map-a1': { label: 'A1', sublabel: 'POP' },
    'map-a2': { label: 'A2', sublabel: 'SNACK' },
    'map-a3': { label: 'A3', sublabel: 'HBA' },
    'map-a4': { label: 'A4', sublabel: 'BAKE' },
    'map-a5': { label: 'A5', sublabel: 'COFFEE' },
    'map-a6': { label: 'A6', sublabel: 'ETH/PET' },
    'map-a7': { label: 'A7', sublabel: 'FS PAPER' },
    'map-a8': { label: 'A8', sublabel: 'PKGS' },
    'map-rfz': { label: 'RFZ', sublabel: 'RETAIL FRZ' },
    'map-fsfrz': { label: 'FS FRZ', sublabel: 'MEAT' },
    'map-cmd': { label: 'Z4', sublabel: 'WRAP / TOBACCO' },
};

function parseJson(raw, fallback = {}) {
    try { return JSON.parse(raw || '{}'); } catch { return fallback; }
}

function buildSectionToZone(mapping) {
    const out = {};
    Object.entries(mapping || {}).forEach(([zone, ids]) => {
        (ids || []).forEach((id) => { out[id] = zone; });
    });
    return out;
}

function normalizeSnapshot(raw) {
    const mapping = raw.zone_mapping || parseJson(raw.Zone_Mapping);
    const owners = raw.zone_ownership || parseJson(raw.Zone_Ownership);
    const names = raw.zone_names || parseJson(raw.Zone_Names);
    const labels = raw.zone_section_labels || parseJson(raw.Zone_Section_Labels);
    return {
        store_display_name: raw.store_display_name || raw.Store_Display_Name || 'TGP Store',
        exported_at: raw.exported_at || new Date().toISOString(),
        source: raw.source || 'unknown',
        zone_mapping: mapping,
        zone_ownership: owners,
        zone_names: names,
        zone_section_labels: labels,
    };
}

function formatZoneLegendMarkdown(snapshot) {
    const s = normalizeSnapshot(snapshot);
    const rows = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4'].map((zone) => {
        const display = s.zone_names[zone] || zone.toUpperCase();
        const owner = s.zone_ownership[zone] || '—';
        return `| **${display}** (${zone}) | ${owner} |`;
    });
    return [
        '| Zone | Owner |',
        '|------|-------|',
        ...rows,
    ].join('\n');
}

function formatSectionTableMarkdown(snapshot) {
    const s = normalizeSnapshot(snapshot);
    const secToZone = buildSectionToZone(s.zone_mapping);
    const rows = SECTION_ORDER.filter((id) => id !== 'map-cmd').map((id) => {
        const meta = { ...SECTION_FALLBACK[id], ...(s.zone_section_labels[id] || {}) };
        const zone = secToZone[id] || '—';
        const owner = zone !== '—' ? (s.zone_ownership[zone] || '—') : '—';
        const label = meta.label || id;
        const sub = meta.sublabel ? ` · ${meta.sublabel}` : '';
        return `| **${label}**${sub} | ${zone.replace('Zone ', 'Z')} | ${owner} |`;
    });
    const cmdZone = secToZone['map-cmd'] || 'Zone 4';
    const cmdOwner = s.zone_ownership[cmdZone] || s.zone_ownership['Zone 4'] || '—';
    rows.push(`| **Wrap-around & Tobacco** | Z4 | ${cmdOwner} |`);
    return [
        '| Section | Map zone | Owner |',
        '|---------|----------|-------|',
        ...rows,
    ].join('\n');
}

function formatA5SharedMarkdown(snapshot) {
    const s = normalizeSnapshot(snapshot);
    const a5 = s.zone_section_labels['map-a5'] || {};
    const sections = a5.sections || [
        { label: 'Coffee', owner: '' },
        { label: 'Monin/Torani', owner: '' },
        { label: 'Wraps', owner: '' },
    ];
    const rows = sections.map((seg) => `| ${seg.label} | ${seg.owner || '— (set in Settings Editor)'} |`);
    return [
        '| A5 segment | Premium owner |',
        '|------------|---------------|',
        ...rows,
        '',
        '*A5 is shared — name the active segment owner at huddle.*',
    ].join('\n');
}

function formatZoneBlockMarkdown(snapshot) {
    const s = normalizeSnapshot(snapshot);
    return [
        `*Exported from TGP Center Store · ${s.store_display_name} · ${s.exported_at.slice(0, 10)} · source: ${s.source}*`,
        '',
        '### Zone legend (matches TV / Home Base map)',
        '',
        formatZoneLegendMarkdown(s),
        '',
        '### Section → zone → owner',
        '',
        formatSectionTableMarkdown(s),
        '',
        '### A5 shared segments',
        '',
        formatA5SharedMarkdown(s),
    ].join('\n');
}

module.exports = {
    normalizeSnapshot,
    formatZoneLegendMarkdown,
    formatSectionTableMarkdown,
    formatA5SharedMarkdown,
    formatZoneBlockMarkdown,
};
