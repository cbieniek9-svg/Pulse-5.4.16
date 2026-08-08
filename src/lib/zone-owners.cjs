'use strict';



const { buildKillZoneMapFromSettings } = require('./kill-zone-map.cjs');



/** @deprecated use buildKillZoneMapFromSettings — kept for tests comparing static shape */

const KILL_ZONE_TO_MAP = buildKillZoneMapFromSettings({});



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



/**

 * @param {string} killZone

 * @param {object|string} zoneOwnership settings object or JSON string

 */

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



module.exports = {

    KILL_ZONE_TO_MAP,

    parseZoneOwnership,

    ownerForKillZone,

    buildKillZoneMapFromSettings,

};

