/**

 * Zone owner lookup — shared by mobile and TV.

 * Aisle → map zone comes from Zone_Mapping in settings (see kill-zone-map.cjs).

 */

(function (root) {

    'use strict';



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

        try { mapping = JSON.parse((settings && settings.Zone_Mapping) || '{}'); } catch (_) { /* ignore */ }

        try { labels = JSON.parse((settings && settings.Zone_Section_Labels) || '{}'); } catch (_) { /* ignore */ }

        Object.keys(mapping).forEach((mapZone) => {

            (mapping[mapZone] || []).forEach((sectionId) => {

                const label = (labels[sectionId] && labels[sectionId].label) || SECTION_AISLE_FALLBACK[sectionId] || '';

                const key = normalizeKillZoneLabel(label, sectionId);

                if (key) out[key] = mapZone;

            });

        });

        return out;

    }



    function parseZoneOwnership(settingsOrJson) {

        try {

            const raw = typeof settingsOrJson === 'string'

                ? settingsOrJson

                : (settingsOrJson && settingsOrJson.Zone_Ownership);

            return JSON.parse(raw || '{}');

        } catch {

            return {};

        }

    }



    function ownerForKillZone(killZone, zoneOwnership) {

        const settings = (zoneOwnership && typeof zoneOwnership === 'object' && zoneOwnership.Zone_Mapping)

            ? zoneOwnership

            : { Zone_Ownership: typeof zoneOwnership === 'string' ? zoneOwnership : zoneOwnership?.Zone_Ownership };

        const owners = parseZoneOwnership(settings);

        const map = buildKillZoneMapFromSettings(settings);

        if (!killZone) return '';

        const zone = String(killZone).trim();

        if (owners[zone]) return String(owners[zone]);

        const mapped = map[zone] ?? map[zone.toUpperCase()];

        if (mapped && owners[mapped]) return String(owners[mapped]);

        return '';

    }



    root.TgpZoneOwners = {

        KILL_ZONE_TO_MAP: buildKillZoneMapFromSettings({}),

        buildKillZoneMapFromSettings,

        parseZoneOwnership,

        ownerForKillZone,

    };

}(typeof window !== 'undefined' ? window : globalThis));

