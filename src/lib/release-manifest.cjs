'use strict';

const fs = require('fs');
const path = require('path');
const { APP_VERSION } = require('../app-version.cjs');
const { listMigrationFiles } = require('../migrations/runner.cjs');

const appRoot = path.resolve(__dirname, '..', '..');
const manifestPath = path.join(appRoot, 'release-manifest.json');

function latestMigrationVersion() {
    const files = listMigrationFiles();
    if (!files.length) return 0;
    return Math.max(...files.map((f) => parseInt(f.slice(0, 3), 10)).filter(Number.isFinite));
}

function readStaticReleaseManifest() {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
        return null;
    }
}

function getDbSchemaVersion(db) {
    if (!db || typeof db.get !== 'function') return null;
    try {
        const row = db.get('SELECT MAX(version) AS version FROM schema_version');
        return row?.version == null ? null : Number(row.version);
    } catch (_) {
        return null;
    }
}

function buildReleaseManifest(opts = {}) {
    const staticManifest = readStaticReleaseManifest() || {};
    const latestMigration = latestMigrationVersion();
    const dbSchemaVersion = getDbSchemaVersion(opts.db);

    return {
        appVersion: APP_VERSION,
        buildDate: staticManifest.buildDate || null,
        releaseTrack: staticManifest.releaseTrack || 'single-store-poc',
        latestMigration,
        databaseUserVersion: staticManifest.databaseUserVersion ?? latestMigration,
        databaseSchemaVersion: dbSchemaVersion,
        migrationsCurrent: dbSchemaVersion == null ? null : dbSchemaVersion >= latestMigration,
        patches: Array.isArray(staticManifest.patches) ? staticManifest.patches : [],
        verificationScripts: Array.isArray(staticManifest.verificationScripts) ? staticManifest.verificationScripts : [],
        manifestPath,
    };
}

module.exports = {
    buildReleaseManifest,
    readStaticReleaseManifest,
    latestMigrationVersion,
};
