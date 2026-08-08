'use strict';

require('../public/js/zone-map-colors.js');

const test = require('node:test');
const assert = require('node:assert/strict');
const ZC = globalThis.TgpZoneColors;

test('General zone tasks stay off the floor map', () => {
    const tasks = [{ zone: 'General', task_detail: 'FIFO Audit', priority: 'Routine' }];
    assert.equal(ZC.tasksForSection('A1', tasks).length, 0);
    assert.equal(ZC.tasksForSection('Bakery', tasks).length, 0);
    assert.equal(ZC.mapSectionPriorityClass('A1', tasks), '');
});

test('zone-specific tasks still light their map sections', () => {
    const tasks = [
        { zone: 'General', task_detail: 'FIFO Audit', priority: 'Routine' },
        { zone: 'A1', task_detail: 'Face A1', priority: 'Routine' },
    ];
    assert.equal(ZC.tasksForSection('A1', tasks).length, 1);
    assert.equal(ZC.tasksForSection('Bakery', tasks).length, 0);
    assert.ok(ZC.mapSectionPriorityClass('A1', tasks));
});

test('FIFO expanded tasks use aisle zone not macro Zone 2', () => {
    const tasks = [
        { zone: 'A1', task_detail: 'FIFO Audit — A1', priority: 'Routine' },
        { zone: 'General', task_detail: 'Store walk', priority: 'Routine' },
    ];
    assert.equal(ZC.tasksForSection('A1', tasks).length, 1);
    assert.equal(ZC.tasksForSection('A2', tasks).length, 0);
    assert.equal(ZC.tasksForSection('A3', tasks).length, 0);
    assert.equal(ZC.mapSectionPriorityClass('A2', tasks), '');
});

test('A5 outline segments are tagged for tri-color pulse styling', () => {
    const svg = ZC.a5SegmentedOutlineSvg(0, 0, 100, 100, 2, ZC.A5_SECTION_COLORS);
    assert.match(svg, /a5-seg-orange/);
    assert.match(svg, /a5-seg-blue/);
    assert.match(svg, /a5-seg-green/);
    const fill = ZC.a5SegmentedFillSvg(0, 0, 100, 100, ZC.A5_SECTION_COLORS, { alpha: 0.16 });
    assert.match(fill, /a5-fill-orange/);
    assert.match(fill, /a5-fill-blue/);
    assert.match(fill, /a5-fill-green/);
    assert.equal(ZC.mapSectionPriorityClass('A5', [{ zone: 'A5', task_detail: 'Face coffee', priority: 'Routine' }]), 'map-priority-active');
});
