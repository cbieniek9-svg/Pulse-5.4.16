'use strict';

/** Department / premium zones not tied to floor map sections. */
const STATIC_KILL_ZONE_TO_MAP = {
    Dairy: 'Zone 1',
    Bakery: 'Zone 1',
    Produce: 'Zone 1',
    Freezer: 'Zone 1',
    Pop: 'Zone 3',
    Water: 'Zone 3',
    Jerry: 'Zone 3',
    Seasonal: 'Zone 3',
    Tills: 'Zone 4',
    General: null,
};

const SECTION_AISLE_FALLBACK = {
    'map-a1': 'A1',
    'map-a2': 'A2',
    'map-a3': 'A3',
    'map-a4': 'A4',
    'map-a5': 'A5',
    'map-a6': 'A6',
    'map-a7': 'A7',
    'map-a8': 'A8',
    'map-rfz': 'RFZ',
    'map-fsfrz': 'FS FRZ',
};

function normalizeKillZoneLabel(label, sectionId) {
    const raw = String(label || '').trim();
    if (!raw && sectionId) return SECTION_AISLE_FALLBACK[sectionId] || '';
    const aisleMatch = raw.match(/^A\s*(\d{1,2})$/i);
    if (aisleMatch) return `A${parseInt(aisleMatch[1], 10)}`;
    if (/^A\d{1,2}$/i.test(raw)) return raw.toUpperCase();
    return raw.toUpperCase();
}

/**
 * Build kill-zone → map-zone lookup from live Zone_Mapping + section labels.
 * @param {Record<string, string>|object} settings
 */
function buildKillZoneMapFromSettings(settings = {}) {
    const out = { ...STATIC_KILL_ZONE_TO_MAP };
    let mapping = {};
    let labels = {};
    try { mapping = JSON.parse(settings.Zone_Mapping || '{}'); } catch (_) { /* ignore */ }
    try { labels = JSON.parse(settings.Zone_Section_Labels || '{}'); } catch (_) { /* ignore */ }

    for (const [mapZone, sections] of Object.entries(mapping)) {
        (sections || []).forEach((sectionId) => {
            const label = labels[sectionId]?.label || SECTION_AISLE_FALLBACK[sectionId] || '';
            const key = normalizeKillZoneLabel(label, sectionId);
            if (key) out[key] = mapZone;
        });
    }
    return out;
}

module.exports = {
    STATIC_KILL_ZONE_TO_MAP,
    buildKillZoneMapFromSettings,
    normalizeKillZoneLabel,
};
