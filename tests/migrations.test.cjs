'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runMigrations, listMigrationFiles } = require('../src/migrations/runner.cjs');

test('applies numbered migrations once', () => {
    const versions = [];
    const execLog = [];
    const db = {
        exec(sql) { execLog.push(sql); },
        get(sql, ...p) {
            if (sql.includes('sqlite_master')) return { ok: 1 };
            return null;
        },
        all(sql) {
            if (sql.includes('schema_version')) return versions.map((version) => ({ version }));
            if (sql.includes('PRAGMA table_info')) return [{ name: 'staff_roster' }];
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO schema_version')) versions.push(params[0]);
            if (sql.includes('INSERT OR IGNORE INTO settings')) { /* presence flag */ }
            return { changes: 0 };
        },
        transaction(fn) { return () => fn(); },
    };
    // Derived from the directory, so adding a migration never breaks this test —
    // it only breaks if a migration is skipped, duplicated, or numbered out of order.
    const expected = listMigrationFiles().map((f) => parseInt(f.slice(0, 3), 10));

    runMigrations(db);
    assert.deepEqual(versions, expected, 'every migration file applies once, in order');

    runMigrations(db);
    assert.deepEqual(versions, expected, 'a second run is a no-op');
});

test('migration files are numbered uniquely and contiguously', () => {
    const numbers = listMigrationFiles().map((f) => parseInt(f.slice(0, 3), 10));
    assert.equal(new Set(numbers).size, numbers.length, 'two migrations share a number');
    numbers.forEach((n, i) => {
        assert.equal(n, i + 1, `migration ${n} leaves a gap — runner applies by file order`);
    });
});
