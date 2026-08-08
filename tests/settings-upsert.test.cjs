'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActionHandlers } = require('../src/actions/handlers.cjs');
const { upsertSetting } = require('../src/lib/settings-store.cjs');

function makeSettingsDb(initial = {}) {
    const settings = new Map(Object.entries(initial));
    return {
        settings,
        db: {
            getSettings: () => Object.fromEntries(settings),
            get: (sql, name) => (settings.has(name) ? { setting_value: settings.get(name) } : undefined),
            all: (sql) => {
                if (sql.includes('FROM settings')) {
                    return [...settings.entries()].map(([setting_name, setting_value]) => ({ setting_name, setting_value }));
                }
                return [];
            },
            run: (sql, ...params) => {
                if (sql.includes('ON CONFLICT(setting_name)')) {
                    settings.set(params[0], params[1]);
                }
            },
        },
    };
}

test('upsertSetting inserts missing Betacs_Enabled row', () => {
    const { db, settings } = makeSettingsDb();
    upsertSetting(db, 'Betacs_Enabled', '1');
    assert.equal(settings.get('Betacs_Enabled'), '1');
});

test('settings_update upserts Betacs_Enabled when row was missing', () => {
    const { db, settings } = makeSettingsDb();
    const broadcasts = [];
    const handlers = createActionHandlers({
        db,
        broadcastUpdate: (payload) => broadcasts.push(payload),
        getStoreDateStamp: () => '2026-06-08',
    });

    handlers.settings_update({
        table: 'settings',
        workingData: { setting_value: '1' },
        id_col: 'setting_name',
        id_val: 'Betacs_Enabled',
        actorName: 'Manager',
        serverTime: '2026-06-08T12:00:00.000Z',
    });

    assert.equal(settings.get('Betacs_Enabled'), '1');
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].id_val, 'Betacs_Enabled');
});

test('settings_update overwrites existing Betacs_Enabled', () => {
    const { db, settings } = makeSettingsDb({ Betacs_Enabled: '0' });
    const handlers = createActionHandlers({
        db,
        broadcastUpdate: () => {},
        getStoreDateStamp: () => '2026-06-08',
    });

    handlers.settings_update({
        table: 'settings',
        workingData: { setting_value: '1' },
        id_col: 'setting_name',
        id_val: 'Betacs_Enabled',
        actorName: 'Manager',
        serverTime: '2026-06-08T12:00:00.000Z',
    });

    assert.equal(settings.get('Betacs_Enabled'), '1');
});
