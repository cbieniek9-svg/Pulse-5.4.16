'use strict';

const fs = require('fs');
const path = require('path');

function listMigrationFiles() {
    const dir = __dirname;
    return fs.readdirSync(dir)
        .filter((f) => /^\d{3}_.+\.cjs$/.test(f))
        .sort();
}

function ensureSchemaVersionTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL,
            name TEXT NOT NULL
        );
    `);
}

function getAppliedMigrationVersions(db) {
    ensureSchemaVersionTable(db);
    return new Set(
        db.all('SELECT version FROM schema_version ORDER BY version').map((r) => Number(r.version)),
    );
}

function getPendingMigrations(db) {
    const applied = getAppliedMigrationVersions(db);
    return listMigrationFiles()
        .map((file) => ({ file, version: parseInt(file.slice(0, 3), 10) }))
        .filter((m) => !applied.has(m.version));
}

/**
 * Run numbered migrations once per database.
 * @param {object} db — app db wrapper (exec, get, run)
 */
function runMigrations(db, opts = {}) {
    ensureSchemaVersionTable(db);

    let pending = getPendingMigrations(db);
    if (pending.length && typeof opts.beforeApply === 'function') {
        opts.beforeApply(pending);
        pending = getPendingMigrations(db);
    }

    const applied = getAppliedMigrationVersions(db);

    for (const { file, version } of pending) {
        if (applied.has(version)) continue;

        const mod = require(path.join(__dirname, file));
        const name = mod.name || file.replace(/\.cjs$/, '');
        if (typeof mod.up !== 'function') {
            throw new Error(`Migration ${file} must export up(db)`);
        }

        const run = () => {
            mod.up(db);
            db.run(
                'INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)',
                version,
                new Date().toISOString(),
                name,
            );
        };

        if (db.transaction) db.transaction(run)();
        else run();

        applied.add(version);
        console.log(`[MIGRATION] applied ${version} ${name}`);
    }
}

module.exports = {
    runMigrations,
    listMigrationFiles,
    ensureSchemaVersionTable,
    getAppliedMigrationVersions,
    getPendingMigrations,
};
