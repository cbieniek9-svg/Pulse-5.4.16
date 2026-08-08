'use strict';

/**
 * Thin smoke for client syncReducer force-full-sync rules.
 * Loaded via dynamic import (ESM source under client/).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

async function loadReducer() {
    const file = path.join(__dirname, '..', 'client', 'src', 'lib', 'syncReducer.js');
    return import(pathToFileURL(file).href);
}

test('applyDelta forces full sync for daily_direction and rhythm heal', async () => {
    const { applyDelta } = await loadReducer();
    const state = { tasks: [], staff: [{ name: 'A' }] };

    const dd = applyDelta(state, { table: 'daily_direction', action: 'posted' });
    assert.equal(dd.needsSync, true);
    assert.equal(dd.urgent, true);

    const su = applyDelta(state, { table: 'shift_updates', action: 'posted' });
    assert.equal(su.needsSync, true);

    const heal = applyDelta(state, { table: 'tasks', action: 'rhythm_heal' });
    assert.equal(heal.needsSync, true);
    assert.equal(heal.urgent, true);
});

test('applyDelta still patches normal task deltas without forcing sync', async () => {
    const { applyDelta } = await loadReducer();
    const state = {
        tasks: [{ task_id: 'T1', status: 'Open' }],
        staff: [{ name: 'A' }],
    };
    const res = applyDelta(state, {
        table: 'tasks',
        action: 'update',
        data: { status: 'Closed' },
        id_col: 'task_id',
        id_val: 'T1',
    });
    assert.equal(res.needsSync, false);
    // Closed tasks are removed from the live board list.
    assert.equal((res.state.tasks || []).some((t) => t.task_id === 'T1'), false);
});
