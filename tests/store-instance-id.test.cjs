'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { ensureStoreInstanceId, UUID_RE } = require('../src/lib/store-instance-id.cjs');
const { getStoreMeta, STORE_INSTANCE_ID_KEY } = require('../src/constants/store-meta.cjs');

function wrapDb(raw) {
    return {
        exec: (sql) => raw.exec(sql),
        run: (...args) => raw.prepare(args[0]).run(...args.slice(1)),
        get: (...args) => raw.prepare(args[0]).get(...args.slice(1)),
        all: (...args) => raw.prepare(args[0]).all(...args.slice(1)),
        transaction: (fn) => raw.transaction(fn),
    };
}

test('ensureStoreInstanceId mints once and is idempotent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-instance-'));
    const raw = new Database(path.join(dir, 't.db'));
    raw.exec(`CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT)`);
    const db = wrapDb(raw);

    const first = ensureStoreInstanceId(db);
    assert.equal(first.created, true);
    assert.match(first.instanceId, UUID_RE);

    const second = ensureStoreInstanceId(db);
    assert.equal(second.created, false);
    assert.equal(second.instanceId, first.instanceId);

    const meta = getStoreMeta({ [STORE_INSTANCE_ID_KEY]: first.instanceId });
    assert.equal(meta.instanceId, first.instanceId);
    raw.close();
});

test('migration 029 up() mints Store_Instance_Id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-mig029-'));
    const raw = new Database(path.join(dir, 't.db'));
    raw.exec(`CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT)`);
    const db = wrapDb(raw);

    const mig = require('../src/migrations/029_store_instance_id.cjs');
    mig.up(db);
    const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', STORE_INSTANCE_ID_KEY);
    assert.ok(row?.setting_value);
    assert.match(String(row.setting_value), UUID_RE);

    const before = row.setting_value;
    mig.up(db);
    const after = db.get('SELECT setting_value FROM settings WHERE setting_name=?', STORE_INSTANCE_ID_KEY);
    assert.equal(after.setting_value, before);
    raw.close();
});
