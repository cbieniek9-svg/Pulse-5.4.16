'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActionHandlers } = require('../src/actions/handlers.cjs');

test('generic_update throws 404 when row missing', () => {
    const handlers = createActionHandlers({
        db: {
            run: () => ({ changes: 0 }),
            get: () => undefined,
        },
        broadcastUpdate: () => { throw new Error('should not broadcast'); },
        getStoreDateStamp: () => '2026-06-08',
    });

    assert.throws(
        () => handlers.generic_update({
            table: 'tasks',
            workingData: { status: 'Closed' },
            id_col: 'task_id',
            id_val: 'MISSING',
        }),
        (err) => err.status === 404 && /not found/i.test(err.message),
    );
});

test('generic_update broadcasts when row exists but values unchanged', () => {
    const broadcasts = [];
    const handlers = createActionHandlers({
        db: {
            run: () => ({ changes: 0 }),
            get: () => ({ ok: 1 }),
        },
        broadcastUpdate: (payload) => broadcasts.push(payload),
        getStoreDateStamp: () => '2026-06-08',
    });

    handlers.generic_update({
        table: 'tasks',
        workingData: { status: 'Open' },
        id_col: 'task_id',
        id_val: 'T-1',
    });

    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].id_val, 'T-1');
});

test('generic_delete throws 404 when row missing', () => {
    const handlers = createActionHandlers({
        db: {
            run: () => ({ changes: 0 }),
        },
        broadcastUpdate: () => { throw new Error('should not broadcast'); },
        getStoreDateStamp: () => '2026-06-08',
    });

    assert.throws(
        () => handlers.generic_delete({
            table: 'tasks',
            id_col: 'task_id',
            id_val: 'MISSING',
        }),
        (err) => err.status === 404,
    );
});
