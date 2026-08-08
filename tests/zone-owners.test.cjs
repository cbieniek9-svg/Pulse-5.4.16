const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appRoot = path.join(__dirname, '..');

function loadClientKillZoneMap() {
    const src = fs.readFileSync(path.join(appRoot, 'public/js/zone-owners.js'), 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(src, sandbox);
    return sandbox.window.TgpZoneOwners.KILL_ZONE_TO_MAP;
}

test('client zone-owners map matches server zone-owners.cjs', () => {
    const server = require('../src/lib/zone-owners.cjs').KILL_ZONE_TO_MAP;
    const client = loadClientKillZoneMap();
    assert.equal(JSON.stringify(client), JSON.stringify(server));
});

test('ownerForKillZone resolves aisle to map zone owner', () => {
    const { ownerForKillZone } = require('../src/lib/zone-owners.cjs');
    const settings = {
        Zone_Mapping: JSON.stringify({ 'Zone 2': ['map-a5', 'map-a6'] }),
        Zone_Ownership: JSON.stringify({ 'Zone 2': 'Ashley', A5: 'Tom' }),
        Zone_Section_Labels: JSON.stringify({ 'map-a5': { label: 'A5' }, 'map-a6': { label: 'A6' } }),
    };
    assert.equal(ownerForKillZone('A5', settings), 'Tom');
    assert.equal(ownerForKillZone('A6', settings), 'Ashley');
    assert.equal(ownerForKillZone('General', settings), '');
});
