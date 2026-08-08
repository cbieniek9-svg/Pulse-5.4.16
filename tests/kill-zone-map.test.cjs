const test = require('node:test');
const assert = require('node:assert/strict');
const { buildKillZoneMapFromSettings } = require('../src/lib/kill-zone-map.cjs');
const { ownerForKillZone } = require('../src/lib/zone-owners.cjs');

const storeSettings = {
    Zone_Mapping: JSON.stringify({
        'Zone 1': ['map-a1', 'map-a2', 'map-a6'],
        'Zone 2': ['map-a3', 'map-a4', 'map-a5', 'map-rfz'],
        'Zone 3': ['map-a7', 'map-a8', 'map-fsfrz'],
        'Zone 4': ['map-cmd'],
    }),
    Zone_Ownership: JSON.stringify({
        'Zone 1': 'LUKE',
        'Zone 2': 'ASHLEY',
        'Zone 3': 'CHANDLER',
        'Zone 4': 'CHRIS',
    }),
    Zone_Section_Labels: JSON.stringify({
        'map-a1': { label: 'A1' },
        'map-a2': { label: 'A2' },
        'map-a3': { label: 'A3' },
        'map-a5': { label: 'A5' },
        'map-a6': { label: 'A6' },
        'map-a7': { label: 'A7' },
    }),
};

test('aisle owners follow Zone_Mapping not flat Zone 2', () => {
    assert.equal(ownerForKillZone('A1', storeSettings), 'LUKE');
    assert.equal(ownerForKillZone('A3', storeSettings), 'ASHLEY');
    assert.equal(ownerForKillZone('A7', storeSettings), 'CHANDLER');
});

test('direct zone owner override still wins', () => {
    const settings = {
        ...storeSettings,
        Zone_Ownership: JSON.stringify({ ...JSON.parse(storeSettings.Zone_Ownership), A5: 'Tom' }),
    };
    assert.equal(ownerForKillZone('A5', settings), 'Tom');
});

test('buildKillZoneMapFromSettings maps aisles to correct zones', () => {
    const map = buildKillZoneMapFromSettings(storeSettings);
    assert.equal(map.A1, 'Zone 1');
    assert.equal(map.A5, 'Zone 2');
    assert.equal(map.A7, 'Zone 3');
});
