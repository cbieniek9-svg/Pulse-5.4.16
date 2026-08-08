'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

function loadZoneColors() {
    const file = path.join(__dirname, '..', 'public', 'js', 'zone-map-colors.js');
    const code = require('node:fs').readFileSync(file, 'utf8');
    const sandbox = { globalThis: {} };
    sandbox.window = sandbox.globalThis;
    vm.runInNewContext(code, sandbox, { filename: file });
    return sandbox.globalThis.TgpZoneColors;
}

const ZC = loadZoneColors();

test('assigned zone wins over legacy section default hues', () => {
    assert.equal(ZC.colorForSection('map-a1', 'Zone 3'), '#0cf');
    assert.equal(ZC.colorForSection('map-rfz', 'Zone 1'), '#f90');
    assert.equal(ZC.colorForSection('Pop', 'Zone 1'), '#f90');
    assert.equal(ZC.colorForSection('Pop', undefined), '#0f8');
});

test('sectionColorZoneMap links TV Pop to A1 zone, not RFZ', () => {
    const settings = {
        Zone_Mapping: JSON.stringify({
            'Zone 1': ['map-a1'],
            'Zone 2': ['map-rfz'],
            'Zone 3': ['map-a7'],
        }),
    };
    const map = ZC.sectionColorZoneMap(settings);
    assert.equal(map.A1, 'Zone 1');
    assert.equal(map.Pop, 'Zone 1');
    assert.equal(map['map-rfz'], 'Zone 2');
    assert.notEqual(map.Pop, map['map-rfz']);
});

test('sectionColorZoneMap links TV Food Srvc to FS FRZ / Freezer zone', () => {
    const settings = {
        Zone_Mapping: JSON.stringify({
            'Zone 2': ['map-fsfrz'],
            'Zone 3': ['map-a7'],
        }),
    };
    const map = ZC.sectionColorZoneMap(settings);
    assert.equal(map.Freezer, 'Zone 2');
    assert.equal(map['Food Srvc'], 'Zone 2');
    assert.equal(ZC.colorForSection('Food Srvc', map['Food Srvc']), '#0f8');
});

test('rgbaHex builds valid SVG fill alpha', () => {
    assert.equal(ZC.rgbaHex('#0cf', 0.16), 'rgba(0,204,255,0.16)');
    assert.equal(ZC.rgbaHex('#f90', 0.16), 'rgba(255,153,0,0.16)');
});
